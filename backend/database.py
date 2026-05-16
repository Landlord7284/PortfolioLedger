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
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_class     TEXT    NOT NULL,
    market          TEXT    NOT NULL DEFAULT 'BR',
    currency        TEXT    NOT NULL DEFAULT 'BRL',
    maturity_date   TEXT,
    aux_id          TEXT,
    -- Metadata fields (v1.0.1)
    name            TEXT,
    cnpj            TEXT,
    isin            TEXT,
    sector          TEXT,
    subsector       TEXT,
    segment         TEXT,
    merged_into_asset_id INTEGER REFERENCES assets(id),
    merged_at       TEXT,
    duplicate_flag  INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ────────────────────────────────────────────────────────────
-- Ticker history  (allows ticker changes without breaking the ledger)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS asset_tickers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id    INTEGER NOT NULL REFERENCES assets(id),
    ticker      TEXT    NOT NULL,
    name        TEXT,
    valid_from  TEXT,
    valid_until TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_asset_tickers_lookup
    ON asset_tickers(ticker, valid_from, valid_until);

-- ────────────────────────────────────────────────────────────
-- Asset matching review queue
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS asset_match_reviews (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    source              TEXT    NOT NULL,
    ticker              TEXT    NOT NULL,
    asset_class         TEXT    NOT NULL,
    market              TEXT,
    event_date          TEXT,
    candidate_asset_ids TEXT,
    reason              TEXT,
    operation_payload   TEXT,
    status              TEXT    NOT NULL DEFAULT 'pending',
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    resolved_at         TEXT
);

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
    event_value_brl TEXT,
    gross_value     TEXT,
    gross_value_brl TEXT,
    ptax_compra     TEXT,
    ptax_venda      TEXT,
    sequence_num    INTEGER NOT NULL,
    storno_of       INTEGER REFERENCES events(id),
    correction_of   INTEGER REFERENCES events(id),
    is_storno       INTEGER NOT NULL DEFAULT 0,
    is_cancelled    INTEGER NOT NULL DEFAULT 0,
    duplicate_flag  INTEGER NOT NULL DEFAULT 0,
    notes           TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_asset_portfolio
    ON events(asset_id, portfolio_id, event_date, sequence_num);

-- PTAX cache
CREATE TABLE IF NOT EXISTS ptax_cache (
    date    TEXT PRIMARY KEY,
    compra  REAL NOT NULL,
    venda   REAL NOT NULL
);

-- Fiscal lots for USD assets
CREATE TABLE IF NOT EXISTS fiscal_lots (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id          INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    asset_id              INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    event_id              INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
    date                  TEXT    NOT NULL,
    quantity              TEXT    NOT NULL,
    price_usd             TEXT    NOT NULL,
    total_usd             TEXT    NOT NULL,
    origin_usd            TEXT    NOT NULL,
    origin_brl_usd        TEXT    NOT NULL,
    ptax_venda_acq        TEXT    NOT NULL,
    ptax_compra_acq       TEXT    NOT NULL,
    cost_brl_portion_brl  TEXT    NOT NULL,
    cost_usd_portion_usd  TEXT    NOT NULL,
    regime                TEXT    NOT NULL,
    quantity_remaining    TEXT    NOT NULL,
    created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fiscal_lots_asset_portfolio
    ON fiscal_lots(asset_id, portfolio_id, date, event_id);

-- Fiscal calculation events
CREATE TABLE IF NOT EXISTS tax_event (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tax_event_type  TEXT    NOT NULL DEFAULT 'SALE',
    portfolio_id    INTEGER REFERENCES portfolios(id) ON DELETE CASCADE,
    asset_id        INTEGER REFERENCES assets(id) ON DELETE CASCADE,
    sale_event_id   INTEGER REFERENCES events(id) ON DELETE CASCADE,
    lot_id          INTEGER REFERENCES fiscal_lots(id) ON DELETE CASCADE,
    qty_sold        TEXT,
    ganho_brl       TEXT,
    regime          TEXT    NOT NULL,
    ptax_used       TEXT    NOT NULL,
    income_type     TEXT,
    credit_date     TEXT,
    amount_usd      TEXT,
    amount_brl      TEXT,
    calculated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tax_event_sale_event
    ON tax_event(sale_event_id);

CREATE INDEX IF NOT EXISTS idx_tax_event_credit_date
    ON tax_event(credit_date);

CREATE INDEX IF NOT EXISTS idx_tax_event_portfolio_asset
    ON tax_event(portfolio_id, asset_id, tax_event_type);

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
        _migrate_schema(conn)
        conn.commit()
    finally:
        conn.close()


def _table_columns(conn: sqlite3.Connection, table: str) -> dict[str, sqlite3.Row]:
    return {row["name"]: row for row in conn.execute(f"PRAGMA table_info({table})")}


def _add_column_if_missing(conn: sqlite3.Connection, table: str, column: str, ddl: str) -> None:
    if column not in _table_columns(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


def _migrate_schema(conn: sqlite3.Connection) -> None:
    """Apply lightweight migrations for local SQLite databases."""
    _add_column_if_missing(conn, "assets", "market", "market TEXT NOT NULL DEFAULT 'BR'")
    _add_column_if_missing(conn, "assets", "merged_into_asset_id", "merged_into_asset_id INTEGER REFERENCES assets(id)")
    _add_column_if_missing(conn, "assets", "merged_at", "merged_at TEXT")
    _add_column_if_missing(conn, "asset_match_reviews", "operation_payload", "operation_payload TEXT")
    _add_column_if_missing(conn, "events", "gross_value", "gross_value TEXT")
    _add_column_if_missing(conn, "events", "event_value_brl", "event_value_brl TEXT")
    _add_column_if_missing(conn, "events", "gross_value_brl", "gross_value_brl TEXT")
    _add_column_if_missing(conn, "events", "ptax_compra", "ptax_compra TEXT")
    _add_column_if_missing(conn, "events", "ptax_venda", "ptax_venda TEXT")
    _ensure_b3_schema(conn)

    conn.execute(
        """
        UPDATE assets
        SET asset_class = 'Ação'
        WHERE asset_class IN ('A��o', 'Acao')
        """
    )

    conn.execute(
        """
        UPDATE assets
        SET market = CASE WHEN asset_class IN ('Stock', 'REIT') THEN 'US' ELSE COALESCE(market, 'BR') END,
            currency = CASE WHEN asset_class IN ('Stock', 'REIT') THEN 'USD' ELSE COALESCE(currency, 'BRL') END
        WHERE market IS NULL OR currency IS NULL OR asset_class IN ('Stock', 'REIT')
        """
    )

    cols = _table_columns(conn, "asset_tickers")
    if cols.get("valid_from") and cols["valid_from"]["notnull"]:
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("ALTER TABLE asset_tickers RENAME TO asset_tickers_old")
        conn.execute(
            """
            CREATE TABLE asset_tickers (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                asset_id    INTEGER NOT NULL REFERENCES assets(id),
                ticker      TEXT    NOT NULL,
                name        TEXT,
                valid_from  TEXT,
                valid_until TEXT,
                created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        conn.execute(
            """
            INSERT INTO asset_tickers (id, asset_id, ticker, name, valid_from, valid_until, created_at)
            SELECT id, asset_id, ticker, name, valid_from, valid_until, created_at
            FROM asset_tickers_old
            """
        )
        conn.execute("DROP TABLE asset_tickers_old")
        conn.execute("PRAGMA foreign_keys = ON")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_asset_tickers_lookup ON asset_tickers(ticker, valid_from, valid_until)"
    )


def _ensure_b3_schema(conn: sqlite3.Connection) -> None:
    """Create B3 import tables for fresh and existing local databases."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS b3_monthly_imports (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id          INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
            filename              TEXT    NOT NULL,
            reference_month       TEXT    NOT NULL,
            reference_date        TEXT    NOT NULL,
            status                TEXT    NOT NULL DEFAULT 'processed',
            total_rows            INTEGER NOT NULL DEFAULT 0,
            imported_prices       INTEGER NOT NULL DEFAULT 0,
            imported_incomes      INTEGER NOT NULL DEFAULT 0,
            auto_events_created   INTEGER NOT NULL DEFAULT 0,
            duplicates            INTEGER NOT NULL DEFAULT 0,
            review_count          INTEGER NOT NULL DEFAULT 0,
            errors                TEXT,
            created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE(portfolio_id, filename)
        );

        CREATE TABLE IF NOT EXISTS b3_market_prices (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            import_id        INTEGER NOT NULL REFERENCES b3_monthly_imports(id) ON DELETE CASCADE,
            asset_id         INTEGER REFERENCES assets(id) ON DELETE SET NULL,
            reference_month  TEXT    NOT NULL,
            reference_date   TEXT    NOT NULL,
            source_sheet     TEXT    NOT NULL,
            source_row       INTEGER NOT NULL,
            ticker           TEXT,
            product          TEXT,
            cnpj             TEXT,
            maturity_date    TEXT,
            value            TEXT,
            is_unit_price    INTEGER NOT NULL DEFAULT 1,
            status           TEXT    NOT NULL DEFAULT 'imported',
            review_id        INTEGER REFERENCES asset_match_reviews(id) ON DELETE SET NULL,
            raw_payload      TEXT,
            created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE(import_id, source_sheet, source_row),
            UNIQUE(asset_id, reference_month, source_sheet)
        );

        CREATE INDEX IF NOT EXISTS idx_b3_market_prices_asset_month
            ON b3_market_prices(asset_id, reference_month);

        CREATE TABLE IF NOT EXISTS b3_income_events (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            import_id        INTEGER NOT NULL REFERENCES b3_monthly_imports(id) ON DELETE CASCADE,
            portfolio_id     INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
            asset_id         INTEGER REFERENCES assets(id) ON DELETE SET NULL,
            payment_date     TEXT    NOT NULL,
            event_type       TEXT    NOT NULL,
            product          TEXT,
            ticker           TEXT,
            quantity         TEXT,
            unit_price       TEXT,
            net_value        TEXT,
            status           TEXT    NOT NULL DEFAULT 'imported',
            ledger_event_id  INTEGER REFERENCES events(id) ON DELETE SET NULL,
            review_id        INTEGER REFERENCES asset_match_reviews(id) ON DELETE SET NULL,
            raw_payload      TEXT,
            created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE(import_id, payment_date, event_type, product),
            UNIQUE(portfolio_id, asset_id, payment_date, event_type)
        );

        CREATE INDEX IF NOT EXISTS idx_b3_income_events_asset_date
            ON b3_income_events(portfolio_id, asset_id, payment_date);
        """
    )


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
