"""Read-side service for B3 income events used by the Proventos page."""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
import sqlite3
from typing import Any

from backend.services import event_service


PERIODS = {"year", "12m", "24m", "36m", "all"}
CHART_GROUPS = {"asset", "asset_class", "event_type"}
MONEY = Decimal("0.01")


def _to_decimal(value: Any) -> Decimal:
    if value in (None, ""):
        return Decimal("0")
    return Decimal(str(value))


def _money(value: Decimal) -> str:
    return str(value.quantize(MONEY, rounding=ROUND_HALF_UP))


def _month_key(value: str) -> str:
    return value[:7]


def _add_months(year: int, month: int, delta: int) -> tuple[int, int]:
    total = year * 12 + (month - 1) + delta
    return total // 12, total % 12 + 1


def _month_count(start_month: str, end_month: str) -> int:
    sy, sm = (int(part) for part in start_month.split("-"))
    ey, em = (int(part) for part in end_month.split("-"))
    return max(1, (ey - sy) * 12 + em - sm + 1)


def _month_range(start_month: str, end_month: str) -> list[str]:
    count = _month_count(start_month, end_month)
    year, month = (int(part) for part in start_month.split("-"))
    return [f"{y:04d}-{m:02d}" for y, m in (_add_months(year, month, index) for index in range(count))]


def _period_bounds(conn: sqlite3.Connection, portfolio_id: int, period: str, today: date | None = None) -> tuple[str, str, int]:
    if period not in PERIODS:
        raise ValueError("Período inválido.")

    today = today or date.today()
    end_month = f"{today.year:04d}-{today.month:02d}"
    if period == "year":
        start_month = f"{today.year:04d}-01"
    elif period == "all":
        row = conn.execute(
            "SELECT MIN(payment_date) AS first_date FROM b3_income_events WHERE portfolio_id = ?",
            (portfolio_id,),
        ).fetchone()
        first_date = row["first_date"] if row else None
        start_month = _month_key(first_date) if first_date else f"{today.year:04d}-01"
    else:
        months = int(period.removesuffix("m"))
        start_year, start_month_num = _add_months(today.year, today.month, -(months - 1))
        start_month = f"{start_year:04d}-{start_month_num:02d}"

    month_count = _month_count(start_month, end_month)
    return f"{start_month}-01", f"{end_month}-31", month_count


def _income_rows(
    conn: sqlite3.Connection,
    portfolio_id: int,
    start_date: str | None = None,
    end_date: str | None = None,
    asset_id: int | None = None,
    asset_class: str | None = None,
    event_type: str | None = None,
    table_year: int | None = None,
    table_month: int | None = None,
) -> list[sqlite3.Row]:
    conditions = ["i.portfolio_id = ?", "i.status NOT LIKE 'ledger_%'", "i.status != 'discarded'"]
    params: list[Any] = [portfolio_id]
    if start_date:
        conditions.append("i.payment_date >= ?")
        params.append(start_date)
    if end_date:
        conditions.append("i.payment_date <= ?")
        params.append(end_date)
    if asset_id:
        conditions.append("i.asset_id = ?")
        params.append(asset_id)
    if asset_class:
        if asset_class in {"CRI", "CRA"}:
            conditions.append("(a.asset_class = ? OR (a.asset_class IS NULL AND UPPER(i.product) LIKE ?))")
            params.extend([asset_class, f"{asset_class} - %"])
        else:
            conditions.append("a.asset_class = ?")
            params.append(asset_class)
    if event_type:
        conditions.append("i.event_type = ?")
        params.append(event_type)
    if table_year:
        conditions.append("strftime('%Y', i.payment_date) = ?")
        params.append(str(table_year))
    if table_month:
        conditions.append("strftime('%m', i.payment_date) = ?")
        params.append(f"{table_month:02d}")

    return conn.execute(
        f"""
        SELECT
            i.id,
            i.asset_id,
            i.payment_date,
            i.event_type,
            i.product,
            i.ticker,
            i.quantity,
            i.unit_price,
            i.net_value,
            i.status,
            i.raw_payload,
            a.asset_class,
            a.name AS asset_name,
            (
                SELECT t.ticker
                FROM asset_tickers t
                WHERE t.asset_id = i.asset_id AND t.valid_until IS NULL
                ORDER BY t.valid_from DESC NULLS FIRST, t.id DESC
                LIMIT 1
            ) AS current_ticker,
            (
                SELECT t.name
                FROM asset_tickers t
                WHERE t.asset_id = i.asset_id AND t.valid_until IS NULL
                ORDER BY t.valid_from DESC NULLS FIRST, t.id DESC
                LIMIT 1
            ) AS current_name
        FROM b3_income_events i
        LEFT JOIN assets a ON a.id = i.asset_id
        WHERE {" AND ".join(conditions)}
        ORDER BY i.payment_date ASC, i.id ASC
        """,
        params,
    ).fetchall()


def _display_ticker(row: sqlite3.Row) -> str | None:
    return row["current_ticker"] or row["ticker"]


def _display_name(row: sqlite3.Row) -> str | None:
    return row["asset_name"] or row["current_name"] or row["product"]


def _display_asset_class(row: sqlite3.Row) -> str | None:
    if row["asset_class"]:
        return row["asset_class"]
    product = row["product"] or ""
    prefix = product.split(" - ", 1)[0].strip().upper()
    if prefix in {"CRI", "CRA"}:
        return prefix
    return None


def _event_label(row: sqlite3.Row) -> str:
    ticker = _display_ticker(row)
    if ticker:
        return ticker
    return _display_name(row) or "Sem ativo"


def _segment_key(row: sqlite3.Row, chart_group_by: str) -> str:
    if chart_group_by == "asset":
        return _event_label(row)
    if chart_group_by == "asset_class":
        return _display_asset_class(row) or "Sem classe"
    return row["event_type"] or "Sem tipo"


def _table_row(conn: sqlite3.Connection, portfolio_id: int, row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "asset_id": row["asset_id"],
        "ticker": _display_ticker(row),
        "name": _display_name(row),
        "asset_class": _display_asset_class(row),
        "payment_date": row["payment_date"],
        "event_type": row["event_type"],
        "quantity": row["quantity"] or "0",
        "net_value": _money(_to_decimal(row["net_value"])),
        "yoc": event_service.income_yield_on_cost(
            conn,
            portfolio_id,
            row["asset_id"],
            row["payment_date"],
            row["net_value"],
        ),
        "status": row["status"],
    }


def _available_filters(rows: list[sqlite3.Row]) -> dict[str, list[dict[str, Any]] | list[str]]:
    assets: dict[int, dict[str, Any]] = {}
    classes: set[str] = set()
    types: set[str] = set()
    for row in rows:
        if row["asset_id"]:
            assets[row["asset_id"]] = {
                "asset_id": row["asset_id"],
                "ticker": _display_ticker(row),
                "name": _display_name(row),
                "asset_class": row["asset_class"],
            }
        asset_class = _display_asset_class(row)
        if asset_class:
            classes.add(asset_class)
        if row["event_type"]:
            types.add(row["event_type"])
    return {
        "assets": sorted(assets.values(), key=lambda item: (item.get("ticker") or "", item["asset_id"])),
        "asset_classes": sorted(classes),
        "event_types": sorted(types),
    }


def _table_options(rows: list[sqlite3.Row]) -> tuple[list[dict[str, Any]], int | None, int | None]:
    by_year: dict[int, set[int]] = defaultdict(set)
    latest_month: str | None = None
    for row in rows:
        month = _month_key(row["payment_date"])
        latest_month = month if latest_month is None or month > latest_month else latest_month
        year, month_num = (int(part) for part in month.split("-"))
        by_year[year].add(month_num)

    years = [
        {"year": year, "months": sorted(months, reverse=True)}
        for year, months in sorted(by_year.items(), reverse=True)
    ]
    if not latest_month:
        return years, None, None
    default_year, default_month = (int(part) for part in latest_month.split("-"))
    return years, default_year, default_month


def _chart(rows: list[sqlite3.Row], start_date: str, end_date: str, chart_group_by: str) -> dict[str, Any]:
    start_month = _month_key(start_date)
    end_month = _month_key(end_date)
    monthly_totals: dict[str, Decimal] = defaultdict(Decimal)
    monthly_segments: dict[str, dict[str, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
    monthly_events: dict[str, list[sqlite3.Row]] = defaultdict(list)

    for row in rows:
        month = _month_key(row["payment_date"])
        value = _to_decimal(row["net_value"])
        monthly_totals[month] += value
        monthly_segments[month][_segment_key(row, chart_group_by)] += value
        monthly_events[month].append(row)

    segment_names = sorted({name for segments in monthly_segments.values() for name in segments})
    months = []
    for month in _month_range(start_month, end_month):
        total = monthly_totals[month]
        top_rows = sorted(monthly_events[month], key=lambda item: _to_decimal(item["net_value"]), reverse=True)[:5]
        months.append(
            {
                "month": month,
                "total_net_value": _money(total),
                "segments": [
                    {"key": name, "value": _money(monthly_segments[month].get(name, Decimal("0")))}
                    for name in segment_names
                ],
                "top_events": [
                    {
                        "label": _event_label(row),
                        "name": _display_name(row),
                        "event_type": row["event_type"],
                        "value": _money(_to_decimal(row["net_value"])),
                        "share": _money((_to_decimal(row["net_value"]) / total * Decimal("100")) if total else Decimal("0")),
                    }
                    for row in top_rows
                ],
            }
        )
    return {"segment_keys": segment_names, "months": months}


def _metadata(conn: sqlite3.Connection, portfolio_id: int) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT
            MAX(m.updated_at) AS data_updated_at,
            MAX(m.reference_month) AS latest_b3_file_reference
        FROM b3_monthly_imports m
        WHERE m.portfolio_id = ?
          AND EXISTS (
              SELECT 1
              FROM b3_income_events i
              WHERE i.import_id = m.id
          )
        """,
        (portfolio_id,),
    ).fetchone()
    pending_row = conn.execute(
        """
        SELECT COUNT(*) AS count
        FROM b3_income_events
        WHERE portfolio_id = ?
          AND status = 'review'
        """,
        (portfolio_id,),
    ).fetchone()
    return {
        "data_updated_at": row["data_updated_at"] if row else None,
        "latest_b3_file_reference": row["latest_b3_file_reference"] if row else None,
        "pending_review_count": pending_row["count"] if pending_row else 0,
    }


def list_b3_incomes(
    conn: sqlite3.Connection,
    portfolio_id: int,
    period: str = "year",
    asset_id: int | None = None,
    asset_class: str | None = None,
    event_type: str | None = None,
    chart_group_by: str = "asset_class",
    table_year: int | None = None,
    table_month: int | None = None,
    table_asset_class: str | None = None,
    table_asset_id: int | None = None,
    table_event_type: str | None = None,
    use_default_table_period: bool = True,
) -> dict[str, Any]:
    if chart_group_by not in CHART_GROUPS:
        raise ValueError("Agrupamento do grafico invalido.")

    start_date, end_date, month_count = _period_bounds(conn, portfolio_id, period)
    period_rows = _income_rows(conn, portfolio_id, start_date=start_date, end_date=end_date)
    chart_rows = _income_rows(
        conn,
        portfolio_id,
        start_date=start_date,
        end_date=end_date,
        asset_id=asset_id,
        asset_class=asset_class,
        event_type=event_type,
    )
    all_rows = _income_rows(conn, portfolio_id)
    years, default_year, default_month = _table_options(all_rows)
    selected_year = table_year
    selected_month = table_month
    if use_default_table_period and selected_year is None and selected_month is None:
        selected_year = default_year
        selected_month = default_month
    table_rows = _income_rows(
        conn,
        portfolio_id,
        asset_id=table_asset_id,
        asset_class=table_asset_class,
        event_type=table_event_type,
        table_year=selected_year,
        table_month=selected_month,
    )

    total = sum((_to_decimal(row["net_value"]) for row in period_rows), Decimal("0"))
    table_total = sum((_to_decimal(row["net_value"]) for row in table_rows), Decimal("0"))
    filters = _available_filters(period_rows)
    filters.update(
        {
            "years": years,
            "default_year": default_year,
            "default_month": default_month,
        }
    )

    return {
        "portfolio_id": portfolio_id,
        "period": period,
        "summary": {
            "total_net_value": _money(total),
            "monthly_average": _money(total / Decimal(month_count)),
            "period_start": start_date,
            "period_end": end_date,
            "month_count": month_count,
        },
        "filters": filters,
        "chart": _chart(chart_rows, start_date, end_date, chart_group_by),
        "table": {
            "year": selected_year,
            "month": selected_month,
            "total_net_value": _money(table_total),
            "rows": [_table_row(conn, portfolio_id, row) for row in table_rows],
        },
        "metadata": _metadata(conn, portfolio_id),
    }
