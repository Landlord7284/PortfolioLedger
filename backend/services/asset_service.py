"""
Asset service — CRUD operations for assets and ticker history.

Each asset has an immutable ``asset_id``.  Tickers are temporal identifiers
stored in ``asset_tickers`` with validity ranges so that a ticker change
does not break the historical ledger.
"""

from __future__ import annotations

import sqlite3
from typing import Optional

from backend.domain.enums import AssetClass, Currency


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

def _attach_ticker_and_metadata(conn: sqlite3.Connection, d: dict) -> dict:
    """Attach current ticker info to an asset dict."""
    ticker_row = conn.execute(
        """
        SELECT ticker, name FROM asset_tickers
        WHERE asset_id = ? AND valid_until IS NULL
        ORDER BY valid_from DESC LIMIT 1
        """,
        (d["id"],),
    ).fetchone()
    d["current_ticker"] = ticker_row["ticker"] if ticker_row else None
    d["current_name"] = ticker_row["name"] if ticker_row else None
    return d


# ─────────────────────────────────────────────────────────────
# CRUD
# ─────────────────────────────────────────────────────────────

def create_asset(
    conn: sqlite3.Connection,
    asset_class: str,
    ticker: str,
    currency: str = "BRL",
    name: Optional[str] = None,
    maturity_date: Optional[str] = None,
    aux_id: Optional[str] = None,
    valid_from: Optional[str] = None,
    cnpj: Optional[str] = None,
    isin: Optional[str] = None,
    sector: Optional[str] = None,
    subsector: Optional[str] = None,
    segment: Optional[str] = None,
) -> dict:
    """Create a new asset with its initial ticker record."""
    # Validate enum
    ac = AssetClass(asset_class)
    Currency(currency)

    cur = conn.execute(
        """
        INSERT INTO assets (asset_class, currency, maturity_date, aux_id,
                            name, cnpj, isin, sector, subsector, segment)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (ac.value, currency, maturity_date, aux_id,
         name, cnpj, isin, sector, subsector, segment),
    )
    asset_id = cur.lastrowid

    # Create initial ticker
    conn.execute(
        """
        INSERT INTO asset_tickers (asset_id, ticker, name, valid_from)
        VALUES (?, ?, ?, ?)
        """,
        (asset_id, ticker.strip().upper(), name, valid_from or "1900-01-01"),
    )
    return get_asset(conn, asset_id)


def get_asset(conn: sqlite3.Connection, asset_id: int) -> dict | None:
    """Return asset with its current ticker."""
    row = conn.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    return _attach_ticker_and_metadata(conn, d)


def list_assets(
    conn: sqlite3.Connection,
    asset_class: Optional[str] = None,
) -> list[dict]:
    """List all assets, optionally filtered by class."""
    if asset_class:
        rows = conn.execute(
            "SELECT * FROM assets WHERE asset_class = ? ORDER BY id",
            (asset_class,),
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM assets ORDER BY id").fetchall()

    result = []
    for r in rows:
        d = dict(r)
        _attach_ticker_and_metadata(conn, d)
        result.append(d)
    return result


def search_assets(conn: sqlite3.Connection, query: str) -> list[dict]:
    """Search assets by ticker, name, cnpj, or isin (partial match)."""
    q = f"%{query.strip().upper()}%"

    # Search in tickers
    ticker_ids = conn.execute(
        """
        SELECT DISTINCT asset_id FROM asset_tickers
        WHERE UPPER(ticker) LIKE ? OR UPPER(COALESCE(name, '')) LIKE ?
        """,
        (q, q),
    ).fetchall()
    ids = set(r["asset_id"] for r in ticker_ids)

    # Also search in asset metadata
    meta_ids = conn.execute(
        """
        SELECT id FROM assets
        WHERE UPPER(COALESCE(name, '')) LIKE ?
           OR UPPER(COALESCE(cnpj, '')) LIKE ?
           OR UPPER(COALESCE(isin, '')) LIKE ?
        """,
        (q, q, q),
    ).fetchall()
    ids.update(r["id"] for r in meta_ids)

    if not ids:
        return []

    ids_list = list(ids)
    placeholders = ",".join("?" * len(ids_list))
    rows = conn.execute(
        f"SELECT * FROM assets WHERE id IN ({placeholders})", ids_list
    ).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        _attach_ticker_and_metadata(conn, d)
        result.append(d)
    return result


def update_asset_metadata(
    conn: sqlite3.Connection,
    asset_id: int,
    name: Optional[str] = None,
    maturity_date: Optional[str] = None,
    cnpj: Optional[str] = None,
    isin: Optional[str] = None,
    sector: Optional[str] = None,
    subsector: Optional[str] = None,
    segment: Optional[str] = None,
) -> dict | None:
    """Update metadata fields on an existing asset."""
    fields: list[str] = []
    values: list = []

    for col, val in [
        ("name", name),
        ("maturity_date", maturity_date),
        ("cnpj", cnpj),
        ("isin", isin),
        ("sector", sector),
        ("subsector", subsector),
        ("segment", segment),
    ]:
        if val is not None:
            fields.append(f"{col} = ?")
            values.append(val)

    if not fields:
        return get_asset(conn, asset_id)

    values.append(asset_id)
    conn.execute(
        f"UPDATE assets SET {', '.join(fields)} WHERE id = ?",
        values,
    )
    return get_asset(conn, asset_id)


def update_ticker(
    conn: sqlite3.Connection,
    asset_id: int,
    new_ticker: str,
    valid_from: str,
    name: Optional[str] = None,
) -> dict:
    """Register a ticker change for an asset."""
    # Close current ticker
    conn.execute(
        """
        UPDATE asset_tickers
        SET valid_until = ?
        WHERE asset_id = ? AND valid_until IS NULL
        """,
        (valid_from, asset_id),
    )
    # Insert new ticker
    conn.execute(
        """
        INSERT INTO asset_tickers (asset_id, ticker, name, valid_from)
        VALUES (?, ?, ?, ?)
        """,
        (asset_id, new_ticker.strip().upper(), name, valid_from),
    )
    return get_asset(conn, asset_id)


def resolve_ticker_to_asset_id(
    conn: sqlite3.Connection,
    ticker: str,
    event_date: str,
) -> int | None:
    """
    Resolve a ticker to an asset_id at a given date.

    Checks the ticker history to find which asset_id corresponded
    to the given ticker on the given date.
    """
    row = conn.execute(
        """
        SELECT asset_id FROM asset_tickers
        WHERE ticker = ?
          AND valid_from <= ?
          AND (valid_until IS NULL OR valid_until > ?)
        ORDER BY valid_from DESC
        LIMIT 1
        """,
        (ticker.strip().upper(), event_date, event_date),
    ).fetchone()
    return row["asset_id"] if row else None


def find_asset_by_ticker(conn: sqlite3.Connection, ticker: str) -> int | None:
    """Find asset_id by ticker (any period). Returns the most recent match."""
    row = conn.execute(
        """
        SELECT asset_id FROM asset_tickers
        WHERE ticker = ?
        ORDER BY valid_from DESC
        LIMIT 1
        """,
        (ticker.strip().upper(),),
    ).fetchone()
    return row["asset_id"] if row else None
