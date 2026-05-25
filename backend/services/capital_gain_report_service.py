"""
Capital gain report service.

The report is derived from ledger replay and fiscal parameters. It does not
persist calculated report rows.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP
import sqlite3
from typing import Any

from backend.domain.engine import EventRecord, PositionState, process_event, to_decimal
from backend.domain.enums import AssetClass, EventType
from backend.services.fiscal_regime_service import (
    REGIME_B3_COMMON,
    REGIME_B3_FII,
    REGIME_CRYPTO,
    REGIME_FI_INFRA_EXEMPT,
    is_supported_capital_gain_regime,
)


ZERO = Decimal("0")
CENTS = Decimal("0.01")
TREATMENT_EXEMPT_ZERO = "EXEMPT_ZERO"


@dataclass
class SaleItem:
    event_id: int
    asset_id: int
    ticker: str | None
    asset_class: str
    market: str
    currency: str
    event_date: str
    regime: str
    gross_sale: Decimal
    net_sale: Decimal
    costs: Decimal
    cost_basis: Decimal
    net_result: Decimal


@dataclass
class AssetAggregate:
    asset_id: int
    ticker: str | None
    asset_class: str
    fiscal_regime: str
    gross_sale: Decimal = ZERO
    net_sale: Decimal = ZERO
    costs: Decimal = ZERO
    cost_basis: Decimal = ZERO
    realized_result: Decimal = ZERO
    exempt_gain: Decimal = ZERO
    taxable_result_before_compensation: Decimal = ZERO
    theoretical_irrf: Decimal = ZERO
    effective_irrf: Decimal = ZERO
    source_items: list[SaleItem] = field(default_factory=list)

    def add(self, item: SaleItem) -> None:
        self.gross_sale += item.gross_sale
        self.net_sale += item.net_sale
        self.costs += item.costs
        self.cost_basis += item.cost_basis
        self.realized_result += item.net_result
        self.source_items.append(item)


def _money(value: Decimal) -> str:
    return str(value.quantize(CENTS, rounding=ROUND_HALF_UP))


def _round_money(value: Decimal) -> Decimal:
    return value.quantize(CENTS, rounding=ROUND_HALF_UP)


def _rate(value: Decimal) -> str:
    return str(value.normalize())


def _d(value: Any) -> Decimal:
    if value in (None, ""):
        return ZERO
    return to_decimal(value)


def _month_key(value: str) -> str:
    return value[:7]


def _is_action_br(item: SaleItem) -> bool:
    return item.asset_class == AssetClass.ACAO.value and item.market == "BR"


def _resolve_regime(row: sqlite3.Row) -> str | None:
    override = row["fiscal_regime_override"]
    if override:
        return override if is_supported_capital_gain_regime(override) else None

    asset_class = row["asset_class"]
    market = row["market"]
    currency = row["currency"]
    treatment = row["fiscal_tax_treatment"]

    if asset_class == AssetClass.CRIPTOMOEDA.value:
        return REGIME_CRYPTO
    if asset_class == AssetClass.FI_INFRA.value and treatment == TREATMENT_EXEMPT_ZERO:
        return REGIME_FI_INFRA_EXEMPT
    if market == "US" or currency == "USD":
        return None
    if asset_class == AssetClass.FII.value:
        return REGIME_B3_FII
    if asset_class in {AssetClass.ACAO.value, AssetClass.ETF.value, AssetClass.BDR.value}:
        return REGIME_B3_COMMON
    return None


def _fetch_sales(conn: sqlite3.Connection, portfolio_id: int, year: int) -> list[SaleItem]:
    end_date = f"{year}-12-31"
    rows = conn.execute(
        """
        SELECT
            e.*,
            a.asset_class,
            a.market,
            a.currency,
            a.fiscal_regime_override,
            a.fiscal_tax_treatment,
            (
                SELECT ticker
                FROM asset_tickers
                WHERE asset_id = e.asset_id
                  AND valid_until IS NULL
                ORDER BY valid_from DESC
                LIMIT 1
            ) AS current_ticker
        FROM events e
        JOIN assets a ON a.id = e.asset_id
        WHERE e.portfolio_id = ?
          AND e.event_date <= ?
          AND a.merged_into_asset_id IS NULL
        ORDER BY e.asset_id, e.event_date, e.sequence_num
        """,
        (portfolio_id, end_date),
    ).fetchall()

    grouped: dict[int, list[sqlite3.Row]] = defaultdict(list)
    for row in rows:
        grouped[row["asset_id"]].append(row)

    sales: list[SaleItem] = []
    for asset_rows in grouped.values():
        state = PositionState()
        for row in asset_rows:
            event_type = EventType(row["event_type"])
            event = EventRecord(
                id=row["id"],
                event_type=event_type,
                event_date=row["event_date"],
                quantity=_d(row["quantity"]),
                event_value=_d(row["event_value"]),
                event_value_brl=_d(row["event_value_brl"]) if row["event_value_brl"] is not None else None,
                sequence_num=row["sequence_num"],
                is_cancelled=bool(row["is_cancelled"]),
                is_storno=bool(row["is_storno"]),
            )
            realized = process_event(event, state, skip_validation=True)
            if event.is_cancelled or event.is_storno:
                continue
            if event_type != EventType.VENDA:
                continue
            regime = _resolve_regime(row)
            if not regime:
                continue

            net_sale = _d(row["event_value_brl"] if row["event_value_brl"] is not None else row["event_value"])
            gross_source = (
                row["gross_value_brl"]
                if row["gross_value_brl"] is not None
                else row["gross_value"]
                if row["gross_value"] is not None
                else row["event_value_brl"]
                if row["event_value_brl"] is not None
                else row["event_value"]
            )
            gross_sale = _d(gross_source)
            sales.append(
                SaleItem(
                    event_id=row["id"],
                    asset_id=row["asset_id"],
                    ticker=row["current_ticker"],
                    asset_class=row["asset_class"],
                    market=row["market"],
                    currency=row["currency"],
                    event_date=row["event_date"],
                    regime=regime,
                    gross_sale=gross_sale,
                    net_sale=net_sale,
                    costs=gross_sale - net_sale,
                    cost_basis=net_sale - realized,
                    net_result=realized,
                )
            )
    return sales


def _tax_parameter(conn: sqlite3.Connection, regime: str, event_date: str) -> dict:
    row = conn.execute(
        """
        SELECT *
        FROM fiscal_tax_parameters
        WHERE regime = ?
          AND valid_from <= ?
          AND (valid_until IS NULL OR valid_until >= ?)
          AND active = 1
        ORDER BY valid_from DESC, id DESC
        LIMIT 1
        """,
        (regime, event_date, event_date),
    ).fetchone()
    if not row:
        raise ValueError(f"Parametro fiscal nao encontrado para {regime} em {event_date}.")
    return dict(row)


def _overrides(conn: sqlite3.Connection, portfolio_id: int, year: int) -> dict[tuple[str, str], dict]:
    rows = conn.execute(
        """
        SELECT *
        FROM fiscal_irrf_overrides
        WHERE portfolio_id = ?
          AND year_month <= ?
        """,
        (portfolio_id, f"{year}-12"),
    ).fetchall()
    return {(row["year_month"], row["regime"]): dict(row) for row in rows}


def _empty_regime_row(regime: str, bucket: str | None, param: dict) -> dict:
    return {
        "regime": regime,
        "bucket": bucket,
        "gross_sale": ZERO,
        "net_sale": ZERO,
        "costs": ZERO,
        "cost_basis": ZERO,
        "realized_result": ZERO,
        "exempt_gain": ZERO,
        "taxable_result_before_compensation": ZERO,
        "initial_loss_carryforward": ZERO,
        "used_loss": ZERO,
        "taxable_base": ZERO,
        "tax_rate": _d(param["tax_rate"]),
        "tax_due": ZERO,
        "theoretical_irrf": ZERO,
        "irrf_override": None,
        "effective_irrf": ZERO,
        "minimum_darf_amount": _d(param["minimum_darf_amount"]),
        "initial_darf_carryforward": ZERO,
        "darf_before_minimum": ZERO,
        "darf_estimated": ZERO,
        "final_darf_carryforward": ZERO,
        "initial_irrf_carryforward": ZERO,
        "used_irrf": ZERO,
        "final_irrf_carryforward": ZERO,
        "final_loss_carryforward": ZERO,
        "assets": {},
    }


def _asset_rows(assets: dict[int, AssetAggregate]) -> list[dict]:
    result = []
    for aggregate in sorted(assets.values(), key=lambda item: (item.ticker or "", item.asset_id)):
        result.append(
            {
                "asset_id": aggregate.asset_id,
                "ticker": aggregate.ticker,
                "asset_class": aggregate.asset_class,
                "fiscal_regime": aggregate.fiscal_regime,
                "gross_sale": _money(aggregate.gross_sale),
                "net_sale": _money(aggregate.net_sale),
                "costs": _money(aggregate.costs),
                "cost_basis": _money(aggregate.cost_basis),
                "realized_result": _money(aggregate.realized_result),
                "exempt_gain": _money(aggregate.exempt_gain),
                "taxable_result_before_compensation": _money(aggregate.taxable_result_before_compensation),
                "theoretical_irrf": _money(aggregate.theoretical_irrf),
                "effective_irrf": _money(aggregate.effective_irrf),
                "source_events": [
                    {
                        "event_id": item.event_id,
                        "event_date": item.event_date,
                        "source_event_type": "capital_gain_sale",
                        "amount": _money(item.net_result),
                        "year_month": _month_key(item.event_date),
                    }
                    for item in sorted(
                        (
                            item
                            for item in getattr(aggregate, "source_items", [])
                            if item.net_result > ZERO
                        ),
                        key=lambda item: (item.event_date, item.event_id),
                    )
                ],
            }
        )
    return result


def _format_regime_row(row: dict) -> dict:
    return {
        "regime": row["regime"],
        "bucket": row["bucket"],
        "gross_sale": _money(row["gross_sale"]),
        "net_sale": _money(row["net_sale"]),
        "costs": _money(row["costs"]),
        "cost_basis": _money(row["cost_basis"]),
        "realized_result": _money(row["realized_result"]),
        "exempt_gain": _money(row["exempt_gain"]),
        "taxable_result_before_compensation": _money(row["taxable_result_before_compensation"]),
        "initial_loss_carryforward": _money(row["initial_loss_carryforward"]),
        "used_loss": _money(row["used_loss"]),
        "taxable_base": _money(row["taxable_base"]),
        "tax_rate": _rate(row["tax_rate"]),
        "tax_due": _money(row["tax_due"]),
        "theoretical_irrf": _money(row["theoretical_irrf"]),
        "irrf_override": _money(row["irrf_override"]) if row["irrf_override"] is not None else None,
        "effective_irrf": _money(row["effective_irrf"]),
        "minimum_darf_amount": _money(row["minimum_darf_amount"]),
        "initial_darf_carryforward": _money(row["initial_darf_carryforward"]),
        "darf_before_minimum": _money(row["darf_before_minimum"]),
        "darf_estimated": _money(row["darf_estimated"]),
        "final_darf_carryforward": _money(row["final_darf_carryforward"]),
        "initial_irrf_carryforward": _money(row["initial_irrf_carryforward"]),
        "used_irrf": _money(row["used_irrf"]),
        "final_irrf_carryforward": _money(row["final_irrf_carryforward"]),
        "final_loss_carryforward": _money(row["final_loss_carryforward"]),
        "assets": _asset_rows(row["assets"]),
    }


def _allocate_effective_irrf(row: dict) -> None:
    assets = row["assets"]
    if not assets:
        return

    theoretical_total = row["theoretical_irrf"]
    gross_total = row["gross_sale"]
    for aggregate in assets.values():
        if theoretical_total > ZERO:
            aggregate.effective_irrf = row["effective_irrf"] * aggregate.theoretical_irrf / theoretical_total
        elif gross_total > ZERO:
            aggregate.effective_irrf = row["effective_irrf"] * aggregate.gross_sale / gross_total
        else:
            aggregate.effective_irrf = ZERO


def list_capital_gains(conn: sqlite3.Connection, portfolio_id: int, year: int) -> dict:
    sales_by_month_regime: dict[tuple[str, str], list[SaleItem]] = defaultdict(list)
    for item in _fetch_sales(conn, portfolio_id, year):
        sales_by_month_regime[(_month_key(item.event_date), item.regime)].append(item)

    overrides = _overrides(conn, portfolio_id, year)
    loss_carry: dict[str, Decimal] = defaultdict(Decimal)
    darf_carry: dict[str, Decimal] = defaultdict(Decimal)
    irrf_carry: dict[str, Decimal] = defaultdict(Decimal)
    months = []
    current_irrf_year: str | None = None

    year_months = sorted({month for month, _ in sales_by_month_regime} | {month for month, _ in overrides})

    for month in year_months:
        month_year = month[:4]
        if current_irrf_year != month_year:
            irrf_carry = defaultdict(Decimal)
            current_irrf_year = month_year

        regime_rows = []
        month_regimes = sorted(
            {
                regime
                for key_month, regime in sales_by_month_regime
                if key_month == month
            }
            | {
                regime
                for key_month, regime in overrides
                if key_month == month and is_supported_capital_gain_regime(regime)
            }
        )

        for regime in month_regimes:
            items = sales_by_month_regime.get((month, regime), [])
            reference_date = max((item.event_date for item in items), default=f"{month}-01")
            param = _tax_parameter(conn, regime, reference_date)
            bucket = param["loss_bucket"]
            row = _empty_regime_row(regime, bucket, param)

            assets: dict[int, AssetAggregate] = {}
            action_gross = sum((item.gross_sale for item in items if _is_action_br(item)), ZERO)
            action_result = sum((item.net_result for item in items if _is_action_br(item)), ZERO)
            exemption_limit = _d(param["exemption_limit"])
            action_is_exempt = (
                regime == REGIME_B3_COMMON
                and action_gross > ZERO
                and exemption_limit > ZERO
                and action_gross <= exemption_limit
            )

            for item in items:
                row["gross_sale"] += item.gross_sale
                row["net_sale"] += item.net_sale
                row["costs"] += item.costs
                row["cost_basis"] += item.cost_basis
                row["realized_result"] += item.net_result
                item_theoretical_irrf = item.gross_sale * _d(param["withholding_rate"])
                row["theoretical_irrf"] += item_theoretical_irrf

                aggregate = assets.setdefault(
                    item.asset_id,
                    AssetAggregate(item.asset_id, item.ticker, item.asset_class, item.regime),
                )
                aggregate.add(item)
                aggregate.theoretical_irrf += item_theoretical_irrf

                if action_is_exempt and _is_action_br(item):
                    if action_result > ZERO and item.net_result > ZERO:
                        aggregate.exempt_gain += item.net_result
                    continue

                if regime in {REGIME_FI_INFRA_EXEMPT, REGIME_CRYPTO}:
                    taxable_component = item.net_result if regime == REGIME_CRYPTO else ZERO
                else:
                    taxable_component = item.net_result
                row["taxable_result_before_compensation"] += taxable_component
                aggregate.taxable_result_before_compensation += taxable_component

            if regime == REGIME_FI_INFRA_EXEMPT:
                row["exempt_gain"] = row["realized_result"] if row["realized_result"] > ZERO else ZERO
            elif action_is_exempt and action_result > ZERO:
                row["exempt_gain"] = action_result

            row["assets"] = assets
            if bucket:
                row["initial_loss_carryforward"] = loss_carry[bucket]
                taxable_result = row["taxable_result_before_compensation"]
                if taxable_result < ZERO:
                    loss_carry[bucket] += -taxable_result
                    row["final_loss_carryforward"] = loss_carry[bucket]
                else:
                    used = min(loss_carry[bucket], taxable_result)
                    row["used_loss"] = used
                    loss_carry[bucket] -= used
                    row["taxable_base"] = taxable_result - used
                    row["final_loss_carryforward"] = loss_carry[bucket]
            else:
                row["final_loss_carryforward"] = ZERO

            if param["monthly_darf_enabled"] and row["taxable_base"] > ZERO:
                row["tax_due"] = _round_money(row["taxable_base"] * row["tax_rate"])

            override = overrides.get((month, regime))
            if override:
                row["irrf_override"] = _d(override["effective_irrf"])
                row["effective_irrf"] = row["irrf_override"]
            else:
                row["effective_irrf"] = ZERO

            if param["monthly_darf_enabled"]:
                row["initial_darf_carryforward"] = darf_carry[regime]
                row["initial_irrf_carryforward"] = irrf_carry[regime]
                available_irrf = row["initial_irrf_carryforward"] + row["effective_irrf"]
                gross_darf = row["initial_darf_carryforward"] + row["tax_due"]
                row["used_irrf"] = min(available_irrf, gross_darf)
                row["final_irrf_carryforward"] = available_irrf - row["used_irrf"]
                row["darf_before_minimum"] = gross_darf - row["used_irrf"]
                minimum_darf = row["minimum_darf_amount"]
                if row["darf_before_minimum"] > ZERO and (minimum_darf <= ZERO or row["darf_before_minimum"] >= minimum_darf):
                    row["darf_estimated"] = row["darf_before_minimum"]
                    row["final_darf_carryforward"] = ZERO
                else:
                    row["darf_estimated"] = ZERO
                    row["final_darf_carryforward"] = row["darf_before_minimum"]
                darf_carry[regime] = row["final_darf_carryforward"]
                irrf_carry[regime] = row["final_irrf_carryforward"]

            _allocate_effective_irrf(row)
            if month_year == str(year):
                regime_rows.append(_format_regime_row(row))

        if regime_rows:
            months.append({"year_month": month, "month": int(month[-2:]), "regimes": regime_rows})

    return {"portfolio_id": portfolio_id, "year": year, "months": months}
