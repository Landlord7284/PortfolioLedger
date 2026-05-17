"""
PTAX lookup service backed by the Banco Central do Brasil OData API.
"""

from __future__ import annotations

import logging
import sqlite3
from contextlib import nullcontext
from datetime import date as Date, datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx

from backend.database import get_db

logger = logging.getLogger(__name__)

PTAX_URL = (
    "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/"
    "CotacaoDolarDia(dataCotacao=@dataCotacao)"
)


def _parse_date(value: str | Date) -> Date:
    if isinstance(value, Date):
        return value
    return datetime.strptime(value, "%Y-%m-%d").date()


def _cache_key(value: Date) -> str:
    return value.isoformat()


def _bcb_date(value: Date) -> str:
    return value.strftime("%m-%d-%Y")


def _month_key(value: Date) -> str:
    return value.strftime("%Y-%m")


def _month_start(value: Date) -> Date:
    return Date(value.year, value.month, 1)


def _next_month(value: Date) -> Date:
    if value.month == 12:
        return Date(value.year + 1, 1, 1)
    return Date(value.year, value.month + 1, 1)


def _last_day_of_month(value: Date) -> Date:
    return _next_month(value) - timedelta(days=1)


def _last_completed_month(today: Date | None = None) -> Date:
    base = today or Date.today()
    return _month_start(base) - timedelta(days=1)


def _fetch_ptax_from_bcb(value: Date) -> dict[str, Decimal] | None:
    response = httpx.get(
        PTAX_URL,
        params={"@dataCotacao": f"'{_bcb_date(value)}'", "$format": "json"},
        timeout=15,
    )
    response.raise_for_status()
    payload: dict[str, Any] = response.json()
    rows = payload.get("value") or []
    if not rows:
        return None

    row = rows[0]
    return {
        "compra": Decimal(str(row["cotacaoCompra"])),
        "venda": Decimal(str(row["cotacaoVenda"])),
    }


def get_ptax(date: str | Date, conn: sqlite3.Connection | None = None) -> dict[str, Decimal]:
    """
    Return PTAX compra/venda for date, falling back up to 7 calendar days.
    """
    result = get_ptax_with_date(date, conn=conn)
    return {"compra": result["compra"], "venda": result["venda"]}


def get_ptax_with_date(
    date: str | Date,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Decimal | Date]:
    """
    Return PTAX compra/venda and the effective date used after fallback.
    """
    requested_date = _parse_date(date)

    context = nullcontext(conn) if conn is not None else get_db()
    with context as active_conn:
        for offset in range(7):
            lookup_date = requested_date - timedelta(days=offset)
            key = _cache_key(lookup_date)
            cached = active_conn.execute(
                "SELECT compra, venda FROM ptax_cache WHERE date = ?",
                (key,),
            ).fetchone()
            if cached:
                return {
                    "date": lookup_date,
                    "compra": Decimal(str(cached["compra"])),
                    "venda": Decimal(str(cached["venda"])),
                }

            fetched = _fetch_ptax_from_bcb(lookup_date)
            if fetched is None:
                continue

            active_conn.execute(
                """
                INSERT INTO ptax_cache (date, compra, venda)
                VALUES (?, ?, ?)
                ON CONFLICT(date) DO UPDATE SET
                    compra = excluded.compra,
                    venda = excluded.venda
                """,
                (key, float(fetched["compra"]), float(fetched["venda"])),
            )
            return {
                "date": lookup_date,
                "compra": fetched["compra"],
                "venda": fetched["venda"],
            }

    raise ValueError(
        f"PTAX nao encontrada para {requested_date.isoformat()} "
        "nem nos 6 dias anteriores."
    )


def get_ptax_primeira_quinzena_mes_anterior(
    date: str | Date,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Decimal]:
    """
    Return PTAX for the last business day in the first half of previous month.
    """
    base = _parse_date(date)
    if base.month == 1:
        target = Date(base.year - 1, 12, 15)
    else:
        target = Date(base.year, base.month - 1, 15)
    return get_ptax(target, conn=conn)


def _first_us_event_date(conn: sqlite3.Connection) -> Date | None:
    row = conn.execute(
        """
        SELECT MIN(e.event_date) AS first_date
        FROM events e
        JOIN assets a ON a.id = e.asset_id
        WHERE (a.market = 'US' OR a.currency = 'USD')
          AND e.is_cancelled = 0
          AND e.is_storno = 0
        """
    ).fetchone()
    if not row or not row["first_date"]:
        return None
    return _parse_date(row["first_date"])


def _missing_month_ends(
    conn: sqlite3.Connection,
    first_date: Date,
    today: Date | None = None,
) -> list[Date]:
    last_completed = _last_completed_month(today)
    current = _month_start(first_date)
    months = []
    while current <= _month_start(last_completed):
        reference_month = _month_key(current)
        exists = conn.execute(
            "SELECT 1 FROM ptax_monthly_cache WHERE reference_month = ?",
            (reference_month,),
        ).fetchone()
        if not exists:
            months.append(_last_day_of_month(current))
        current = _next_month(current)
    return months


def warm_ptax_monthly_cache(
    conn: sqlite3.Connection,
    today: Date | None = None,
    source: str = "startup",
) -> dict[str, int]:
    """
    Cache PTAX venda for missing completed months since the first US event.
    """
    first_date = _first_us_event_date(conn)
    if first_date is None:
        return {"created": 0, "failed": 0}

    created = 0
    failed = 0
    for month_end in _missing_month_ends(conn, first_date, today=today):
        reference_month = _month_key(month_end)
        try:
            rates = get_ptax_with_date(month_end, conn=conn)
            ptax_date = rates["date"]
            conn.execute(
                """
                INSERT INTO ptax_monthly_cache (reference_month, ptax_date, venda, source)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(reference_month) DO UPDATE SET
                    ptax_date = excluded.ptax_date,
                    venda = excluded.venda,
                    source = excluded.source,
                    updated_at = datetime('now')
                """,
                (
                    reference_month,
                    ptax_date.isoformat() if isinstance(ptax_date, Date) else str(ptax_date),
                    str(rates["venda"]),
                    source,
                ),
            )
            created += 1
        except Exception as exc:
            failed += 1
            logger.warning("Failed to cache monthly PTAX for %s: %s", reference_month, exc)

    return {"created": created, "failed": failed}
