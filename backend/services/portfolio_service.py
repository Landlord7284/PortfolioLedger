"""
Portfolio service — CRUD operations for portfolios.
"""

from __future__ import annotations

import sqlite3
from typing import Optional

from backend.domain.normalization import normalize_bool_01


def create_portfolio(
    conn: sqlite3.Connection,
    name: str,
    consolidated: bool = True,
) -> dict:
    """Insert a new portfolio and return its row."""
    cur = conn.execute(
        """
        INSERT INTO portfolios (name, consolidated)
        VALUES (?, ?)
        """,
        (name.strip(), normalize_bool_01(consolidated)),
    )
    return get_portfolio(conn, cur.lastrowid)


def get_portfolio(conn: sqlite3.Connection, portfolio_id: int) -> dict | None:
    row = conn.execute(
        "SELECT * FROM portfolios WHERE id = ?", (portfolio_id,)
    ).fetchone()
    return dict(row) if row else None


def list_portfolios(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM portfolios ORDER BY name"
    ).fetchall()
    return [dict(r) for r in rows]


def update_portfolio(
    conn: sqlite3.Connection,
    portfolio_id: int,
    name: Optional[str] = None,
    consolidated: Optional[bool] = None,
) -> dict | None:
    fields: list[str] = []
    values: list = []
    if name is not None:
        fields.append("name = ?")
        values.append(name.strip())
    if consolidated is not None:
        fields.append("consolidated = ?")
        values.append(normalize_bool_01(consolidated))
    if not fields:
        return get_portfolio(conn, portfolio_id)
    fields.append("updated_at = datetime('now')")
    values.append(portfolio_id)
    conn.execute(
        f"UPDATE portfolios SET {', '.join(fields)} WHERE id = ?",
        values,
    )
    return get_portfolio(conn, portfolio_id)


def delete_portfolio(conn: sqlite3.Connection, portfolio_id: int) -> bool:
    """Delete a portfolio and cascade delete its events and positions."""
    conn.execute("DELETE FROM positions WHERE portfolio_id = ?", (portfolio_id,))
    conn.execute("DELETE FROM events WHERE portfolio_id = ?", (portfolio_id,))
    cur = conn.execute("DELETE FROM portfolios WHERE id = ?", (portfolio_id,))
    return cur.rowcount > 0
