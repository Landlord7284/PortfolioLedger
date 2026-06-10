"""
Fiscal tax calculation service for USD assets.
"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta
from decimal import Decimal
from typing import Any, Optional

from backend.domain.engine import to_decimal
from backend.domain.enums import EventType
from backend.domain.normalization import normalize_bool_01
from backend.services.fiscal_regime_service import (
    has_tax_parameter,
    require_supported_capital_gain_regime,
    require_supported_fiscal_parameter_regime,
)
from backend.services import ptax_service


PRE_2024_CUTOFF = "2024-01-01"
ZERO = Decimal("0")


def _d(value: Any) -> Decimal:
    return to_decimal(value)


def _row_dict(row: sqlite3.Row | dict) -> dict:
    return dict(row)


def _tax_rows_for_sale(conn: sqlite3.Connection, sale_event_id: int) -> list[dict]:
    rows = conn.execute(
        """
        SELECT * FROM tax_event
        WHERE tax_event_type = 'SALE' AND sale_event_id = ?
        ORDER BY id
        """,
        (sale_event_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def _insert_tax_event(conn: sqlite3.Connection, values: dict[str, Any]) -> dict:
    cur = conn.execute(
        """
        INSERT INTO tax_event (
            tax_event_type, portfolio_id, asset_id, sale_event_id, lot_id,
            qty_sold, ganho_brl, regime, ptax_used, income_type,
            credit_date, amount_usd, amount_brl
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            values.get("tax_event_type", "SALE"),
            values.get("portfolio_id"),
            values.get("asset_id"),
            values.get("sale_event_id"),
            values.get("lot_id"),
            values.get("qty_sold"),
            values.get("ganho_brl"),
            values["regime"],
            values["ptax_used"],
            values.get("income_type"),
            values.get("credit_date"),
            values.get("amount_usd"),
            values.get("amount_brl"),
        ),
    )
    row = conn.execute(
        "SELECT * FROM tax_event WHERE id = ?",
        (cur.lastrowid,),
    ).fetchone()
    return dict(row)


def calcular_ganho_pre_2024(
    conn: sqlite3.Connection,
    lot: sqlite3.Row | dict,
    qty_sold: Decimal,
    price_sold_usd: Decimal,
    sale_date: str,
) -> dict[str, Decimal | str]:
    """
    Calculate capital gain for a PRE_2024 fiscal lot under IN SRF 118/2000.
    """
    lot_data = _row_dict(lot)
    ptax_compra_sale = ptax_service.get_ptax(sale_date, conn=conn)["compra"]
    ratio = qty_sold / _d(lot_data["quantity"])

    ganho_brl_origem = ZERO
    if _d(lot_data["origin_brl_usd"]) != ZERO:
        alienacao_brl = price_sold_usd * qty_sold * ptax_compra_sale
        custo_brl = _d(lot_data["cost_brl_portion_brl"]) * ratio
        ganho_brl_origem = alienacao_brl - custo_brl

    ganho_usd_origem = ZERO
    if _d(lot_data["origin_usd"]) != ZERO:
        alienacao_usd = price_sold_usd * qty_sold
        custo_usd = _d(lot_data["cost_usd_portion_usd"]) * ratio
        ganho_usd_origem = (alienacao_usd - custo_usd) * ptax_compra_sale

    return {
        "ganho_brl_origem": ganho_brl_origem,
        "ganho_usd_origem": ganho_usd_origem,
        "total_tributavel": ganho_brl_origem + ganho_usd_origem,
        "ptax_compra_sale": ptax_compra_sale,
        "regime": "PRE_2024",
    }


def calcular_ganho_post_2024(
    conn: sqlite3.Connection,
    lot: sqlite3.Row | dict,
    qty_sold: Decimal,
    price_sold_usd: Decimal,
    sale_date: str,
) -> dict[str, Decimal | str]:
    """
    Calculate capital gain for a POST_2024 fiscal lot under IN RFB 2.180/2024.
    """
    lot_data = _row_dict(lot)
    ptax_venda_sale = ptax_service.get_ptax(sale_date, conn=conn)["venda"]
    custo_total_por_unidade_brl = (
        _d(lot_data["cost_brl_portion_brl"])
        + _d(lot_data["cost_usd_portion_usd"]) * _d(lot_data["ptax_venda_acq"])
    ) / _d(lot_data["quantity"])
    custo_proporcional_brl = custo_total_por_unidade_brl * qty_sold
    alienacao_brl = price_sold_usd * qty_sold * ptax_venda_sale

    return {
        "ganho_total_brl": alienacao_brl - custo_proporcional_brl,
        "ptax_venda_sale": ptax_venda_sale,
        "regime": "POST_2024",
    }


def calcular_ganho_lote(
    conn: sqlite3.Connection,
    lot: sqlite3.Row | dict,
    qty_sold: Decimal,
    price_sold_usd: Decimal,
    sale_date: str,
) -> dict[str, Decimal | str]:
    lot_data = _row_dict(lot)
    if lot_data["regime"] == "PRE_2024":
        return calcular_ganho_pre_2024(conn, lot_data, qty_sold, price_sold_usd, sale_date)
    if lot_data["regime"] == "POST_2024":
        return calcular_ganho_post_2024(conn, lot_data, qty_sold, price_sold_usd, sale_date)
    raise ValueError(f"Regime fiscal desconhecido: {lot_data['regime']}")


def _sale_unit_price_usd(sale_event: sqlite3.Row | dict) -> Decimal:
    sale = _row_dict(sale_event)
    quantity = _d(sale["quantity"])
    if quantity <= ZERO:
        raise ValueError("Quantidade da venda deve ser positiva.")
    sale_total = _d(sale["gross_value"] or sale["event_value"])
    return sale_total / quantity


def _available_lots(
    conn: sqlite3.Connection,
    portfolio_id: int,
    asset_id: int,
) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT * FROM fiscal_lots
        WHERE portfolio_id = ?
          AND asset_id = ?
          AND CAST(quantity_remaining AS REAL) > 0
        ORDER BY date ASC, event_id ASC, id ASC
        """,
        (portfolio_id, asset_id),
    ).fetchall()


def apurar_ganhos_evento_venda(
    conn: sqlite3.Connection,
    sale_event: sqlite3.Row | dict,
) -> dict:
    """
    Consume fiscal lots FIFO for a sale event and persist one tax row per lot.
    """
    sale = _row_dict(sale_event)
    if sale["event_type"] != EventType.VENDA.value:
        raise ValueError("Apuracao fiscal de ganho exige evento de Venda.")
    if sale.get("is_cancelled") or sale.get("is_storno"):
        raise ValueError("Evento cancelado ou estorno nao pode ser apurado.")

    existing = _tax_rows_for_sale(conn, sale["id"])
    if existing:
        return _sale_result(sale["id"], existing)

    qty_remaining_to_sell = _d(sale["quantity"])
    price_sold_usd = _sale_unit_price_usd(sale)
    inserted: list[dict] = []
    lots = _available_lots(conn, sale["portfolio_id"], sale["asset_id"])
    available_qty = sum((_d(lot["quantity_remaining"]) for lot in lots), ZERO)
    if available_qty < qty_remaining_to_sell:
        raise ValueError(
            f"Lotes fiscais insuficientes para apurar venda. Saldo faltante: {qty_remaining_to_sell - available_qty}."
        )

    for lot in lots:
        if qty_remaining_to_sell <= ZERO:
            break

        lot_remaining = _d(lot["quantity_remaining"])
        qty_from_lot = min(qty_remaining_to_sell, lot_remaining)
        calc = calcular_ganho_lote(
            conn,
            lot,
            qty_from_lot,
            price_sold_usd,
            sale["event_date"],
        )

        if calc["regime"] == "PRE_2024":
            ganho_brl = calc["total_tributavel"]
            ptax_used = calc["ptax_compra_sale"]
        else:
            ganho_brl = calc["ganho_total_brl"]
            ptax_used = calc["ptax_venda_sale"]

        row = _insert_tax_event(
            conn,
            {
                "tax_event_type": "SALE",
                "portfolio_id": sale["portfolio_id"],
                "asset_id": sale["asset_id"],
                "sale_event_id": sale["id"],
                "lot_id": lot["id"],
                "qty_sold": str(qty_from_lot),
                "ganho_brl": str(ganho_brl),
                "regime": calc["regime"],
                "ptax_used": str(ptax_used),
            },
        )
        inserted.append(row)

        new_remaining = lot_remaining - qty_from_lot
        conn.execute(
            "UPDATE fiscal_lots SET quantity_remaining = ? WHERE id = ?",
            (str(new_remaining), lot["id"]),
        )
        qty_remaining_to_sell -= qty_from_lot

    return _sale_result(sale["id"], inserted)


def apurar_rendimento(
    conn: sqlite3.Connection,
    portfolio_id: int,
    asset_id: int,
    amount_usd: str | Decimal,
    credit_date: str,
    income_type: Optional[str] = None,
) -> dict:
    amount = _d(amount_usd)
    if amount <= ZERO:
        raise ValueError("Valor do rendimento em USD deve ser positivo.")
    if not conn.execute("SELECT 1 FROM portfolios WHERE id = ?", (portfolio_id,)).fetchone():
        raise ValueError(f"Carteira {portfolio_id} nao encontrada.")
    if not conn.execute("SELECT 1 FROM assets WHERE id = ?", (asset_id,)).fetchone():
        raise ValueError(f"Ativo {asset_id} nao encontrado.")

    if credit_date < PRE_2024_CUTOFF:
        regime = "PRE_2024"
        taxa = ptax_service.get_ptax_primeira_quinzena_mes_anterior(credit_date, conn=conn)["compra"]
    else:
        regime = "POST_2024"
        taxa = ptax_service.get_ptax(credit_date, conn=conn)["venda"]

    amount_brl = amount * taxa
    return _insert_tax_event(
        conn,
        {
            "tax_event_type": "INCOME",
            "portfolio_id": portfolio_id,
            "asset_id": asset_id,
            "regime": regime,
            "ptax_used": str(taxa),
            "income_type": income_type,
            "credit_date": credit_date,
            "amount_usd": str(amount),
            "amount_brl": str(amount_brl),
        },
    )


def _sale_result(sale_event_id: int, rows: list[dict]) -> dict:
    total = sum((_d(row["ganho_brl"]) for row in rows), ZERO)
    return {
        "sale_event_id": sale_event_id,
        "total_ganho_brl": str(total),
        "events": rows,
    }


def apurar_ganhos_por_evento_id(conn: sqlite3.Connection, event_id: int) -> dict:
    sale_event = conn.execute(
        "SELECT * FROM events WHERE id = ?",
        (event_id,),
    ).fetchone()
    if not sale_event:
        raise ValueError(f"Evento {event_id} nao encontrado.")
    return apurar_ganhos_evento_venda(conn, sale_event)


def list_tax_events(
    conn: sqlite3.Connection,
    portfolio_id: Optional[int] = None,
    asset_id: Optional[int] = None,
    year: Optional[int] = None,
    tax_event_type: Optional[str] = None,
) -> list[dict]:
    conditions = []
    params: list[Any] = []
    if portfolio_id is not None:
        conditions.append("te.portfolio_id = ?")
        params.append(portfolio_id)
    if asset_id is not None:
        conditions.append("te.asset_id = ?")
        params.append(asset_id)
    if tax_event_type is not None:
        conditions.append("te.tax_event_type = ?")
        params.append(tax_event_type)
    if year is not None:
        conditions.append("substr(COALESCE(te.credit_date, e.event_date), 1, 4) = ?")
        params.append(str(year))

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    rows = conn.execute(
        f"""
        SELECT te.*
        FROM tax_event te
        LEFT JOIN events e ON e.id = te.sale_event_id
        {where}
        ORDER BY COALESCE(te.credit_date, e.event_date), te.id
        """,
        params,
    ).fetchall()
    return [dict(row) for row in rows]


def annual_summary(
    conn: sqlite3.Connection,
    portfolio_id: Optional[int] = None,
    year: Optional[int] = None,
) -> list[dict]:
    rows = list_tax_events(conn, portfolio_id=portfolio_id, year=year)
    grouped: dict[tuple[int | None, str, str, str | None], dict[str, Any]] = {}
    for row in rows:
        event_date = row["credit_date"]
        if event_date is None and row["sale_event_id"] is not None:
            sale = conn.execute(
                "SELECT event_date FROM events WHERE id = ?",
                (row["sale_event_id"],),
            ).fetchone()
            event_date = sale["event_date"] if sale else None

        row_year = int(event_date[:4]) if event_date else None
        key = (row_year, row["tax_event_type"], row["regime"], row["income_type"])
        if key not in grouped:
            grouped[key] = {
                "year": row_year,
                "tax_event_type": row["tax_event_type"],
                "regime": row["regime"],
                "income_type": row["income_type"],
                "total_ganho_brl": ZERO,
                "total_amount_brl": ZERO,
                "event_count": 0,
            }

        grouped[key]["total_ganho_brl"] += _d(row["ganho_brl"] or "0")
        grouped[key]["total_amount_brl"] += _d(row["amount_brl"] or "0")
        grouped[key]["event_count"] += 1

    return [
        {
            **value,
            "total_ganho_brl": str(value["total_ganho_brl"]),
            "total_amount_brl": str(value["total_amount_brl"]),
        }
        for _, value in sorted(
            grouped.items(),
            key=lambda item: (
                item[0][0] if item[0][0] is not None else -1,
                item[0][1],
                item[0][2],
                item[0][3] or "",
            ),
        )
    ]


def _validate_year_month(year_month: str) -> None:
    if len(year_month) != 7 or year_month[4] != "-":
        raise ValueError("Mes deve estar no formato YYYY-MM.")
    year, month = year_month.split("-")
    if not (year.isdigit() and month.isdigit() and 1 <= int(month) <= 12):
        raise ValueError("Mes deve estar no formato YYYY-MM.")


def _validate_iso_date(value: str, field_name: str) -> str:
    try:
        date.fromisoformat(value)
    except ValueError:
        raise ValueError(f"{field_name} deve estar no formato YYYY-MM-DD.")
    return value


def _nullable_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _decimal_text(value: Any, field_name: str) -> str:
    try:
        parsed = _d(value)
    except Exception:
        raise ValueError(f"{field_name} deve ser numerico.")
    if parsed < ZERO:
        raise ValueError(f"{field_name} nao pode ser negativo.")
    return str(parsed)


def _signed_decimal_text(value: Any, field_name: str) -> str:
    try:
        parsed = _d(value)
    except Exception:
        raise ValueError(f"{field_name} deve ser numerico.")
    return str(parsed)


def _nullable_decimal_text(value: Any, field_name: str) -> str | None:
    if value in (None, ""):
        return None
    return _decimal_text(value, field_name)


def _tax_parameter_row(conn: sqlite3.Connection, parameter_id: int) -> dict:
    row = conn.execute(
        "SELECT * FROM fiscal_tax_parameters WHERE id = ?",
        (parameter_id,),
    ).fetchone()
    if not row:
        raise ValueError("Parametro fiscal nao encontrado.")
    return dict(row)


def _validate_tax_parameter_payload(values: dict[str, Any]) -> dict[str, Any]:
    regime = _nullable_text(values.get("regime"))
    if not regime:
        raise ValueError("Regime fiscal e obrigatorio.")
    require_supported_fiscal_parameter_regime(regime)

    valid_from = _validate_iso_date(values.get("valid_from") or "", "Vigencia inicial")
    valid_until = _nullable_text(values.get("valid_until"))
    if valid_until is not None:
        valid_until = _validate_iso_date(valid_until, "Vigencia final")
        if valid_until < valid_from:
            raise ValueError("Vigencia final deve ser maior ou igual a vigencia inicial.")

    normalized = {
        "regime": regime,
        "valid_from": valid_from,
        "valid_until": valid_until,
        "tax_rate": _decimal_text(values.get("tax_rate", "0"), "Aliquota"),
        "withholding_rate": _decimal_text(values.get("withholding_rate", "0"), "IRRF"),
        "exemption_limit": _nullable_decimal_text(values.get("exemption_limit"), "Limite de isencao"),
        "darf_code": _nullable_text(values.get("darf_code")),
        "minimum_darf_amount": _decimal_text(values.get("minimum_darf_amount", "10.00"), "DARF minima"),
        "loss_bucket": _nullable_text(values.get("loss_bucket")),
        "active": normalize_bool_01(values.get("active", True)),
        "monthly_darf_enabled": normalize_bool_01(values.get("monthly_darf_enabled", True)),
    }
    if _d(normalized["minimum_darf_amount"]) < ZERO:
        raise ValueError("DARF minima nao pode ser negativa.")
    return normalized


def _assert_no_active_overlap(
    conn: sqlite3.Connection,
    *,
    regime: str,
    valid_from: str,
    valid_until: str | None,
    exclude_id: int | None = None,
) -> None:
    params: list[Any] = [regime, valid_until or "9999-12-31", valid_from]
    exclude_clause = ""
    if exclude_id is not None:
        exclude_clause = "AND id <> ?"
        params.append(exclude_id)
    row = conn.execute(
        f"""
        SELECT id
        FROM fiscal_tax_parameters
        WHERE regime = ?
          AND active = 1
          AND valid_from <= ?
          AND COALESCE(valid_until, '9999-12-31') >= ?
          {exclude_clause}
        LIMIT 1
        """,
        params,
    ).fetchone()
    if row:
        raise ValueError("Ja existe parametro fiscal ativo sobreposto para este regime.")


def list_tax_parameters(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        """
        SELECT *
        FROM fiscal_tax_parameters
        ORDER BY regime, active DESC, valid_from DESC, id DESC
        """
    ).fetchall()
    return [dict(row) for row in rows]


def create_tax_parameter(conn: sqlite3.Connection, values: dict[str, Any]) -> dict:
    normalized = _validate_tax_parameter_payload(values)
    if normalized["active"]:
        _assert_no_active_overlap(conn, **{
            "regime": normalized["regime"],
            "valid_from": normalized["valid_from"],
            "valid_until": normalized["valid_until"],
        })
    cur = conn.execute(
        """
        INSERT INTO fiscal_tax_parameters (
            regime, valid_from, valid_until, tax_rate, withholding_rate,
            exemption_limit, darf_code, minimum_darf_amount, loss_bucket, active, monthly_darf_enabled
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            normalized["regime"],
            normalized["valid_from"],
            normalized["valid_until"],
            normalized["tax_rate"],
            normalized["withholding_rate"],
            normalized["exemption_limit"],
            normalized["darf_code"],
            normalized["minimum_darf_amount"],
            normalized["loss_bucket"],
            normalized["active"],
            normalized["monthly_darf_enabled"],
        ),
    )
    return _tax_parameter_row(conn, cur.lastrowid)


def update_tax_parameter(conn: sqlite3.Connection, parameter_id: int, updates: dict[str, Any]) -> dict:
    current = _tax_parameter_row(conn, parameter_id)
    if not updates:
        return current
    merged = {**current, **updates}
    normalized = _validate_tax_parameter_payload(merged)
    if normalized["active"]:
        _assert_no_active_overlap(
            conn,
            regime=normalized["regime"],
            valid_from=normalized["valid_from"],
            valid_until=normalized["valid_until"],
            exclude_id=parameter_id,
        )
    conn.execute(
        """
        UPDATE fiscal_tax_parameters
        SET regime = ?,
            valid_from = ?,
            valid_until = ?,
            tax_rate = ?,
            withholding_rate = ?,
            exemption_limit = ?,
            darf_code = ?,
            minimum_darf_amount = ?,
            loss_bucket = ?,
            active = ?,
            monthly_darf_enabled = ?,
            updated_at = datetime('now')
        WHERE id = ?
        """,
        (
            normalized["regime"],
            normalized["valid_from"],
            normalized["valid_until"],
            normalized["tax_rate"],
            normalized["withholding_rate"],
            normalized["exemption_limit"],
            normalized["darf_code"],
            normalized["minimum_darf_amount"],
            normalized["loss_bucket"],
            normalized["active"],
            normalized["monthly_darf_enabled"],
            parameter_id,
        ),
    )
    return _tax_parameter_row(conn, parameter_id)


def create_tax_parameter_successor(conn: sqlite3.Connection, parameter_id: int, values: dict[str, Any]) -> dict:
    current = _tax_parameter_row(conn, parameter_id)
    today = date.today().isoformat()
    if not current["active"]:
        raise ValueError("Parametro base precisa estar ativo para criar nova vigencia.")
    if current["valid_from"] > today or (current["valid_until"] and current["valid_until"] < today):
        raise ValueError("Parametro base precisa ser a configuracao vigente.")

    new_valid_from = _validate_iso_date(values.get("valid_from") or "", "Vigencia inicial")
    if new_valid_from <= current["valid_from"]:
        raise ValueError("Nova vigencia deve iniciar depois da vigencia inicial atual.")
    if current["valid_until"] and new_valid_from > current["valid_until"]:
        raise ValueError("Nova vigencia deve iniciar dentro da vigencia atual.")

    previous_until = (date.fromisoformat(new_valid_from) - timedelta(days=1)).isoformat()
    successor_values = {
        "regime": current["regime"],
        "valid_from": new_valid_from,
        "valid_until": current["valid_until"],
        "tax_rate": values.get("tax_rate", current["tax_rate"]),
        "withholding_rate": values.get("withholding_rate", current["withholding_rate"]),
        "exemption_limit": values.get("exemption_limit", current["exemption_limit"]),
        "darf_code": values.get("darf_code", current["darf_code"]),
        "minimum_darf_amount": values.get("minimum_darf_amount", current["minimum_darf_amount"]),
        "loss_bucket": current["loss_bucket"],
        "active": True,
        "monthly_darf_enabled": values.get("monthly_darf_enabled", current["monthly_darf_enabled"]),
    }

    update_tax_parameter(conn, parameter_id, {"valid_until": previous_until})
    return create_tax_parameter(conn, successor_values)


def list_irrf_overrides(
    conn: sqlite3.Connection,
    portfolio_id: int,
    year: Optional[int] = None,
) -> list[dict]:
    params: list[Any] = [portfolio_id]
    where = "portfolio_id = ?"
    if year is not None:
        where += " AND year_month BETWEEN ? AND ?"
        params.extend([f"{year}-01", f"{year}-12"])
    rows = conn.execute(
        f"""
        SELECT *
        FROM fiscal_irrf_overrides
        WHERE {where}
        ORDER BY year_month, regime
        """,
        params,
    ).fetchall()
    return [dict(row) for row in rows]


def upsert_irrf_override(
    conn: sqlite3.Connection,
    *,
    portfolio_id: int,
    year_month: str,
    regime: str,
    effective_irrf: str | Decimal,
    notes: Optional[str] = None,
) -> dict:
    _validate_year_month(year_month)
    require_supported_capital_gain_regime(regime)
    if not conn.execute("SELECT 1 FROM portfolios WHERE id = ?", (portfolio_id,)).fetchone():
        raise ValueError(f"Carteira {portfolio_id} nao encontrada.")
    if not has_tax_parameter(conn, regime, f"{year_month}-01"):
        raise ValueError(f"Parametro fiscal nao encontrado para {regime} em {year_month}.")
    value = _d(effective_irrf)
    if value < ZERO:
        raise ValueError("IRRF efetivo nao pode ser negativo.")
    conn.execute(
        """
        INSERT INTO fiscal_irrf_overrides (
            portfolio_id, year_month, regime, effective_irrf, notes
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(portfolio_id, year_month, regime) DO UPDATE SET
            effective_irrf = excluded.effective_irrf,
            notes = excluded.notes,
            updated_at = datetime('now')
        """,
        (portfolio_id, year_month, regime, str(value), notes),
    )
    row = conn.execute(
        """
        SELECT *
        FROM fiscal_irrf_overrides
        WHERE portfolio_id = ? AND year_month = ? AND regime = ?
        """,
        (portfolio_id, year_month, regime),
    ).fetchone()
    return dict(row)


def delete_irrf_override(conn: sqlite3.Connection, override_id: int) -> bool:
    cur = conn.execute("DELETE FROM fiscal_irrf_overrides WHERE id = ?", (override_id,))
    return cur.rowcount > 0


def list_capital_gain_tax_paid_overrides(
    conn: sqlite3.Connection,
    portfolio_id: int,
    year: Optional[int] = None,
) -> list[dict]:
    params: list[Any] = [portfolio_id]
    where = "portfolio_id = ?"
    if year is not None:
        where += " AND year_month BETWEEN ? AND ?"
        params.extend([f"{year}-01", f"{year}-12"])
    rows = conn.execute(
        f"""
        SELECT *
        FROM fiscal_capital_gain_tax_overrides
        WHERE {where}
        ORDER BY year_month, regime
        """,
        params,
    ).fetchall()
    return [dict(row) for row in rows]


def upsert_capital_gain_tax_paid_override(
    conn: sqlite3.Connection,
    *,
    portfolio_id: int,
    year_month: str,
    regime: str,
    manual_tax_paid: str | Decimal,
) -> dict:
    _validate_year_month(year_month)
    require_supported_capital_gain_regime(regime)
    if not conn.execute("SELECT 1 FROM portfolios WHERE id = ?", (portfolio_id,)).fetchone():
        raise ValueError(f"Carteira {portfolio_id} nao encontrada.")
    if not has_tax_parameter(conn, regime, f"{year_month}-01"):
        raise ValueError(f"Parametro fiscal nao encontrado para {regime} em {year_month}.")
    value = _d(manual_tax_paid)
    if value < ZERO:
        raise ValueError("Imposto pago nao pode ser negativo.")
    conn.execute(
        """
        INSERT INTO fiscal_capital_gain_tax_overrides (
            portfolio_id, year_month, regime, manual_tax_paid
        )
        VALUES (?, ?, ?, ?)
        ON CONFLICT(portfolio_id, year_month, regime) DO UPDATE SET
            manual_tax_paid = excluded.manual_tax_paid,
            updated_at = datetime('now')
        """,
        (portfolio_id, year_month, regime, str(value)),
    )
    row = conn.execute(
        """
        SELECT *
        FROM fiscal_capital_gain_tax_overrides
        WHERE portfolio_id = ? AND year_month = ? AND regime = ?
        """,
        (portfolio_id, year_month, regime),
    ).fetchone()
    return dict(row)


def delete_capital_gain_tax_paid_override(conn: sqlite3.Connection, override_id: int) -> bool:
    cur = conn.execute("DELETE FROM fiscal_capital_gain_tax_overrides WHERE id = ?", (override_id,))
    return cur.rowcount > 0


def list_capital_gain_darf_payment_confirmations(
    conn: sqlite3.Connection,
    portfolio_id: int,
    year: Optional[int] = None,
) -> list[dict]:
    params: list[Any] = [portfolio_id]
    where = "portfolio_id = ?"
    if year is not None:
        where += " AND year_month BETWEEN ? AND ?"
        params.extend([f"{year}-01", f"{year}-12"])
    rows = conn.execute(
        f"""
        SELECT *
        FROM fiscal_capital_gain_darf_payment_confirmations
        WHERE {where}
        ORDER BY year_month, regime
        """,
        params,
    ).fetchall()
    return [dict(row) for row in rows]


def upsert_capital_gain_darf_payment_confirmation(
    conn: sqlite3.Connection,
    *,
    portfolio_id: int,
    year_month: str,
    regime: str,
) -> dict:
    _validate_year_month(year_month)
    require_supported_capital_gain_regime(regime)
    if not conn.execute("SELECT 1 FROM portfolios WHERE id = ?", (portfolio_id,)).fetchone():
        raise ValueError(f"Carteira {portfolio_id} nao encontrada.")
    if not has_tax_parameter(conn, regime, f"{year_month}-01"):
        raise ValueError(f"Parametro fiscal nao encontrado para {regime} em {year_month}.")
    conn.execute(
        """
        INSERT INTO fiscal_capital_gain_darf_payment_confirmations (
            portfolio_id, year_month, regime
        )
        VALUES (?, ?, ?)
        ON CONFLICT(portfolio_id, year_month, regime) DO UPDATE SET
            updated_at = datetime('now')
        """,
        (portfolio_id, year_month, regime),
    )
    row = conn.execute(
        """
        SELECT *
        FROM fiscal_capital_gain_darf_payment_confirmations
        WHERE portfolio_id = ? AND year_month = ? AND regime = ?
        """,
        (portfolio_id, year_month, regime),
    ).fetchone()
    return dict(row)


def delete_capital_gain_darf_payment_confirmation(conn: sqlite3.Connection, confirmation_id: int) -> bool:
    cur = conn.execute(
        "DELETE FROM fiscal_capital_gain_darf_payment_confirmations WHERE id = ?",
        (confirmation_id,),
    )
    return cur.rowcount > 0


def list_capital_gain_manual_events(
    conn: sqlite3.Connection,
    portfolio_id: int,
    year: Optional[int] = None,
) -> list[dict]:
    params: list[Any] = [portfolio_id]
    where = "portfolio_id = ?"
    if year is not None:
        where += " AND year_month BETWEEN ? AND ?"
        params.extend([f"{year}-01", f"{year}-12"])
    rows = conn.execute(
        f"""
        SELECT *
        FROM fiscal_capital_gain_manual_events
        WHERE {where}
        ORDER BY year_month, regime, ticker, id
        """,
        params,
    ).fetchall()
    return [dict(row) for row in rows]


def create_capital_gain_manual_event(conn: sqlite3.Connection, values: dict[str, Any]) -> dict:
    portfolio_id = int(values["portfolio_id"])
    year_month = values["year_month"]
    regime = values["regime"]
    _validate_year_month(year_month)
    require_supported_capital_gain_regime(regime)
    ticker = _nullable_text(values.get("ticker"))
    if not ticker:
        raise ValueError("Ativo e obrigatorio.")
    if not conn.execute("SELECT 1 FROM portfolios WHERE id = ?", (portfolio_id,)).fetchone():
        raise ValueError(f"Carteira {portfolio_id} nao encontrada.")
    if not has_tax_parameter(conn, regime, f"{year_month}-01"):
        raise ValueError(f"Parametro fiscal nao encontrado para {regime} em {year_month}.")
    gross_sale = _decimal_text(values.get("gross_sale", "0"), "Venda bruta")
    realized_result = _signed_decimal_text(values.get("realized_result", "0"), "Resultado liquido")
    cur = conn.execute(
        """
        INSERT INTO fiscal_capital_gain_manual_events (
            portfolio_id, year_month, regime, ticker, gross_sale, realized_result
        )
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (portfolio_id, year_month, regime, ticker.upper(), gross_sale, realized_result),
    )
    return _capital_gain_manual_event_row(conn, cur.lastrowid)


def update_capital_gain_manual_event(conn: sqlite3.Connection, event_id: int, updates: dict[str, Any]) -> dict:
    current = _capital_gain_manual_event_row(conn, event_id)
    if not updates:
        return current
    ticker = _nullable_text(updates.get("ticker", current["ticker"]))
    if not ticker:
        raise ValueError("Ativo e obrigatorio.")
    gross_sale = _decimal_text(updates.get("gross_sale", current["gross_sale"]), "Venda bruta")
    realized_result = _signed_decimal_text(
        updates.get("realized_result", current["realized_result"]),
        "Resultado liquido",
    )
    conn.execute(
        """
        UPDATE fiscal_capital_gain_manual_events
        SET ticker = ?, gross_sale = ?, realized_result = ?, updated_at = datetime('now')
        WHERE id = ?
        """,
        (ticker.upper(), gross_sale, realized_result, event_id),
    )
    return _capital_gain_manual_event_row(conn, event_id)


def delete_capital_gain_manual_event(conn: sqlite3.Connection, event_id: int) -> bool:
    cur = conn.execute("DELETE FROM fiscal_capital_gain_manual_events WHERE id = ?", (event_id,))
    return cur.rowcount > 0


def _capital_gain_manual_event_row(conn: sqlite3.Connection, event_id: int) -> dict:
    row = conn.execute(
        "SELECT * FROM fiscal_capital_gain_manual_events WHERE id = ?",
        (event_id,),
    ).fetchone()
    if not row:
        raise ValueError("Evento manual de ganho de capital nao encontrado.")
    return dict(row)
