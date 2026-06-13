"""Portfolio performance read models."""

from __future__ import annotations

from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP
import sqlite3
from typing import Any

from backend.domain.engine import EngineValidationError, EventRecord, PositionState, process_event, replay_events, to_decimal
from backend.domain.enums import B3MarketPriceStatus, EventType, Market
from backend.services import dashboard_service


ZERO = Decimal("0")
CENTS = Decimal("0.01")
PERCENT = Decimal("0.01")
QUOTA_PLACES = Decimal("0.00000001")
INITIAL_QUOTA = Decimal("100.00000000")
PERIODS = {"year", "12m", "24m", "36m", "all"}


def _money(value: Decimal) -> str:
    return str(value.quantize(CENTS, rounding=ROUND_HALF_UP))


def _percent(value: Decimal) -> str:
    return str(value.quantize(PERCENT, rounding=ROUND_HALF_UP))


def _quota(value: Decimal) -> str:
    return str(value.quantize(QUOTA_PLACES, rounding=ROUND_HALF_UP))


def _d(value: Any) -> Decimal:
    if value in (None, ""):
        return ZERO
    return to_decimal(value)


def _month_key(value: str) -> str:
    return value[:7]


def _month_start(month: str) -> str:
    return f"{month}-01"


def _month_end(month: str) -> str:
    return dashboard_service._month_end(month)


def _period_start_month(conn: sqlite3.Connection, portfolio_id: int, period: str) -> str:
    today_month = _month_key(dashboard_service.date.today().isoformat())
    if period != "all":
        return dashboard_service._period_start_month(period, today_month, conn, portfolio_id, None)

    row = conn.execute(
        """
        SELECT MIN(e.event_date) AS first_date
        FROM events e
        JOIN assets a ON a.id = e.asset_id
        WHERE e.portfolio_id = ?
          AND a.market = ?
          AND a.merged_into_asset_id IS NULL
        """,
        (portfolio_id, Market.BR.value),
    ).fetchone()
    first_date = row["first_date"] if row else None
    return _month_key(first_date) if first_date else today_month


def _event_rows(conn: sqlite3.Connection, portfolio_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT
            e.id AS event_id,
            e.asset_id,
            e.event_type,
            e.event_date,
            e.quantity,
            e.event_value,
            e.event_value_brl,
            e.sequence_num,
            e.is_cancelled,
            e.is_storno,
            a.asset_class
        FROM events e
        JOIN assets a ON a.id = e.asset_id
        WHERE e.portfolio_id = ?
          AND a.market = ?
          AND a.merged_into_asset_id IS NULL
        ORDER BY e.asset_id, e.event_date, e.sequence_num
        """,
        (portfolio_id, Market.BR.value),
    ).fetchall()


def _records_by_asset(rows: list[sqlite3.Row]) -> dict[int, list[EventRecord]]:
    grouped: dict[int, list[EventRecord]] = defaultdict(list)
    for row in rows:
        grouped[row["asset_id"]].append(
            EventRecord(
                id=row["event_id"],
                event_type=EventType(row["event_type"]),
                event_date=row["event_date"],
                quantity=_d(row["quantity"]),
                event_value=_d(row["event_value"]),
                event_value_brl=_d(row["event_value_brl"]) if row["event_value_brl"] is not None else None,
                sequence_num=row["sequence_num"],
                is_cancelled=bool(row["is_cancelled"]),
                is_storno=bool(row["is_storno"]),
            )
        )
    return grouped


def _replay(records: list[EventRecord]) -> PositionState:
    try:
        return replay_events(records)
    except EngineValidationError:
        state = PositionState()
        for event in records:
            process_event(event, state, skip_validation=True)
        return state


def _price_lookup(
    conn: sqlite3.Connection,
    portfolio_id: int,
    months: list[str],
    asset_ids: list[int],
) -> dict[tuple[int, str], dashboard_service.PricePoint]:
    if not months or not asset_ids:
        return {}
    month_placeholders = ",".join("?" for _ in months)
    asset_placeholders = ",".join("?" for _ in asset_ids)
    rows = conn.execute(
        f"""
        SELECT
            mp.asset_id,
            mp.reference_month,
            mp.reference_date,
            mp.value,
            mp.is_unit_price
        FROM b3_market_prices mp
        JOIN b3_monthly_imports mi ON mi.id = mp.import_id
        JOIN assets a ON a.id = mp.asset_id
        WHERE mi.portfolio_id = ?
          AND a.market = ?
          AND mp.asset_id IN ({asset_placeholders})
          AND mp.reference_month IN ({month_placeholders})
          AND mp.value IS NOT NULL
          AND mp.status = ?
        ORDER BY mp.asset_id, mp.reference_month, mp.reference_date DESC, mp.updated_at DESC, mp.id DESC
        """,
        [portfolio_id, Market.BR.value, *asset_ids, *months, B3MarketPriceStatus.IMPORTED.value],
    ).fetchall()
    result: dict[tuple[int, str], dashboard_service.PricePoint] = {}
    for row in rows:
        key = (row["asset_id"], row["reference_month"])
        if key in result:
            continue
        result[key] = dashboard_service.PricePoint(
            value=_d(row["value"]),
            is_unit_price=bool(row["is_unit_price"]),
            reference_date=row["reference_date"],
        )
    return result


def _flow_parts(event: EventRecord) -> tuple[Decimal, Decimal]:
    if event.is_cancelled or event.is_storno:
        return ZERO, ZERO
    if event.event_type == EventType.COMPRA:
        return event.replay_value, ZERO
    if event.event_type in {
        EventType.VENDA,
        EventType.VENDA_FRACAO,
        EventType.RESGATE_ANTECIPADO,
        EventType.RESGATE_VENCIMENTO,
        EventType.AMORTIZACAO,
        EventType.CISAO,
    }:
        return ZERO, event.replay_value
    return ZERO, ZERO


def _market_value_for_month(
    grouped_records: dict[int, list[EventRecord]],
    price_lookup: dict[tuple[int, str], dashboard_service.PricePoint],
    month: str,
) -> tuple[Decimal, int]:
    cutoff = _month_end(month)
    market_value = ZERO
    fallback_count = 0
    for asset_id, records in grouped_records.items():
        state = _replay([event for event in records if event.event_date <= cutoff])
        if state.quantity <= ZERO:
            continue
        price = price_lookup.get((asset_id, month))
        value, used_fallback = dashboard_service._market_value_for_state(state, price)
        market_value += value
        if used_fallback:
            fallback_count += 1
    return market_value, fallback_count


def get_twr(
    conn: sqlite3.Connection,
    portfolio_id: int,
    period: str = "year",
) -> dict[str, Any]:
    if period not in PERIODS:
        raise ValueError("Periodo invalido.")

    today_month = _month_key(dashboard_service.date.today().isoformat())
    start_month = _period_start_month(conn, portfolio_id, period)
    months = dashboard_service._month_range(start_month, today_month)
    rows = _event_rows(conn, portfolio_id)
    grouped_records = _records_by_asset(rows)
    asset_ids = sorted(grouped_records)
    prices = _price_lookup(conn, portfolio_id, months, asset_ids)
    events = sorted((event for records in grouped_records.values() for event in records), key=lambda event: (event.event_date, event.sequence_num))

    quota_value = INITIAL_QUOTA
    accumulated_factor = Decimal("1")
    previous_market_value = ZERO
    series = []
    fallback_points = 0

    for month in months:
        start = _month_start(month)
        cutoff = _month_end(month)
        flow_parts = [_flow_parts(event) for event in events if start <= event.event_date <= cutoff]
        flow_in = sum((item[0] for item in flow_parts), ZERO)
        flow_out = sum((item[1] for item in flow_parts), ZERO)
        net_flow = flow_in - flow_out
        market_value, fallback_count = _market_value_for_month(grouped_records, prices, month)
        if fallback_count:
            fallback_points += 1

        if previous_market_value > ZERO:
            monthly_return = (market_value - net_flow - previous_market_value) / previous_market_value
        elif market_value == net_flow or market_value <= ZERO:
            monthly_return = ZERO
        else:
            base = net_flow if net_flow > ZERO else market_value
            monthly_return = (market_value - net_flow - ZERO) / base if base > ZERO else ZERO

        accumulated_factor *= (Decimal("1") + monthly_return)
        quota_value = INITIAL_QUOTA * accumulated_factor
        previous_market_value = market_value

        series.append(
            {
                "year_month": month,
                "market_value": _money(market_value),
                "flow_in": _money(flow_in),
                "flow_out": _money(flow_out),
                "net_flow": _money(net_flow),
                "monthly_return_pct": _percent(monthly_return * Decimal("100")),
                "accumulated_return_pct": _percent((accumulated_factor - Decimal("1")) * Decimal("100")),
                "quota_value": _quota(quota_value),
                "uses_cost_fallback": fallback_count > 0,
                "missing_quote_count": fallback_count,
            }
        )

    latest = series[-1] if series else None
    return {
        "portfolio_id": portfolio_id,
        "market": Market.BR.value,
        "period": period,
        "summary": {
            "quota_value": latest["quota_value"] if latest else _quota(INITIAL_QUOTA),
            "accumulated_return_pct": latest["accumulated_return_pct"] if latest else _percent(ZERO),
            "monthly_return_pct": latest["monthly_return_pct"] if latest else _percent(ZERO),
            "market_value": latest["market_value"] if latest else _money(ZERO),
            "uses_cost_fallback": fallback_points > 0,
            "fallback_month_count": fallback_points,
        },
        "series": series,
    }
