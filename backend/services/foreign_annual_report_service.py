"""Annual tax report for foreign assets under the post-2024 methodology."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
import sqlite3
from typing import Any

from backend.domain.enums import EventType
from backend.domain.engine import to_decimal
from backend.services import tax_service
from backend.services.fiscal_regime_service import REGIME_FOREIGN_ASSETS_POST_2024


ZERO = Decimal("0")
CENTS = Decimal("0.01")
POST_2024_START_YEAR = 2024


@dataclass
class ForeignAssetAggregate:
    asset_id: int | None
    ticker: str | None
    name: str | None
    capital_result: Decimal = ZERO
    income: Decimal = ZERO
    foreign_tax_paid: Decimal = ZERO


def _d(value: Any) -> Decimal:
    if value in (None, ""):
        return ZERO
    return to_decimal(value)


def _money(value: Decimal) -> str:
    return str(value.quantize(CENTS, rounding=ROUND_HALF_UP))


def _round_money(value: Decimal) -> Decimal:
    return value.quantize(CENTS, rounding=ROUND_HALF_UP)


def _abs_decimal(value: str | None) -> Decimal:
    return abs(_d(value))


def _is_us_asset_where(alias: str = "a") -> str:
    return f"({alias}.market = 'US' OR {alias}.currency = 'USD')"


def _tax_rate(conn: sqlite3.Connection, year: int) -> Decimal:
    fact_date = f"{year}-12-31"
    row = conn.execute(
        """
        SELECT tax_rate
        FROM fiscal_tax_parameters
        WHERE regime = ?
          AND valid_from <= ?
          AND (valid_until IS NULL OR valid_until >= ?)
          AND active = 1
        ORDER BY valid_from DESC, id DESC
        LIMIT 1
        """,
        (REGIME_FOREIGN_ASSETS_POST_2024, fact_date, fact_date),
    ).fetchone()
    if not row:
        raise ValueError(f"Parametro fiscal nao encontrado para {REGIME_FOREIGN_ASSETS_POST_2024} em {year}.")
    return _d(row["tax_rate"])


def _ptax_brl(conn: sqlite3.Connection, event_date: str, amount_usd: Decimal) -> tuple[Decimal | None, bool]:
    from backend.services.ptax_service import get_ptax

    try:
        ptax = get_ptax(event_date, conn=conn)
        return amount_usd * Decimal(str(ptax["venda"])), False
    except Exception:
        return None, True


def _asset_key(row: sqlite3.Row, fallback_label: str | None = None) -> tuple[str, int | str]:
    if row["asset_id"] is not None:
        return ("asset", row["asset_id"])
    ticker = row["current_ticker"] or row["source_symbol"]
    if ticker:
        return ("ticker", ticker)
    return ("label", fallback_label or "Exterior")


def _asset_label_parts(row: sqlite3.Row, fallback_label: str | None = None) -> tuple[int | None, str | None, str | None]:
    ticker = row["current_ticker"] or row["source_symbol"]
    name = row["name"] or fallback_label
    return row["asset_id"], ticker, name


def _ensure_aggregate(
    aggregates: dict[tuple[str, int | str], ForeignAssetAggregate],
    key: tuple[str, int | str],
    asset_id: int | None,
    ticker: str | None,
    name: str | None,
) -> ForeignAssetAggregate:
    aggregate = aggregates.get(key)
    if aggregate is None:
        aggregate = ForeignAssetAggregate(asset_id=asset_id, ticker=ticker, name=name)
        aggregates[key] = aggregate
        return aggregate
    if aggregate.asset_id is None and asset_id is not None:
        aggregate.asset_id = asset_id
    if not aggregate.ticker and ticker:
        aggregate.ticker = ticker
    if not aggregate.name and name:
        aggregate.name = name
    return aggregate


def _ensure_sale_tax_events(conn: sqlite3.Connection, portfolio_id: int, year: int) -> None:
    rows = conn.execute(
        f"""
        SELECT e.*
        FROM events e
        JOIN assets a ON a.id = e.asset_id
        WHERE e.portfolio_id = ?
          AND e.event_date BETWEEN ? AND ?
          AND e.event_type = ?
          AND e.is_cancelled = 0
          AND e.is_storno = 0
          AND {_is_us_asset_where("a")}
        ORDER BY e.event_date, e.sequence_num, e.id
        """,
        (portfolio_id, f"{POST_2024_START_YEAR}-01-01", f"{year}-12-31", EventType.VENDA.value),
    ).fetchall()

    for row in rows:
        existing = conn.execute(
            "SELECT 1 FROM tax_event WHERE tax_event_type = 'SALE' AND sale_event_id = ? LIMIT 1",
            (row["id"],),
        ).fetchone()
        if existing:
            continue
        tax_service.apurar_ganhos_evento_venda(conn, row)


def _add_sale_results(
    conn: sqlite3.Connection,
    portfolio_id: int,
    year: int,
    aggregates: dict[tuple[str, int | str], ForeignAssetAggregate],
) -> None:
    rows = conn.execute(
        f"""
        SELECT
            te.asset_id,
            a.name,
            (
                SELECT ticker FROM asset_tickers
                WHERE asset_id = te.asset_id AND valid_until IS NULL
                ORDER BY valid_from DESC LIMIT 1
            ) AS current_ticker,
            SUM(te.ganho_brl) AS ganho_brl,
            NULL AS source_symbol
        FROM tax_event te
        JOIN events e ON e.id = te.sale_event_id
        JOIN assets a ON a.id = te.asset_id
        WHERE te.portfolio_id = ?
          AND te.tax_event_type = 'SALE'
          AND te.regime = 'POST_2024'
          AND e.event_date BETWEEN ? AND ?
          AND e.is_cancelled = 0
          AND e.is_storno = 0
          AND {_is_us_asset_where("a")}
        GROUP BY te.asset_id, a.name
        """,
        (portfolio_id, f"{year}-01-01", f"{year}-12-31"),
    ).fetchall()
    for row in rows:
        key = _asset_key(row)
        asset_id, ticker, name = _asset_label_parts(row)
        aggregate = _ensure_aggregate(aggregates, key, asset_id, ticker, name)
        aggregate.capital_result += _d(row["ganho_brl"])


def _add_fraction_sales(
    conn: sqlite3.Connection,
    portfolio_id: int,
    year: int,
    aggregates: dict[tuple[str, int | str], ForeignAssetAggregate],
    missing_ptax_dates: set[str],
) -> None:
    rows = conn.execute(
        f"""
        SELECT
            e.asset_id,
            e.event_date,
            e.event_value,
            e.event_value_brl,
            a.name,
            (
                SELECT ticker FROM asset_tickers
                WHERE asset_id = e.asset_id AND valid_until IS NULL
                ORDER BY valid_from DESC LIMIT 1
            ) AS current_ticker,
            NULL AS source_symbol
        FROM events e
        JOIN assets a ON a.id = e.asset_id
        WHERE e.portfolio_id = ?
          AND e.event_date BETWEEN ? AND ?
          AND e.event_type = ?
          AND e.is_cancelled = 0
          AND e.is_storno = 0
          AND {_is_us_asset_where("a")}
        ORDER BY e.event_date, e.sequence_num, e.id
        """,
        (portfolio_id, f"{year}-01-01", f"{year}-12-31", EventType.VENDA_FRACAO.value),
    ).fetchall()
    for row in rows:
        if row["event_value_brl"] is not None:
            amount_brl = _d(row["event_value_brl"])
        else:
            converted, missing_ptax = _ptax_brl(conn, row["event_date"], _d(row["event_value"]))
            if missing_ptax:
                missing_ptax_dates.add(row["event_date"])
                continue
            amount_brl = converted or ZERO
        key = _asset_key(row)
        asset_id, ticker, name = _asset_label_parts(row)
        aggregate = _ensure_aggregate(aggregates, key, asset_id, ticker, name)
        aggregate.capital_result += amount_brl


def _add_schwab_financial_events(
    conn: sqlite3.Connection,
    portfolio_id: int,
    year: int,
    aggregates: dict[tuple[str, int | str], ForeignAssetAggregate],
    missing_ptax_dates: set[str],
) -> None:
    rows = conn.execute(
        """
        SELECT
            t.*,
            a.name,
            (
                SELECT ticker FROM asset_tickers
                WHERE asset_id = t.asset_id AND valid_until IS NULL
                ORDER BY valid_from DESC LIMIT 1
            ) AS current_ticker
        FROM schwab_transactions t
        LEFT JOIN assets a ON a.id = t.asset_id
        WHERE t.portfolio_id = ?
          AND t.event_date BETWEEN ? AND ?
          AND t.status NOT IN ('duplicate', 'ignored', 'error', 'review')
          AND t.normalized_category IN ('dividend', 'foreign_tax', 'interest')
        ORDER BY t.event_date, t.id
        """,
        (portfolio_id, f"{year}-01-01", f"{year}-12-31"),
    ).fetchall()

    for row in rows:
        amount_usd = _abs_decimal(row["amount"])
        if amount_usd == ZERO:
            continue
        converted, missing_ptax = _ptax_brl(conn, row["event_date"], amount_usd)
        if missing_ptax:
            missing_ptax_dates.add(row["event_date"])
            continue
        amount_brl = converted or ZERO

        fallback = "Juros sobre caixa USD" if row["normalized_category"] == "interest" else None
        key = _asset_key(row, fallback)
        asset_id, ticker, name = _asset_label_parts(row, fallback)
        aggregate = _ensure_aggregate(aggregates, key, asset_id, ticker, name)
        if row["normalized_category"] in {"dividend", "interest"}:
            aggregate.income += amount_brl
        elif row["normalized_category"] == "foreign_tax":
            aggregate.foreign_tax_paid += amount_brl


def _fetch_year_aggregates(
    conn: sqlite3.Connection,
    portfolio_id: int,
    year: int,
) -> tuple[list[ForeignAssetAggregate], list[str]]:
    aggregates: dict[tuple[str, int | str], ForeignAssetAggregate] = {}
    missing_ptax_dates: set[str] = set()

    _add_sale_results(conn, portfolio_id, year, aggregates)
    _add_fraction_sales(conn, portfolio_id, year, aggregates, missing_ptax_dates)
    _add_schwab_financial_events(conn, portfolio_id, year, aggregates, missing_ptax_dates)

    rows = [
        aggregate
        for aggregate in aggregates.values()
        if aggregate.capital_result != ZERO or aggregate.income != ZERO or aggregate.foreign_tax_paid != ZERO
    ]
    rows.sort(key=lambda item: (item.ticker or item.name or "", item.asset_id or 0))
    return rows, sorted(missing_ptax_dates)


def _calculate_year(
    conn: sqlite3.Connection,
    portfolio_id: int,
    year: int,
    tax_rate: Decimal,
    initial_loss_carryforward: Decimal,
) -> dict:
    aggregates, missing_ptax_dates = _fetch_year_aggregates(conn, portfolio_id, year)
    balance = -initial_loss_carryforward
    rows = []

    for aggregate in aggregates:
        gain_loss = aggregate.capital_result + aggregate.income
        line_tax_due = gain_loss * tax_rate if gain_loss > ZERO else ZERO
        if gain_loss > ZERO:
            equalized_base = gain_loss if tax_rate <= ZERO else max(ZERO, gain_loss - (aggregate.foreign_tax_paid / tax_rate))
        else:
            equalized_base = gain_loss
        balance += equalized_base
        rows.append(
            {
                "asset_id": aggregate.asset_id,
                "ticker": aggregate.ticker,
                "name": aggregate.name,
                "bem": f"{aggregate.ticker} - {aggregate.name}" if aggregate.ticker and aggregate.name else aggregate.ticker or aggregate.name or "Exterior",
                "gain_loss": gain_loss,
                "line_tax_due": line_tax_due,
                "foreign_tax_paid": aggregate.foreign_tax_paid,
                "taxable_base": equalized_base,
                "balance": balance,
            }
        )

    consolidated_tax_due = balance * tax_rate if balance > ZERO else ZERO
    loss_carryforward = abs(balance) if balance < ZERO else ZERO
    return {
        "rows": rows,
        "missing_ptax_dates": missing_ptax_dates,
        "initial_loss_carryforward": initial_loss_carryforward,
        "final_balance": balance,
        "consolidated_tax_due": consolidated_tax_due,
        "loss_carryforward": loss_carryforward,
    }


def _initial_loss_carryforward(conn: sqlite3.Connection, portfolio_id: int, year: int) -> Decimal:
    if year <= POST_2024_START_YEAR:
        return ZERO

    carry = ZERO
    for previous_year in range(POST_2024_START_YEAR, year):
        calculated = _calculate_year(conn, portfolio_id, previous_year, _tax_rate(conn, previous_year), carry)
        carry = calculated["loss_carryforward"]
    return carry


def list_foreign_annual_report(conn: sqlite3.Connection, portfolio_id: int, year: int) -> dict:
    if year < POST_2024_START_YEAR:
        raise ValueError("Relatorio de exterior considera apenas metodologia pos-2024.")

    _ensure_sale_tax_events(conn, portfolio_id, year)
    tax_rate = _tax_rate(conn, year)
    initial_loss = _initial_loss_carryforward(conn, portfolio_id, year)
    calculated = _calculate_year(conn, portfolio_id, year, tax_rate, initial_loss)

    rows = [
        {
            "asset_id": row["asset_id"],
            "ticker": row["ticker"],
            "name": row["name"],
            "bem": row["bem"],
            "gain_loss": _money(_round_money(row["gain_loss"])),
            "line_tax_due": _money(_round_money(row["line_tax_due"])),
            "foreign_tax_paid": _money(_round_money(row["foreign_tax_paid"])),
            "taxable_base": _money(_round_money(row["taxable_base"])),
            "balance": _money(_round_money(row["balance"])),
        }
        for row in calculated["rows"]
    ]

    return {
        "portfolio_id": portfolio_id,
        "year": year,
        "regime": REGIME_FOREIGN_ASSETS_POST_2024,
        "tax_rate": str(tax_rate.normalize()),
        "initial_loss_carryforward": _money(calculated["initial_loss_carryforward"]),
        "rows": rows,
        "final_balance": _money(_round_money(calculated["final_balance"])),
        "consolidated_tax_due": _money(_round_money(calculated["consolidated_tax_due"])),
        "loss_carryforward": _money(_round_money(calculated["loss_carryforward"])),
        "missing_ptax_dates": calculated["missing_ptax_dates"],
    }
