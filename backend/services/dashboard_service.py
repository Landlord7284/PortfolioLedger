"""Consolidated patrimonial dashboard read model.

The dashboard is intentionally a read-side aggregation over the ledger,
positions cache and B3 monthly imports. Critical patrimonial math stays here so
the frontend only renders an explicit contract.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
import calendar
import datetime as dt
from decimal import Decimal, ROUND_HALF_UP
import sqlite3
from typing import Any

from backend.domain.engine import (
    EngineValidationError,
    EventRecord,
    PositionState,
    process_event,
    replay_events,
    to_decimal,
)
from backend.domain.enums import EventType


date = dt.date

ZERO = Decimal("0")
CENTS = Decimal("0.01")
PCT = Decimal("0.01")
PERIODS = {"12m", "ytd", "3y", "all"}


@dataclass(frozen=True)
class PricePoint:
    value: Decimal
    is_unit_price: bool
    reference_date: str | None


def _money(value: Decimal) -> str:
    return str(value.quantize(CENTS, rounding=ROUND_HALF_UP))


def _percent(value: Decimal) -> str:
    return str(value.quantize(PCT, rounding=ROUND_HALF_UP))


def _d(value: Any) -> Decimal:
    if value in (None, ""):
        return ZERO
    return to_decimal(value)


def _month_key(value: dt.date | str) -> str:
    if isinstance(value, dt.date):
        return f"{value.year:04d}-{value.month:02d}"
    return value[:7]


def _add_months(year: int, month: int, delta: int) -> tuple[int, int]:
    total = year * 12 + (month - 1) + delta
    return total // 12, total % 12 + 1


def _month_range(start_month: str, end_month: str) -> list[str]:
    sy, sm = (int(part) for part in start_month.split("-"))
    ey, em = (int(part) for part in end_month.split("-"))
    count = max(0, (ey - sy) * 12 + em - sm + 1)
    return [f"{y:04d}-{m:02d}" for y, m in (_add_months(sy, sm, index) for index in range(count))]


def _month_start(month: str) -> str:
    return f"{month}-01"


def _month_end(month: str) -> str:
    year, month_num = (int(part) for part in month.split("-"))
    last_day = calendar.monthrange(year, month_num)[1]
    return f"{month}-{last_day:02d}"


def _period_start_month(
    period: str,
    end_month: str,
    conn: sqlite3.Connection,
    portfolio_id: int,
    asset_class: str | None,
) -> str:
    year, month = (int(part) for part in end_month.split("-"))
    if period == "12m":
        y, m = _add_months(year, month, -11)
        return f"{y:04d}-{m:02d}"
    if period == "ytd":
        return f"{year:04d}-01"
    if period == "3y":
        y, m = _add_months(year, month, -35)
        return f"{y:04d}-{m:02d}"

    conditions = ["e.portfolio_id = ?"]
    params: list[Any] = [portfolio_id]
    if asset_class:
        conditions.append("a.asset_class = ?")
        params.append(asset_class)
    row = conn.execute(
        f"""
        SELECT MIN(e.event_date) AS first_date
        FROM events e
        JOIN assets a ON a.id = e.asset_id
        WHERE {" AND ".join(conditions)}
        """,
        params,
    ).fetchone()
    first_date = row["first_date"] if row else None
    return _month_key(first_date) if first_date else end_month


def _asset_classes(conn: sqlite3.Connection, portfolio_id: int) -> list[str]:
    rows = conn.execute(
        """
        SELECT DISTINCT asset_class
        FROM (
            SELECT a.asset_class
            FROM assets a
            JOIN events e ON e.asset_id = a.id
            WHERE e.portfolio_id = ? AND a.merged_into_asset_id IS NULL
            UNION
            SELECT a.asset_class
            FROM assets a
            JOIN positions p ON p.asset_id = a.id
            WHERE p.portfolio_id = ? AND a.merged_into_asset_id IS NULL
            UNION
            SELECT a.asset_class
            FROM b3_market_prices mp
            JOIN b3_monthly_imports mi ON mi.id = mp.import_id
            JOIN assets a ON a.id = mp.asset_id
            WHERE mi.portfolio_id = ? AND a.merged_into_asset_id IS NULL
            UNION
            SELECT a.asset_class
            FROM b3_income_events i
            JOIN assets a ON a.id = i.asset_id
            WHERE i.portfolio_id = ? AND a.merged_into_asset_id IS NULL
        )
        WHERE asset_class IS NOT NULL
        ORDER BY asset_class
        """,
        (portfolio_id, portfolio_id, portfolio_id, portfolio_id),
    ).fetchall()
    return [row["asset_class"] for row in rows]


def _latest_quote_info(
    conn: sqlite3.Connection,
    portfolio_id: int,
    asset_class: str | None,
) -> tuple[str | None, str | None]:
    conditions = [
        "mi.portfolio_id = ?",
        "mp.asset_id IS NOT NULL",
        "mp.value IS NOT NULL",
        "mp.status = 'imported'",
    ]
    params: list[Any] = [portfolio_id]
    if asset_class:
        conditions.append("a.asset_class = ?")
        params.append(asset_class)

    row = conn.execute(
        f"""
        SELECT MAX(mp.reference_month) AS latest_month
        FROM b3_market_prices mp
        JOIN b3_monthly_imports mi ON mi.id = mp.import_id
        JOIN assets a ON a.id = mp.asset_id
        WHERE {" AND ".join(conditions)}
        """,
        params,
    ).fetchone()
    latest_month = row["latest_month"] if row else None
    if not latest_month:
        return None, None

    date_row = conn.execute(
        f"""
        SELECT MAX(mp.reference_date) AS latest_date
        FROM b3_market_prices mp
        JOIN b3_monthly_imports mi ON mi.id = mp.import_id
        JOIN assets a ON a.id = mp.asset_id
        WHERE {" AND ".join(conditions)}
          AND mp.reference_month = ?
        """,
        [*params, latest_month],
    ).fetchone()
    return latest_month, date_row["latest_date"] if date_row else None


def _last_b3_import_at(conn: sqlite3.Connection, portfolio_id: int) -> str | None:
    row = conn.execute(
        "SELECT MAX(created_at) AS last_import FROM b3_monthly_imports WHERE portfolio_id = ?",
        (portfolio_id,),
    ).fetchone()
    return row["last_import"] if row else None


def _current_positions(
    conn: sqlite3.Connection,
    portfolio_id: int,
    asset_class: str | None,
) -> list[dict[str, Any]]:
    conditions = ["p.portfolio_id = ?", "a.merged_into_asset_id IS NULL"]
    params: list[Any] = [portfolio_id]
    if asset_class:
        conditions.append("a.asset_class = ?")
        params.append(asset_class)

    rows = conn.execute(
        f"""
        SELECT
            p.asset_id,
            p.quantity,
            p.total_cost,
            p.realized_result,
            a.asset_class,
            a.name,
            (
                SELECT ticker
                FROM asset_tickers t
                WHERE t.asset_id = p.asset_id AND t.valid_until IS NULL
                ORDER BY t.valid_from DESC NULLS FIRST, t.id DESC
                LIMIT 1
            ) AS current_ticker
        FROM positions p
        JOIN assets a ON a.id = p.asset_id
        WHERE {" AND ".join(conditions)}
        ORDER BY a.asset_class, current_ticker, p.asset_id
        """,
        params,
    ).fetchall()
    return [dict(row) for row in rows]


def _event_rows(
    conn: sqlite3.Connection,
    portfolio_id: int,
    asset_class: str | None,
) -> list[sqlite3.Row]:
    conditions = ["e.portfolio_id = ?", "a.merged_into_asset_id IS NULL"]
    params: list[Any] = [portfolio_id]
    if asset_class:
        conditions.append("a.asset_class = ?")
        params.append(asset_class)

    return conn.execute(
        f"""
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
            a.asset_class,
            a.name,
            (
                SELECT ticker
                FROM asset_tickers t
                WHERE t.asset_id = e.asset_id AND t.valid_until IS NULL
                ORDER BY t.valid_from DESC NULLS FIRST, t.id DESC
                LIMIT 1
            ) AS current_ticker
        FROM events e
        JOIN assets a ON a.id = e.asset_id
        WHERE {" AND ".join(conditions)}
        ORDER BY e.asset_id, e.event_date, e.sequence_num
        """,
        params,
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


def _asset_meta(rows: list[sqlite3.Row]) -> dict[int, dict[str, Any]]:
    meta: dict[int, dict[str, Any]] = {}
    for row in rows:
        meta.setdefault(
            row["asset_id"],
            {
                "asset_id": row["asset_id"],
                "asset_class": row["asset_class"] or "Sem classe",
                "current_ticker": row["current_ticker"],
                "name": row["name"],
            },
        )
    return meta


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
) -> dict[tuple[int, str], PricePoint]:
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
        WHERE mi.portfolio_id = ?
          AND mp.asset_id IN ({asset_placeholders})
          AND mp.reference_month IN ({month_placeholders})
          AND mp.value IS NOT NULL
          AND mp.status = 'imported'
        ORDER BY mp.asset_id, mp.reference_month, mp.reference_date DESC, mp.updated_at DESC, mp.id DESC
        """,
        [portfolio_id, *asset_ids, *months],
    ).fetchall()

    result: dict[tuple[int, str], PricePoint] = {}
    for row in rows:
        key = (row["asset_id"], row["reference_month"])
        if key in result:
            continue
        result[key] = PricePoint(
            value=_d(row["value"]),
            is_unit_price=bool(row["is_unit_price"]),
            reference_date=row["reference_date"],
        )
    return result


def _market_value_for_state(state: PositionState, price: PricePoint | None) -> tuple[Decimal, bool]:
    if state.quantity <= ZERO:
        return ZERO, False
    if price is None:
        return state.total_cost, True
    if price.is_unit_price:
        return state.quantity * price.value, False
    return price.value, False


def _market_value_for_position(position: dict[str, Any], price: PricePoint | None) -> tuple[Decimal, bool]:
    quantity = _d(position["quantity"])
    total_cost = _d(position["total_cost"])
    if quantity <= ZERO:
        return ZERO, False
    if price is None:
        return total_cost, True
    if price.is_unit_price:
        return quantity * price.value, False
    return price.value, False


def _cash_flow(event: EventRecord) -> Decimal:
    if event.is_cancelled or event.is_storno:
        return ZERO
    if event.event_type == EventType.COMPRA:
        return event.replay_value
    if event.event_type in EventType.exit_events() or event.event_type == EventType.AMORTIZACAO:
        return -event.replay_value
    return ZERO


def _realized_result(
    grouped_records: dict[int, list[EventRecord]],
    start_date: str | None,
    end_date: str,
) -> Decimal:
    total = ZERO
    for records in grouped_records.values():
        state = PositionState()
        for event in records:
            realized = process_event(event, state, skip_validation=True)
            if event.is_cancelled or event.is_storno:
                continue
            if start_date and event.event_date < start_date:
                continue
            if event.event_date > end_date:
                continue
            if event.event_type in EventType.exit_events():
                total += realized
    return total


def _build_current_snapshot(
    positions: list[dict[str, Any]],
    price_lookup: dict[tuple[int, str], PricePoint],
    latest_quote_month: str | None,
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], list[str], Decimal, int]:
    market_total = ZERO
    cost_total = ZERO
    fallback_amount = ZERO
    fallback_count = 0
    missing_labels: list[str] = []
    by_class: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"market_value": ZERO, "cost_basis": ZERO, "uses_cost_fallback": False}
    )

    for position in positions:
        quantity = _d(position["quantity"])
        if quantity <= ZERO:
            continue
        asset_id = position["asset_id"]
        asset_class = position["asset_class"] or "Sem classe"
        cost = _d(position["total_cost"])
        price = price_lookup.get((asset_id, latest_quote_month)) if latest_quote_month else None
        market_value, used_fallback = _market_value_for_position(position, price)

        market_total += market_value
        cost_total += cost
        by_class[asset_class]["market_value"] += market_value
        by_class[asset_class]["cost_basis"] += cost
        if used_fallback:
            fallback_count += 1
            fallback_amount += market_value
            by_class[asset_class]["uses_cost_fallback"] = True
            missing_labels.append(position.get("current_ticker") or position.get("name") or f"Ativo #{asset_id}")

    allocation = []
    result_by_class = []
    for asset_class, values in by_class.items():
        class_market = values["market_value"]
        class_cost = values["cost_basis"]
        unrealized = class_market - class_cost
        allocation.append(
            {
                "asset_class": asset_class,
                "market_value": _money(class_market),
                "weight_pct": _percent((class_market / market_total * Decimal("100")) if market_total else ZERO),
                "uses_cost_fallback": values["uses_cost_fallback"],
            }
        )
        result_by_class.append(
            {
                "asset_class": asset_class,
                "market_value": _money(class_market),
                "cost_basis": _money(class_cost),
                "unrealized_result": _money(unrealized),
                "unrealized_result_pct": _percent((unrealized / class_cost * Decimal("100")) if class_cost else ZERO),
                "uses_cost_fallback": values["uses_cost_fallback"],
            }
        )

    allocation.sort(key=lambda item: Decimal(item["market_value"]), reverse=True)
    result_by_class.sort(key=lambda item: abs(Decimal(item["unrealized_result"])), reverse=True)

    summary_values = {
        "market_value": market_total,
        "cost_basis": cost_total,
        "unrealized_result": market_total - cost_total,
        "unrealized_result_pct": (market_total - cost_total) / cost_total * Decimal("100") if cost_total else ZERO,
    }
    return summary_values, allocation, result_by_class, missing_labels, fallback_amount, fallback_count


def _build_equity_curve(
    grouped_records: dict[int, list[EventRecord]],
    months: list[str],
    price_lookup: dict[tuple[int, str], PricePoint],
) -> list[dict[str, Any]]:
    all_events = sorted(
        (event for records in grouped_records.values() for event in records),
        key=lambda event: (event.event_date, event.sequence_num),
    )
    result = []
    for month in months:
        cutoff = _month_end(month)
        market_total = ZERO
        cost_total = ZERO
        missing_count = 0
        net_contributions = sum((_cash_flow(event) for event in all_events if event.event_date <= cutoff), ZERO)

        for asset_id, records in grouped_records.items():
            state = _replay([event for event in records if event.event_date <= cutoff])
            if state.quantity <= ZERO:
                continue
            market_value, used_fallback = _market_value_for_state(state, price_lookup.get((asset_id, month)))
            market_total += market_value
            cost_total += state.total_cost
            if used_fallback:
                missing_count += 1

        result.append(
            {
                "year_month": month,
                "market_value": _money(market_total),
                "cost_basis": _money(cost_total),
                "net_contributions": _money(net_contributions),
                "uses_cost_fallback": missing_count > 0,
                "missing_quote_count": missing_count,
            }
        )
    return result


def _income_12m(
    conn: sqlite3.Connection,
    portfolio_id: int,
    asset_class: str | None,
    today: dt.date,
) -> tuple[Decimal, list[dict[str, str]]]:
    end_month = _month_key(today)
    start_year, start_month_num = _add_months(today.year, today.month, -11)
    start_month = f"{start_year:04d}-{start_month_num:02d}"
    months = _month_range(start_month, end_month)
    totals: dict[str, Decimal] = defaultdict(Decimal)

    conditions = ["i.portfolio_id = ?", "i.status NOT LIKE 'ledger_%'", "i.payment_date >= ?", "i.payment_date <= ?"]
    params: list[Any] = [portfolio_id, _month_start(start_month), _month_end(end_month)]
    if asset_class:
        conditions.append("a.asset_class = ?")
        params.append(asset_class)

    rows = conn.execute(
        f"""
        SELECT i.payment_date, i.net_value
        FROM b3_income_events i
        LEFT JOIN assets a ON a.id = i.asset_id
        WHERE {" AND ".join(conditions)}
        """,
        params,
    ).fetchall()
    for row in rows:
        totals[_month_key(row["payment_date"])] += _d(row["net_value"])

    total = sum(totals.values(), ZERO)
    return total, [{"year_month": month, "amount": _money(totals[month])} for month in months]


def get_dashboard(
    conn: sqlite3.Connection,
    portfolio_id: int,
    period: str = "12m",
    asset_class: str | None = None,
    grouping: str = "monthly",
) -> dict[str, Any]:
    if period not in PERIODS:
        raise ValueError("Período inválido.")
    if grouping != "monthly":
        raise ValueError("Agrupamento inválido.")

    today = date.today()
    latest_quote_month, latest_quote_date = _latest_quote_info(conn, portfolio_id, asset_class)
    end_month = latest_quote_month or _month_key(today)
    start_month = _period_start_month(period, end_month, conn, portfolio_id, asset_class)
    months = _month_range(start_month, end_month)
    period_start = None if period == "all" else _month_start(start_month)
    period_end = _month_end(end_month)

    classes = _asset_classes(conn, portfolio_id)
    positions = _current_positions(conn, portfolio_id, asset_class)
    active_asset_ids = [position["asset_id"] for position in positions if _d(position["quantity"]) > ZERO]
    current_price_lookup = _price_lookup(
        conn,
        portfolio_id,
        [latest_quote_month] if latest_quote_month else [],
        active_asset_ids,
    )
    summary_values, allocation, result_by_class, missing_labels, fallback_amount, fallback_count = _build_current_snapshot(
        positions,
        current_price_lookup,
        latest_quote_month,
    )

    rows = _event_rows(conn, portfolio_id, asset_class)
    grouped = _records_by_asset(rows)
    asset_ids = sorted(grouped)
    price_lookup = _price_lookup(conn, portfolio_id, months, asset_ids)
    equity_curve = _build_equity_curve(grouped, months, price_lookup)
    realized_result = _realized_result(grouped, period_start, period_end)
    income_total, income_series = _income_12m(conn, portfolio_id, asset_class, today)

    market_value = summary_values["market_value"]
    cost_basis = summary_values["cost_basis"]
    unrealized_result = summary_values["unrealized_result"]

    return {
        "portfolio_id": portfolio_id,
        "filters": {
            "portfolio_id": portfolio_id,
            "period": period,
            "asset_class": asset_class,
            "grouping": grouping,
            "asset_classes": classes,
        },
        "summary": {
            "market_value": _money(market_value),
            "market_value_month": latest_quote_month,
            "market_value_date": latest_quote_date,
            "market_value_uses_cost_fallback": fallback_count > 0,
            "market_value_cost_fallback_count": fallback_count,
            "market_value_cost_fallback_amount": _money(fallback_amount),
            "cost_basis": _money(cost_basis),
            "unrealized_result": _money(unrealized_result),
            "unrealized_result_pct": _percent(summary_values["unrealized_result_pct"]),
            "realized_result": _money(realized_result),
            "realized_result_period_start": period_start,
            "realized_result_period_end": period_end,
            "income_12m": _money(income_total),
            "income_12m_monthly_avg": _money(income_total / Decimal("12")),
        },
        "equity_curve": equity_curve,
        "allocation": allocation,
        "result_by_class": result_by_class,
        "income_series": income_series,
        "operational_alerts": {
            "missing_recent_quotes_count": fallback_count,
            "missing_recent_quotes_summary": missing_labels[:8],
            "last_b3_import_at": _last_b3_import_at(conn, portfolio_id),
            "latest_quote_month": latest_quote_month,
            "latest_quote_date": latest_quote_date,
            "no_events": len(rows) == 0,
            "no_quotes": latest_quote_month is None,
            "uses_cost_fallback": fallback_count > 0,
            "cost_fallback_amount": _money(fallback_amount),
        },
    }
