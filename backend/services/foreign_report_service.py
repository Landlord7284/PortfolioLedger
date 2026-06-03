"""Preparatory foreign income/result report service."""

from __future__ import annotations

from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP
import sqlite3

from backend.domain.enums import EventType


ZERO = Decimal("0")
CENTS = Decimal("0.01")


def _money(value: Decimal) -> str:
    return str(value.quantize(CENTS, rounding=ROUND_HALF_UP))


def _abs_decimal(value: str | None) -> Decimal:
    if value in (None, ""):
        return ZERO
    return abs(Decimal(value))


def _category_label(category: str, normalized_type: str | None) -> str | None:
    if category == "dividend":
        return "Dividendo"
    if category == "foreign_tax":
        return "Imposto pago no exterior"
    if category == "interest":
        return "Juros sobre caixa"
    if category == "ledger" and normalized_type == "cash_in_lieu":
        return EventType.VENDA_FRACAO.value
    return None


def _ptax_brl(conn: sqlite3.Connection, event_date: str, amount_usd: Decimal) -> tuple[Decimal | None, bool]:
    from backend.services.ptax_service import get_ptax

    try:
        ptax = get_ptax(event_date, conn=conn)
        return amount_usd * Decimal(str(ptax["venda"])), False
    except Exception:
        return None, True


def list_foreign_report(conn: sqlite3.Connection, portfolio_id: int, year: int) -> dict:
    start_date = f"{year}-01-01"
    end_date = f"{year}-12-31"
    rows = conn.execute(
        """
        SELECT
            t.*,
            e.event_value_brl,
            a.name,
            (
                SELECT ticker FROM asset_tickers
                WHERE asset_id = t.asset_id AND valid_until IS NULL
                ORDER BY valid_from DESC LIMIT 1
            ) AS current_ticker
        FROM schwab_transactions t
        LEFT JOIN events e ON e.id = t.ledger_event_id
        LEFT JOIN assets a ON a.id = t.asset_id
        WHERE t.portfolio_id = ?
          AND t.event_date BETWEEN ? AND ?
          AND t.status NOT IN ('duplicate', 'ignored', 'error', 'review')
          AND (
              t.normalized_category IN ('dividend', 'foreign_tax', 'interest')
              OR (t.normalized_category = 'ledger' AND t.normalized_type = 'cash_in_lieu')
          )
        ORDER BY t.event_date, t.asset_id, t.id
        """,
        (portfolio_id, start_date, end_date),
    ).fetchall()

    grouped: dict[tuple[str, str, int | None, str | None, str | None], dict] = {}
    missing_ptax_dates: set[str] = set()

    for row in rows:
        label = _category_label(row["normalized_category"], row["normalized_type"])
        if not label:
            continue
        amount_usd = _abs_decimal(row["amount"])
        if amount_usd == ZERO:
            continue
        if row["event_value_brl"] is not None and row["normalized_type"] == "cash_in_lieu":
            amount_brl = _abs_decimal(row["event_value_brl"])
            missing_ptax = False
        else:
            converted, missing_ptax = _ptax_brl(conn, row["event_date"], amount_usd)
            amount_brl = converted
        if missing_ptax:
            missing_ptax_dates.add(row["event_date"])

        month = row["event_date"][:7]
        key = (month, label, row["asset_id"], row["current_ticker"] or row["source_symbol"], row["name"])
        item = grouped.setdefault(
            key,
            {
                "month": month,
                "category": label,
                "asset_id": row["asset_id"],
                "ticker": row["current_ticker"] or row["source_symbol"],
                "name": row["name"],
                "amount_usd": ZERO,
                "amount_brl": ZERO,
                "missing_ptax": False,
            },
        )
        item["amount_usd"] += amount_usd
        if amount_brl is None:
            item["missing_ptax"] = True
        else:
            item["amount_brl"] += amount_brl

    result_rows = []
    totals: dict[str, dict[str, Decimal | bool]] = defaultdict(lambda: {"amount_usd": ZERO, "amount_brl": ZERO, "missing_ptax": False})
    for item in sorted(grouped.values(), key=lambda value: (value["month"], value["category"], value["ticker"] or "")):
        totals[item["category"]]["amount_usd"] += item["amount_usd"]
        totals[item["category"]]["amount_brl"] += item["amount_brl"]
        totals[item["category"]]["missing_ptax"] = bool(totals[item["category"]]["missing_ptax"] or item["missing_ptax"])
        result_rows.append(
            {
                "month": item["month"],
                "category": item["category"],
                "asset_id": item["asset_id"],
                "ticker": item["ticker"],
                "name": item["name"],
                "amount_usd": _money(item["amount_usd"]),
                "amount_brl": None if item["missing_ptax"] else _money(item["amount_brl"]),
                "missing_ptax": item["missing_ptax"],
            }
        )

    return {
        "portfolio_id": portfolio_id,
        "year": year,
        "rows": result_rows,
        "totals": [
            {
                "category": category,
                "amount_usd": _money(values["amount_usd"]),
                "amount_brl": None if values["missing_ptax"] else _money(values["amount_brl"]),
                "missing_ptax": bool(values["missing_ptax"]),
            }
            for category, values in sorted(totals.items())
        ],
        "missing_ptax_dates": sorted(missing_ptax_dates),
    }
