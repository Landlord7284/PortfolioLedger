"""
PTAX lookup service backed by the Banco Central do Brasil OData API.
"""

from __future__ import annotations

import sqlite3
from contextlib import nullcontext
from datetime import date as Date, datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx

from backend.database import get_db


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
            return fetched

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
