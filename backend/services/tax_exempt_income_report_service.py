"""
Reusable tax-exempt income report service.

The report is derived from existing fiscal read models and imported income
rows. It does not persist calculated report rows.
"""

from __future__ import annotations

from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP
import sqlite3
from typing import Any

from backend.domain.enums import AssetClass, B3IncomeEventStatus
from backend.services import capital_gain_report_service, report_service
from backend.services.fiscal_regime_service import REGIME_B3_COMMON, REGIME_FI_INFRA_EXEMPT


ZERO = Decimal("0")
CENTS = Decimal("0.01")

SOURCE_STOCK_EXEMPTION = "stock_sales_20k_exemption"
SOURCE_FI_INFRA = "fi_infra"

LABEL_STOCK_EXEMPTION = "Ganhos líquidos em operações no mercado à vista de ações"
LABEL_FI_INFRA = "FI-Infra"


def _money(value: Decimal) -> str:
    return str(value.quantize(CENTS, rounding=ROUND_HALF_UP))


def _d(value: Any) -> Decimal:
    if value in (None, ""):
        return ZERO
    return Decimal(str(value))


def _month_key(value: str) -> str:
    return value[:7]


def _source_event(
    *,
    event_id: int,
    event_date: str,
    source_event_type: str,
    amount: Decimal,
) -> dict:
    return {
        "event_id": event_id,
        "event_date": event_date,
        "source_event_type": source_event_type,
        "amount": _money(amount),
        "year_month": _month_key(event_date),
    }


def _empty_group(source: str, label: str) -> dict:
    return {
        "source": source,
        "label": label,
        "total": ZERO,
        "months": defaultdict(dict),
    }


def _asset_key(asset_id: int, source_event_type: str, year_month: str) -> tuple[int, str, str]:
    return (asset_id, source_event_type, year_month)


def _add_asset_amount(
    group: dict,
    *,
    asset_id: int,
    ticker: str | None,
    asset_class: str,
    fiscal_regime: str,
    amount: Decimal,
    event_date: str,
    source_event_type: str,
    source_event: dict,
) -> None:
    if amount <= ZERO:
        return

    year_month = _month_key(event_date)
    month = group["months"].setdefault(
        year_month,
        {
            "year_month": year_month,
            "month": int(year_month[-2:]),
            "total": ZERO,
            "assets": {},
        },
    )
    key = _asset_key(asset_id, source_event_type, year_month)
    asset = month["assets"].setdefault(
        key,
        {
            "asset_id": asset_id,
            "ticker": ticker,
            "asset_class": asset_class,
            "fiscal_regime": fiscal_regime,
            "amount": ZERO,
            "source_event_type": source_event_type,
            "year_month": year_month,
            "source_events": [],
        },
    )
    asset["amount"] += amount
    asset["source_events"].append(source_event)
    month["total"] += amount
    group["total"] += amount


def _format_group(group: dict) -> dict:
    months = []
    for month in sorted(group["months"].values(), key=lambda item: item["year_month"]):
        if month["total"] <= ZERO:
            continue
        assets = []
        for asset in sorted(month["assets"].values(), key=lambda item: (item["ticker"] or "", item["asset_id"], item["source_event_type"] or "")):
            source_events = sorted(asset["source_events"], key=lambda item: (item["event_date"], item["event_id"]))
            assets.append(
                {
                    **asset,
                    "amount": _money(asset["amount"]),
                    "source_events": source_events,
                }
            )
        months.append(
            {
                "year_month": month["year_month"],
                "month": month["month"],
                "total": _money(month["total"]),
                "assets": assets,
            }
        )

    return {
        "source": group["source"],
        "label": group["label"],
        "total": _money(group["total"]),
        "months": months,
    }


def _add_stock_exemptions(conn: sqlite3.Connection, portfolio_id: int, year: int, group: dict) -> None:
    report = capital_gain_report_service.list_capital_gains(conn, portfolio_id, year)
    for month in report["months"]:
        row = next((regime for regime in month["regimes"] if regime["regime"] == REGIME_B3_COMMON), None)
        if not row or _d(row["exempt_gain"]) <= ZERO:
            continue
        for asset in row["assets"]:
            amount = _d(asset["exempt_gain"])
            if amount <= ZERO or asset["asset_class"] != AssetClass.ACAO.value:
                continue
            source_events = asset.get("source_events") or [
                _source_event(
                    event_id=0,
                    event_date=f"{month['year_month']}-01",
                    source_event_type="capital_gain_sale",
                    amount=amount,
                )
            ]
            _add_asset_amount(
                group,
                asset_id=asset["asset_id"],
                ticker=asset["ticker"],
                asset_class=asset["asset_class"],
                fiscal_regime=asset["fiscal_regime"],
                amount=amount,
                event_date=f"{month['year_month']}-01",
                source_event_type="capital_gain_sale",
                source_event={
                    "event_id": source_events[0]["event_id"],
                    "event_date": source_events[0]["event_date"],
                    "source_event_type": "capital_gain_sale",
                    "amount": _money(amount),
                    "year_month": month["year_month"],
                },
            )
            group_asset = group["months"][month["year_month"]]["assets"][_asset_key(asset["asset_id"], "capital_gain_sale", month["year_month"])]
            group_asset["source_events"] = source_events


def _is_fi_infra_exempt(row: sqlite3.Row) -> bool:
    return capital_gain_report_service._resolve_regime(row) == REGIME_FI_INFRA_EXEMPT


def _add_fi_infra_capital_gains(conn: sqlite3.Connection, portfolio_id: int, year: int, group: dict) -> None:
    report = capital_gain_report_service.list_capital_gains(conn, portfolio_id, year)
    for month in report["months"]:
        row = next((regime for regime in month["regimes"] if regime["regime"] == REGIME_FI_INFRA_EXEMPT), None)
        if not row:
            continue
        for asset in row["assets"]:
            amount = _d(asset["exempt_gain"])
            if amount <= ZERO:
                amount = _d(asset["realized_result"])
            if amount <= ZERO:
                continue
            source_events = asset.get("source_events") or [
                _source_event(
                    event_id=0,
                    event_date=f"{month['year_month']}-01",
                    source_event_type="capital_gain_sale",
                    amount=amount,
                )
            ]
            _add_asset_amount(
                group,
                asset_id=asset["asset_id"],
                ticker=asset["ticker"],
                asset_class=asset["asset_class"],
                fiscal_regime=asset["fiscal_regime"],
                amount=amount,
                event_date=f"{month['year_month']}-01",
                source_event_type="capital_gain_sale",
                source_event={
                    "event_id": source_events[0]["event_id"],
                    "event_date": source_events[0]["event_date"],
                    "source_event_type": "capital_gain_sale",
                    "amount": _money(amount),
                    "year_month": month["year_month"],
                },
            )
            group_asset = group["months"][month["year_month"]]["assets"][_asset_key(asset["asset_id"], "capital_gain_sale", month["year_month"])]
            group_asset["source_events"] = source_events


def _add_fi_infra_ledger_incomes(conn: sqlite3.Connection, portfolio_id: int, year: int, group: dict) -> set[tuple[int, str, str, str]]:
    start_date = f"{year}-01-01"
    end_date = f"{year}-12-31"
    ledger_rules = [
        rule
        for rule in report_service.INCOME_TAX_RULES
        if rule["source"] in {"ledger", "ledger_b3"} and rule["table_key"] == "tax_exempt"
    ]
    ledger_types = sorted({rule["income_type"] for rule in ledger_rules})
    rows = conn.execute(
        f"""
        SELECT
            e.id,
            e.asset_id,
            e.event_type,
            e.event_date,
            e.event_value,
            e.event_value_brl,
            e.duplicate_flag,
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
          AND e.event_date BETWEEN ? AND ?
          AND e.is_cancelled = 0
          AND e.is_storno = 0
          AND a.merged_into_asset_id IS NULL
          AND e.event_type IN ({",".join("?" for _ in ledger_types)})
        ORDER BY current_ticker, e.event_date, e.sequence_num
        """,
        (portfolio_id, start_date, end_date, *ledger_types),
    ).fetchall()

    rows_by_income_key = defaultdict(list)
    for row in rows:
        if not _is_fi_infra_exempt(row):
            continue
        rule = report_service.INCOME_RULE_BY_ALIAS.get(report_service._norm_label(row["event_type"]))
        if not rule or rule["table_key"] != "tax_exempt":
            continue
        amount = report_service._event_brl_value(row)
        income_key = (row["asset_id"], report_service._norm_label(rule["income_type"]), row["event_date"], _money(amount))
        rows_by_income_key[income_key].append((row, rule, amount))

    active_income_keys = set()
    for income_key, keyed_rows in rows_by_income_key.items():
        active_income_keys.add(income_key)
        row, rule, amount = next(
            ((candidate, candidate_rule, candidate_amount) for candidate, candidate_rule, candidate_amount in keyed_rows if not candidate["duplicate_flag"]),
            keyed_rows[0],
        )
        _add_asset_amount(
            group,
            asset_id=row["asset_id"],
            ticker=row["current_ticker"],
            asset_class=row["asset_class"],
            fiscal_regime=REGIME_FI_INFRA_EXEMPT,
            amount=amount,
            event_date=row["event_date"],
            source_event_type=f"ledger:{rule['income_type']}",
            source_event=_source_event(
                event_id=row["id"],
                event_date=row["event_date"],
                source_event_type=f"ledger:{rule['income_type']}",
                amount=amount,
            ),
        )
    return active_income_keys


def _add_fi_infra_b3_incomes(
    conn: sqlite3.Connection,
    portfolio_id: int,
    year: int,
    group: dict,
    active_ledger_income_keys: set[tuple[int, str, str, str]],
) -> None:
    start_date = f"{year}-01-01"
    end_date = f"{year}-12-31"
    rows = conn.execute(
        """
        SELECT
            i.id,
            i.asset_id,
            i.payment_date,
            i.event_type,
            i.ticker,
            i.net_value,
            a.asset_class,
            a.market,
            a.currency,
            a.fiscal_regime_override,
            a.fiscal_tax_treatment,
            (
                SELECT ticker
                FROM asset_tickers
                WHERE asset_id = i.asset_id
                  AND valid_until IS NULL
                ORDER BY valid_from DESC
                LIMIT 1
            ) AS current_ticker
        FROM b3_income_events i
        JOIN assets a ON a.id = i.asset_id
        WHERE i.portfolio_id = ?
          AND i.payment_date BETWEEN ? AND ?
          AND i.asset_id IS NOT NULL
          AND i.status != ?
          AND i.ledger_event_id IS NULL
          AND a.merged_into_asset_id IS NULL
        ORDER BY current_ticker, i.payment_date, i.id
        """,
        (portfolio_id, start_date, end_date, B3IncomeEventStatus.REVIEW.value),
    ).fetchall()

    for row in rows:
        if not _is_fi_infra_exempt(row):
            continue
        rule = report_service.INCOME_RULE_BY_ALIAS.get(report_service._norm_label(row["event_type"]))
        if not rule or rule["table_key"] != "tax_exempt" or rule["source"] == "ledger":
            continue
        amount = _d(row["net_value"])
        income_key = (row["asset_id"], report_service._norm_label(rule["income_type"]), row["payment_date"], _money(amount))
        if income_key in active_ledger_income_keys:
            continue
        _add_asset_amount(
            group,
            asset_id=row["asset_id"],
            ticker=row["current_ticker"] or row["ticker"],
            asset_class=row["asset_class"],
            fiscal_regime=REGIME_FI_INFRA_EXEMPT,
            amount=amount,
            event_date=row["payment_date"],
            source_event_type=f"b3:{rule['income_type']}",
            source_event=_source_event(
                event_id=row["id"],
                event_date=row["payment_date"],
                source_event_type=f"b3:{rule['income_type']}",
                amount=amount,
            ),
        )


def list_tax_exempt_income(conn: sqlite3.Connection, portfolio_id: int, year: int) -> dict:
    stock_group = _empty_group(SOURCE_STOCK_EXEMPTION, LABEL_STOCK_EXEMPTION)
    fi_infra_group = _empty_group(SOURCE_FI_INFRA, LABEL_FI_INFRA)

    _add_stock_exemptions(conn, portfolio_id, year, stock_group)
    _add_fi_infra_capital_gains(conn, portfolio_id, year, fi_infra_group)
    active_ledger_income_keys = _add_fi_infra_ledger_incomes(conn, portfolio_id, year, fi_infra_group)
    _add_fi_infra_b3_incomes(conn, portfolio_id, year, fi_infra_group, active_ledger_income_keys)

    groups = [_format_group(stock_group), _format_group(fi_infra_group)]
    total = sum((_d(group["total"]) for group in groups), ZERO)
    return {
        "portfolio_id": portfolio_id,
        "year": year,
        "total": _money(total),
        "groups": groups,
    }
