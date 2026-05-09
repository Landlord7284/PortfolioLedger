"""
SQLite database initialisation and connection management.

All financial values are stored as TEXT (canonical decimal with '.' separator)
and converted to ``decimal.Decimal`` in the domain layer.
"""

import sqlite3
from pathlib import Path
from contextlib import contextmanager

DB_PATH = Path(__file__).resolve().parent / "ledger.db"

_SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ────────────────────────────────────────────────────────────
-- Portfolios
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS portfolios (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL UNIQUE,
    consolidated  INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ────────────────────────────────────────────────────────────
-- Assets (asset_id is the immutable internal key)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_class   TEXT    NOT NULL,
    currency      TEXT    NOT NULL DEFAULT 'BRL',
    maturity_date TEXT,
    aux_id        TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ────────────────────────────────────────────────────────────
-- Ticker history  (allows ticker changes without breaking the ledger)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS asset_tickers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id    INTEGER NOT NULL REFERENCES assets(id),
    ticker      TEXT    NOT NULL,
    name        TEXT,
    valid_from  TEXT    NOT NULL,
    valid_until TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_asset_tickers_lookup
    ON asset_tickers(ticker, valid_from);

-- ────────────────────────────────────────────────────────────
-- Event ledger  (source of truth)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id    INTEGER NOT NULL REFERENCES portfolios(id),
    asset_id        INTEGER NOT NULL REFERENCES assets(id),
    event_type      TEXT    NOT NULL,
    event_date      TEXT    NOT NULL,
    quantity        TEXT    NOT NULL,
    event_value     TEXT    NOT NULL,
    sequence_num    INTEGER NOT NULL,
    storno_of       INTEGER REFERENCES events(id),
    correction_of   INTEGER REFERENCES events(id),
    is_storno       INTEGER NOT NULL DEFAULT 0,
    is_cancelled    INTEGER NOT NULL DEFAULT 0,
    notes           TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_asset_portfolio
    ON events(asset_id, portfolio_id, event_date, sequence_num);

-- ────────────────────────────────────────────────────────────
-- Materialised position cache  (derived from ledger)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS positions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id      INTEGER NOT NULL REFERENCES portfolios(id),
    asset_id          INTEGER NOT NULL REFERENCES assets(id),
    quantity          TEXT    NOT NULL DEFAULT '0',
    total_cost        TEXT    NOT NULL DEFAULT '0',
    average_price     TEXT    NOT NULL DEFAULT '0',
    realized_result   TEXT    NOT NULL DEFAULT '0',
    last_event_date   TEXT,
    updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(portfolio_id, asset_id)
);

-- ────────────────────────────────────────────────────────────
-- Sequence counter for stable event ordering
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sequence_counter (
    id    INTEGER PRIMARY KEY CHECK (id = 1),
    value INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO sequence_counter (id, value) VALUES (1, 0);
"""


def _get_connection(db_path: Path | str | None = None) -> sqlite3.Connection:
    """Return a new connection with recommended pragmas enabled."""
    path = str(db_path or DB_PATH)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db(db_path: Path | str | None = None) -> None:
    """Create all tables if they don't exist."""
    conn = _get_connection(db_path)
    try:
        conn.executescript(_SCHEMA)
        conn.commit()
    finally:
        conn.close()


@contextmanager
def get_db(db_path: Path | str | None = None):
    """Context manager that yields a connection and commits on success."""
    conn = _get_connection(db_path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def next_sequence(conn: sqlite3.Connection) -> int:
    """Atomically increment and return the next sequence number."""
    conn.execute("UPDATE sequence_counter SET value = value + 1 WHERE id = 1")
    row = conn.execute("SELECT value FROM sequence_counter WHERE id = 1").fetchone()
    return row["value"]
