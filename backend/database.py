"""
SQLite database initialisation and connection management.

All financial values are stored as TEXT (canonical decimal with '.' separator)
and converted to ``decimal.Decimal`` in the domain layer.
"""

import sqlite3
from pathlib import Path
from contextlib import contextmanager

from backend.domain.enums import (
    AssetClass,
    AssetMatchReviewStatus,
    B3IncomeEventStatus,
    B3MarketPriceStatus,
    B3MonthlyImportStatus,
    Currency,
    EventType,
    Market,
    ReitType,
    TreasuryIndexer,
)

DB_PATH = Path(__file__).resolve().parent / "ledger.db"


def _sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _sql_in(values) -> str:
    return "(" + ", ".join(_sql_quote(str(value)) for value in values) + ")"


_ASSET_CLASS_VALUES = _sql_in(item.value for item in AssetClass)
_ASSET_MATCH_REVIEW_STATUS_VALUES = _sql_in(item.value for item in AssetMatchReviewStatus)
_B3_INCOME_EVENT_STATUS_VALUES = _sql_in(item.value for item in B3IncomeEventStatus)
_B3_MARKET_PRICE_STATUS_VALUES = _sql_in(item.value for item in B3MarketPriceStatus)
_B3_MONTHLY_IMPORT_STATUS_VALUES = _sql_in(item.value for item in B3MonthlyImportStatus)
_CURRENCY_VALUES = _sql_in(item.value for item in Currency)
_EVENT_TYPE_VALUES = _sql_in(item.value for item in EventType)
_MARKET_VALUES = _sql_in(item.value for item in Market)
_REIT_TYPE_VALUES = _sql_in(item.value for item in ReitType)
_TREASURY_INDEXER_VALUES = _sql_in(item.value for item in TreasuryIndexer)


_SCHEMA = f"""
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ────────────────────────────────────────────────────────────
-- Portfolios
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS portfolios (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL UNIQUE,
    consolidated  INTEGER NOT NULL DEFAULT 1 CHECK (consolidated IN (0, 1)),
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ────────────────────────────────────────────────────────────
-- Assets (asset_id is the immutable internal key)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_class     TEXT    NOT NULL CHECK (asset_class IN {_ASSET_CLASS_VALUES}),
    market          TEXT    NOT NULL DEFAULT 'BR' CHECK (market IN {_MARKET_VALUES}),
    currency        TEXT    NOT NULL DEFAULT 'BRL' CHECK (currency IN {_CURRENCY_VALUES}),
    maturity_date   TEXT,
    aux_id          TEXT,
    -- Metadata fields (v1.0.1)
    name            TEXT,
    cnpj            TEXT,
    isin            TEXT,
    sector          TEXT,
    subsector       TEXT,
    segment         TEXT,
    gics_sector     TEXT,
    gics_industry_group TEXT,
    gics_industry   TEXT,
    gics_sub_industry TEXT,
    reit_type       TEXT CHECK (reit_type IS NULL OR reit_type IN {_REIT_TYPE_VALUES}),
    treasury_indexer TEXT CHECK (treasury_indexer IS NULL OR treasury_indexer IN {_TREASURY_INDEXER_VALUES}),
    fiscal_regime_override TEXT,
    fiscal_tax_treatment   TEXT,
    merged_into_asset_id INTEGER REFERENCES assets(id),
    merged_at       TEXT,
    duplicate_flag  INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_flag IN (0, 1)),
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assets_active_class_market
    ON assets(asset_class, market, id)
    WHERE merged_into_asset_id IS NULL;

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
    ON asset_tickers(ticker, valid_from, valid_until, asset_id);

CREATE INDEX IF NOT EXISTS idx_asset_tickers_asset_current
    ON asset_tickers(asset_id, valid_until, valid_from, id);

-- ────────────────────────────────────────────────────────────
-- Asset matching review queue
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS asset_match_reviews (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    source              TEXT    NOT NULL,
    ticker              TEXT    NOT NULL,
    asset_class         TEXT    NOT NULL CHECK (asset_class IN {_ASSET_CLASS_VALUES}),
    market              TEXT CHECK (market IS NULL OR market IN {_MARKET_VALUES}),
    event_date          TEXT,
    candidate_asset_ids TEXT,
    reason              TEXT,
    operation_payload   TEXT,
    status              TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN {_ASSET_MATCH_REVIEW_STATUS_VALUES}),
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    resolved_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_asset_match_reviews_pending_key
    ON asset_match_reviews(status, source, ticker, asset_class, market, event_date, id)
    WHERE status = 'pending';

-- ────────────────────────────────────────────────────────────
-- Event ledger  (source of truth)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id    INTEGER NOT NULL REFERENCES portfolios(id),
    asset_id        INTEGER NOT NULL REFERENCES assets(id),
    event_type      TEXT    NOT NULL CHECK (event_type IN {_EVENT_TYPE_VALUES}),
    event_date      TEXT    NOT NULL,
    quantity        TEXT,
    event_value     TEXT    NOT NULL,
    event_value_brl TEXT,
    gross_value     TEXT,
    gross_value_brl TEXT,
    ptax_compra     TEXT,
    ptax_venda      TEXT,
    sequence_num    INTEGER NOT NULL,
    storno_of       INTEGER REFERENCES events(id),
    correction_of   INTEGER REFERENCES events(id),
    is_storno       INTEGER NOT NULL DEFAULT 0 CHECK (is_storno IN (0, 1)),
    is_cancelled    INTEGER NOT NULL DEFAULT 0 CHECK (is_cancelled IN (0, 1)),
    duplicate_flag  INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_flag IN (0, 1)),
    notes           TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_asset_portfolio
    ON events(asset_id, portfolio_id, event_date, sequence_num);

CREATE INDEX IF NOT EXISTS idx_events_portfolio_period
    ON events(portfolio_id, event_date, sequence_num, asset_id);

-- PTAX cache
CREATE TABLE IF NOT EXISTS ptax_cache (
    date    TEXT PRIMARY KEY,
    compra  REAL NOT NULL,
    venda   REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS ptax_monthly_cache (
    reference_month TEXT PRIMARY KEY,
    ptax_date       TEXT NOT NULL,
    venda           TEXT NOT NULL,
    source          TEXT NOT NULL DEFAULT 'startup',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
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

-- Fiscal parameters by effective period
CREATE TABLE IF NOT EXISTS fiscal_tax_parameters (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    regime                TEXT    NOT NULL,
    valid_from            TEXT    NOT NULL,
    valid_until           TEXT,
    tax_rate              TEXT    NOT NULL DEFAULT '0',
    withholding_rate      TEXT    NOT NULL DEFAULT '0',
    exemption_limit       TEXT,
    darf_code             TEXT,
    minimum_darf_amount   TEXT    NOT NULL DEFAULT '10.00',
    loss_bucket           TEXT,
    active                INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    monthly_darf_enabled  INTEGER NOT NULL DEFAULT 1 CHECK (monthly_darf_enabled IN (0, 1)),
    created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fiscal_tax_parameters_lookup
    ON fiscal_tax_parameters(regime, valid_from, valid_until);

-- Manual fiscal IRRF overrides for reports
CREATE TABLE IF NOT EXISTS fiscal_irrf_overrides (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id   INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    year_month     TEXT    NOT NULL,
    regime         TEXT    NOT NULL,
    effective_irrf TEXT    NOT NULL,
    notes          TEXT,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(portfolio_id, year_month, regime)
);

CREATE INDEX IF NOT EXISTS idx_fiscal_irrf_overrides_lookup
    ON fiscal_irrf_overrides(portfolio_id, year_month, regime);

-- Manual DARF paid values for capital gains reports
CREATE TABLE IF NOT EXISTS fiscal_capital_gain_tax_overrides (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id    INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    year_month      TEXT    NOT NULL,
    regime          TEXT    NOT NULL,
    manual_tax_paid TEXT    NOT NULL,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(portfolio_id, year_month, regime)
);

CREATE INDEX IF NOT EXISTS idx_fiscal_capital_gain_tax_overrides_lookup
    ON fiscal_capital_gain_tax_overrides(portfolio_id, year_month, regime);

-- DARF payment confirmations for capital gains fiscal export
CREATE TABLE IF NOT EXISTS fiscal_capital_gain_darf_payment_confirmations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id    INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    year_month      TEXT    NOT NULL,
    regime          TEXT    NOT NULL,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(portfolio_id, year_month, regime)
);

CREATE INDEX IF NOT EXISTS idx_fiscal_capital_gain_darf_payment_confirmations_lookup
    ON fiscal_capital_gain_darf_payment_confirmations(portfolio_id, year_month, regime);

-- Manual capital gain events that do not belong in the ledger
CREATE TABLE IF NOT EXISTS fiscal_capital_gain_manual_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id    INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    year_month      TEXT    NOT NULL,
    regime          TEXT    NOT NULL,
    ticker          TEXT    NOT NULL,
    gross_sale      TEXT    NOT NULL,
    realized_result TEXT    NOT NULL,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fiscal_capital_gain_manual_events_lookup
    ON fiscal_capital_gain_manual_events(portfolio_id, year_month, regime);

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
    _add_column_if_missing(conn, "assets", "fiscal_regime_override", "fiscal_regime_override TEXT")
    _add_column_if_missing(conn, "assets", "fiscal_tax_treatment", "fiscal_tax_treatment TEXT")
    _add_column_if_missing(conn, "assets", "gics_sector", "gics_sector TEXT")
    _add_column_if_missing(conn, "assets", "gics_industry_group", "gics_industry_group TEXT")
    _add_column_if_missing(conn, "assets", "gics_industry", "gics_industry TEXT")
    _add_column_if_missing(conn, "assets", "gics_sub_industry", "gics_sub_industry TEXT")
    _add_column_if_missing(conn, "assets", "reit_type", f"reit_type TEXT CHECK (reit_type IS NULL OR reit_type IN {_REIT_TYPE_VALUES})")
    _add_column_if_missing(conn, "assets", "treasury_indexer", f"treasury_indexer TEXT CHECK (treasury_indexer IS NULL OR treasury_indexer IN {_TREASURY_INDEXER_VALUES})")
    _add_column_if_missing(conn, "asset_match_reviews", "operation_payload", "operation_payload TEXT")
    _add_column_if_missing(conn, "events", "gross_value", "gross_value TEXT")
    _add_column_if_missing(conn, "events", "event_value_brl", "event_value_brl TEXT")
    _add_column_if_missing(conn, "events", "gross_value_brl", "gross_value_brl TEXT")
    _add_column_if_missing(conn, "events", "ptax_compra", "ptax_compra TEXT")
    _add_column_if_missing(conn, "events", "ptax_venda", "ptax_venda TEXT")
    _ensure_events_nullable_quantity(conn)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ptax_monthly_cache (
            reference_month TEXT PRIMARY KEY,
            ptax_date       TEXT NOT NULL,
            venda           TEXT NOT NULL,
            source          TEXT NOT NULL DEFAULT 'startup',
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    _ensure_b3_schema(conn)
    _ensure_schwab_schema(conn)

    conn.execute(
        """
        UPDATE assets
        SET asset_class = 'A\u00e7\u00e3o'
        WHERE asset_class = 'Acao'
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
        "CREATE INDEX IF NOT EXISTS idx_asset_tickers_lookup ON asset_tickers(ticker, valid_from, valid_until, asset_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_asset_tickers_asset_current ON asset_tickers(asset_id, valid_until, valid_from, id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_assets_active_class_market ON assets(asset_class, market, id) WHERE merged_into_asset_id IS NULL"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_asset_match_reviews_pending_key ON asset_match_reviews(status, source, ticker, asset_class, market, event_date, id) WHERE status = 'pending'"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_events_portfolio_period ON events(portfolio_id, event_date, sequence_num, asset_id)"
    )
    _ensure_fiscal_schema(conn)


def _ensure_events_nullable_quantity(conn: sqlite3.Connection) -> None:
    cols = _table_columns(conn, "events")
    if not cols.get("quantity") or not cols["quantity"]["notnull"]:
        return
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("ALTER TABLE events RENAME TO events_old")
    conn.execute(
        f"""
        CREATE TABLE events (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id    INTEGER NOT NULL REFERENCES portfolios(id),
            asset_id        INTEGER NOT NULL REFERENCES assets(id),
            event_type      TEXT    NOT NULL CHECK (event_type IN {_EVENT_TYPE_VALUES}),
            event_date      TEXT    NOT NULL,
            quantity        TEXT,
            event_value     TEXT    NOT NULL,
            event_value_brl TEXT,
            gross_value     TEXT,
            gross_value_brl TEXT,
            ptax_compra     TEXT,
            ptax_venda      TEXT,
            sequence_num    INTEGER NOT NULL,
            storno_of       INTEGER REFERENCES events(id),
            correction_of   INTEGER REFERENCES events(id),
            is_storno       INTEGER NOT NULL DEFAULT 0 CHECK (is_storno IN (0, 1)),
            is_cancelled    INTEGER NOT NULL DEFAULT 0 CHECK (is_cancelled IN (0, 1)),
            duplicate_flag  INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_flag IN (0, 1)),
            notes           TEXT,
            created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    conn.execute(
        """
        INSERT INTO events (
            id, portfolio_id, asset_id, event_type, event_date, quantity,
            event_value, event_value_brl, gross_value, gross_value_brl,
            ptax_compra, ptax_venda, sequence_num, storno_of, correction_of,
            is_storno, is_cancelled, duplicate_flag, notes, created_at
        )
        SELECT id, portfolio_id, asset_id, event_type, event_date, quantity,
               event_value, event_value_brl, gross_value, gross_value_brl,
               ptax_compra, ptax_venda, sequence_num, storno_of, correction_of,
               is_storno, is_cancelled, duplicate_flag, notes, created_at
        FROM events_old
        """
    )
    conn.execute("DROP TABLE events_old")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_asset_portfolio ON events(asset_id, portfolio_id, event_date, sequence_num)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_portfolio_period ON events(portfolio_id, event_date, sequence_num, asset_id)")


def _ensure_fiscal_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS fiscal_tax_parameters (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            regime                TEXT    NOT NULL,
            valid_from            TEXT    NOT NULL,
            valid_until           TEXT,
            tax_rate              TEXT    NOT NULL DEFAULT '0',
            withholding_rate      TEXT    NOT NULL DEFAULT '0',
            exemption_limit       TEXT,
            darf_code             TEXT,
            minimum_darf_amount   TEXT    NOT NULL DEFAULT '10.00',
            loss_bucket           TEXT,
            active                INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
            monthly_darf_enabled  INTEGER NOT NULL DEFAULT 1 CHECK (monthly_darf_enabled IN (0, 1)),
            created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_fiscal_tax_parameters_lookup
            ON fiscal_tax_parameters(regime, valid_from, valid_until);

        CREATE TABLE IF NOT EXISTS fiscal_irrf_overrides (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id   INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
            year_month     TEXT    NOT NULL,
            regime         TEXT    NOT NULL,
            effective_irrf TEXT    NOT NULL,
            notes          TEXT,
            created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE(portfolio_id, year_month, regime)
        );

        CREATE INDEX IF NOT EXISTS idx_fiscal_irrf_overrides_lookup
            ON fiscal_irrf_overrides(portfolio_id, year_month, regime);

        CREATE TABLE IF NOT EXISTS fiscal_capital_gain_tax_overrides (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id    INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
            year_month      TEXT    NOT NULL,
            regime          TEXT    NOT NULL,
            manual_tax_paid TEXT    NOT NULL,
            created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE(portfolio_id, year_month, regime)
        );

        CREATE INDEX IF NOT EXISTS idx_fiscal_capital_gain_tax_overrides_lookup
            ON fiscal_capital_gain_tax_overrides(portfolio_id, year_month, regime);

        CREATE TABLE IF NOT EXISTS fiscal_capital_gain_darf_payment_confirmations (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id    INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
            year_month      TEXT    NOT NULL,
            regime          TEXT    NOT NULL,
            created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE(portfolio_id, year_month, regime)
        );

        CREATE INDEX IF NOT EXISTS idx_fiscal_capital_gain_darf_payment_confirmations_lookup
            ON fiscal_capital_gain_darf_payment_confirmations(portfolio_id, year_month, regime);

        CREATE TABLE IF NOT EXISTS fiscal_capital_gain_manual_events (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id    INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
            year_month      TEXT    NOT NULL,
            regime          TEXT    NOT NULL,
            ticker          TEXT    NOT NULL,
            gross_sale      TEXT    NOT NULL,
            realized_result TEXT    NOT NULL,
            created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_fiscal_capital_gain_manual_events_lookup
            ON fiscal_capital_gain_manual_events(portfolio_id, year_month, regime);
        """
    )
    _add_column_if_missing(
        conn,
        "fiscal_tax_parameters",
        "minimum_darf_amount",
        "minimum_darf_amount TEXT NOT NULL DEFAULT '10.00'",
    )
    defaults = [
        ("B3_COMMON_15", "1900-01-01", None, "0.15", "0.00005", "20000", "6015", "10.00", "B3_COMMON", 1),
        ("B3_FII_FIAGRO_20", "1900-01-01", None, "0.20", "0.00005", None, "6015", "10.00", "B3_FII_FIAGRO", 1),
        ("FI_INFRA_EXEMPT", "1900-01-01", None, "0", "0", None, None, "10.00", None, 0),
        ("CRYPTO_GCAP", "1900-01-01", None, "0", "0", None, None, "10.00", "CRYPTO_GCAP_INFO", 0),
    ]
    for row in defaults:
        exists = conn.execute(
            """
            SELECT 1 FROM fiscal_tax_parameters
            WHERE regime = ? AND valid_from = ? AND COALESCE(valid_until, '') = COALESCE(?, '')
            """,
            (row[0], row[1], row[2]),
        ).fetchone()
        if not exists:
            conn.execute(
                """
                INSERT INTO fiscal_tax_parameters (
                    regime, valid_from, valid_until, tax_rate, withholding_rate,
                    exemption_limit, darf_code, minimum_darf_amount, loss_bucket, monthly_darf_enabled
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                row,
            )
    _add_column_if_missing(conn, "fiscal_tax_parameters", "active", "active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))")


def _ensure_schwab_schema(conn: sqlite3.Connection) -> None:
    """Create Schwab/TDA import tables for fresh and existing databases."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS schwab_imports (
            id                         INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id               INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
            account_key                TEXT    NOT NULL DEFAULT 'UNKNOWN',
            filename                   TEXT    NOT NULL,
            file_hash                  TEXT    NOT NULL,
            source                     TEXT    NOT NULL DEFAULT 'SCHWAB',
            source_format              TEXT    NOT NULL DEFAULT 'JSON',
            from_date                  TEXT,
            to_date                    TEXT,
            total_transactions_amount  TEXT,
            total_fees_comm_amount     TEXT,
            total_rows                 INTEGER NOT NULL DEFAULT 0,
            imported_ledger_events     INTEGER NOT NULL DEFAULT 0,
            imported_foreign_events    INTEGER NOT NULL DEFAULT 0,
            ignored                    INTEGER NOT NULL DEFAULT 0,
            duplicates                 INTEGER NOT NULL DEFAULT 0,
            review_count               INTEGER NOT NULL DEFAULT 0,
            warning_count              INTEGER NOT NULL DEFAULT 0,
            errors                     TEXT,
            status                     TEXT    NOT NULL DEFAULT 'processed',
            created_at                 TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at                 TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE(portfolio_id, account_key, file_hash)
        );

        CREATE INDEX IF NOT EXISTS idx_schwab_imports_portfolio_period
            ON schwab_imports(portfolio_id, from_date, to_date, id);

        CREATE TABLE IF NOT EXISTS schwab_transactions (
            id                          INTEGER PRIMARY KEY AUTOINCREMENT,
            import_id                   INTEGER NOT NULL REFERENCES schwab_imports(id) ON DELETE CASCADE,
            portfolio_id                INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
            source_row                  INTEGER NOT NULL,
            account_key                 TEXT    NOT NULL DEFAULT 'UNKNOWN',
            asset_id                    INTEGER REFERENCES assets(id) ON DELETE SET NULL,
            ledger_event_id             INTEGER REFERENCES events(id) ON DELETE SET NULL,
            source                      TEXT    NOT NULL DEFAULT 'SCHWAB',
            source_format               TEXT    NOT NULL DEFAULT 'JSON',
            source_action               TEXT,
            source_description          TEXT,
            source_symbol               TEXT,
            source_date_raw             TEXT,
            event_date                  TEXT,
            effective_date              TEXT,
            quantity                    TEXT,
            price                       TEXT,
            amount                      TEXT,
            fees_comm                   TEXT,
            acctg_rule_cd               TEXT,
            normalized_category         TEXT    NOT NULL,
            normalized_type             TEXT,
            normalized_subtype          TEXT,
            status                      TEXT    NOT NULL DEFAULT 'imported',
            economic_fingerprint        TEXT,
            external_record_key         TEXT,
            normalized_event_key        TEXT,
            financial_identity_key      TEXT,
            duplicate_of_transaction_id INTEGER REFERENCES schwab_transactions(id) ON DELETE SET NULL,
            duplicate_of_ledger_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
            duplicate_candidate_event_ids TEXT,
            asset_match_review_id       INTEGER REFERENCES asset_match_reviews(id) ON DELETE SET NULL,
            asset_alert_id              INTEGER,
            review_reason               TEXT,
            decision_payload            TEXT,
            reviewed_at                 TEXT,
            raw_payload                 TEXT,
            created_at                  TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at                  TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE(import_id, source_row)
        );

        CREATE INDEX IF NOT EXISTS idx_schwab_transactions_economic
            ON schwab_transactions(portfolio_id, account_key, economic_fingerprint, status);

        CREATE INDEX IF NOT EXISTS idx_schwab_transactions_normalized_event
            ON schwab_transactions(portfolio_id, account_key, normalized_event_key, status);

        CREATE INDEX IF NOT EXISTS idx_schwab_transactions_external_record
            ON schwab_transactions(portfolio_id, account_key, external_record_key, status);

        CREATE INDEX IF NOT EXISTS idx_schwab_transactions_financial_identity
            ON schwab_transactions(portfolio_id, account_key, financial_identity_key, status);

        CREATE INDEX IF NOT EXISTS idx_schwab_transactions_asset_date
            ON schwab_transactions(portfolio_id, event_date, asset_id, normalized_category, status);

        CREATE TABLE IF NOT EXISTS schwab_asset_alerts (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id        INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
            import_id           INTEGER REFERENCES schwab_imports(id) ON DELETE CASCADE,
            transaction_id      INTEGER REFERENCES schwab_transactions(id) ON DELETE SET NULL,
            asset_id            INTEGER REFERENCES assets(id) ON DELETE SET NULL,
            ticker              TEXT,
            alert_type          TEXT    NOT NULL,
            event_date          TEXT,
            source              TEXT    NOT NULL DEFAULT 'SCHWAB',
            source_action       TEXT,
            source_description  TEXT,
            quantity            TEXT,
            status              TEXT    NOT NULL DEFAULT 'pending',
            raw_payload         TEXT,
            created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
            resolved_at         TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_schwab_asset_alerts_pending
            ON schwab_asset_alerts(status, portfolio_id, event_date, id);
        """
    )
    _add_column_if_missing(conn, "schwab_transactions", "external_record_key", "external_record_key TEXT")
    _add_column_if_missing(conn, "schwab_transactions", "normalized_event_key", "normalized_event_key TEXT")
    _add_column_if_missing(conn, "schwab_transactions", "financial_identity_key", "financial_identity_key TEXT")
    _add_column_if_missing(conn, "schwab_transactions", "duplicate_of_ledger_event_id", "duplicate_of_ledger_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL")
    _add_column_if_missing(conn, "schwab_transactions", "duplicate_candidate_event_ids", "duplicate_candidate_event_ids TEXT")
    _add_column_if_missing(conn, "schwab_transactions", "review_reason", "review_reason TEXT")
    _add_column_if_missing(conn, "schwab_transactions", "decision_payload", "decision_payload TEXT")
    _add_column_if_missing(conn, "schwab_transactions", "reviewed_at", "reviewed_at TEXT")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_schwab_transactions_normalized_event ON schwab_transactions(portfolio_id, account_key, normalized_event_key, status)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_schwab_transactions_external_record ON schwab_transactions(portfolio_id, account_key, external_record_key, status)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_schwab_transactions_financial_identity ON schwab_transactions(portfolio_id, account_key, financial_identity_key, status)"
    )


def _ensure_b3_schema(conn: sqlite3.Connection) -> None:
    """Create B3 import tables for fresh and existing local databases."""
    conn.executescript(
        f"""
        CREATE TABLE IF NOT EXISTS b3_monthly_imports (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id          INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
            filename              TEXT    NOT NULL,
            reference_month       TEXT    NOT NULL,
            reference_date        TEXT    NOT NULL,
            status                TEXT    NOT NULL DEFAULT 'processed' CHECK (status IN {_B3_MONTHLY_IMPORT_STATUS_VALUES}),
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

        CREATE INDEX IF NOT EXISTS idx_b3_monthly_imports_portfolio_month
            ON b3_monthly_imports(portfolio_id, reference_month, id);

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
            is_unit_price    INTEGER NOT NULL DEFAULT 1 CHECK (is_unit_price IN (0, 1)),
            status           TEXT    NOT NULL DEFAULT 'imported' CHECK (status IN {_B3_MARKET_PRICE_STATUS_VALUES}),
            review_id        INTEGER REFERENCES asset_match_reviews(id) ON DELETE SET NULL,
            raw_payload      TEXT,
            created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE(import_id, source_sheet, source_row)
        );

        CREATE INDEX IF NOT EXISTS idx_b3_market_prices_import
            ON b3_market_prices(import_id);

        CREATE INDEX IF NOT EXISTS idx_b3_market_prices_asset_month
            ON b3_market_prices(asset_id, reference_month, reference_date, status);

        CREATE TABLE IF NOT EXISTS b3_income_events (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            import_id        INTEGER NOT NULL REFERENCES b3_monthly_imports(id) ON DELETE CASCADE,
            portfolio_id     INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
            asset_id         INTEGER REFERENCES assets(id) ON DELETE SET NULL,
            source_row       INTEGER NOT NULL DEFAULT 0,
            payment_date     TEXT    NOT NULL,
            event_type       TEXT    NOT NULL,
            product          TEXT,
            ticker           TEXT,
            quantity         TEXT,
            unit_price       TEXT,
            net_value        TEXT,
            status           TEXT    NOT NULL DEFAULT 'imported' CHECK (status IN {_B3_INCOME_EVENT_STATUS_VALUES}),
            ledger_event_id  INTEGER REFERENCES events(id) ON DELETE SET NULL,
            review_id        INTEGER REFERENCES asset_match_reviews(id) ON DELETE SET NULL,
            raw_payload      TEXT,
            created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_b3_income_events_import_row
            ON b3_income_events(import_id, source_row)
            WHERE source_row > 0;

        CREATE INDEX IF NOT EXISTS idx_b3_income_events_import
            ON b3_income_events(import_id);

        CREATE INDEX IF NOT EXISTS idx_b3_income_events_asset_date
            ON b3_income_events(portfolio_id, payment_date, asset_id, status);
        """
    )
    _migrate_b3_unique_constraints(conn)


def _migrate_b3_unique_constraints(conn: sqlite3.Connection) -> None:
    """Rebuild early B3 tables that used over-broad uniqueness rules."""
    _add_column_if_missing(conn, "b3_income_events", "source_row", "source_row INTEGER NOT NULL DEFAULT 0")
    price_indexes = conn.execute("PRAGMA index_list(b3_market_prices)").fetchall()
    if sum(1 for row in price_indexes if row["unique"] and row["origin"] == "u") > 1:
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("ALTER TABLE b3_market_prices RENAME TO b3_market_prices_old")
        conn.execute(
            f"""
            CREATE TABLE b3_market_prices (
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
                is_unit_price    INTEGER NOT NULL DEFAULT 1 CHECK (is_unit_price IN (0, 1)),
                status           TEXT    NOT NULL DEFAULT 'imported' CHECK (status IN {_B3_MARKET_PRICE_STATUS_VALUES}),
                review_id        INTEGER REFERENCES asset_match_reviews(id) ON DELETE SET NULL,
                raw_payload      TEXT,
                created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
                updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
                UNIQUE(import_id, source_sheet, source_row)
            )
            """
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO b3_market_prices (
                id, import_id, asset_id, reference_month, reference_date,
                source_sheet, source_row, ticker, product, cnpj, maturity_date,
                value, is_unit_price, status, review_id, raw_payload, created_at, updated_at
            )
            SELECT id, import_id, asset_id, reference_month, reference_date,
                   source_sheet, source_row, ticker, product, cnpj, maturity_date,
                   value, is_unit_price, status, review_id, raw_payload, created_at, updated_at
            FROM b3_market_prices_old
            """
        )
        conn.execute("DROP TABLE b3_market_prices_old")
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_b3_market_prices_import ON b3_market_prices(import_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_b3_market_prices_asset_month ON b3_market_prices(asset_id, reference_month, reference_date, status)")

    income_indexes = conn.execute("PRAGMA index_list(b3_income_events)").fetchall()
    if sum(1 for row in income_indexes if row["unique"] and row["origin"] == "u") > 0:
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("ALTER TABLE b3_income_events RENAME TO b3_income_events_old")
        conn.execute(
            f"""
            CREATE TABLE b3_income_events (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                import_id        INTEGER NOT NULL REFERENCES b3_monthly_imports(id) ON DELETE CASCADE,
                portfolio_id     INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
                asset_id         INTEGER REFERENCES assets(id) ON DELETE SET NULL,
                source_row       INTEGER NOT NULL DEFAULT 0,
                payment_date     TEXT    NOT NULL,
                event_type       TEXT    NOT NULL,
                product          TEXT,
                ticker           TEXT,
                quantity         TEXT,
                unit_price       TEXT,
                net_value        TEXT,
                status           TEXT    NOT NULL DEFAULT 'imported' CHECK (status IN {_B3_INCOME_EVENT_STATUS_VALUES}),
                ledger_event_id  INTEGER REFERENCES events(id) ON DELETE SET NULL,
                review_id        INTEGER REFERENCES asset_match_reviews(id) ON DELETE SET NULL,
                raw_payload      TEXT,
                created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
                updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO b3_income_events (
                id, import_id, portfolio_id, asset_id, source_row, payment_date,
                event_type, product, ticker, quantity, unit_price, net_value,
                status, ledger_event_id, review_id, raw_payload, created_at, updated_at
            )
            SELECT id, import_id, portfolio_id, asset_id,
                   COALESCE(NULLIF(source_row, 0), id), payment_date,
                   event_type, product, ticker, quantity, unit_price, net_value,
                   status, ledger_event_id, review_id, raw_payload, created_at, updated_at
            FROM b3_income_events_old
            """
        )
        conn.execute("DROP TABLE b3_income_events_old")
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_b3_income_events_import_row ON b3_income_events(import_id, source_row) WHERE source_row > 0")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_b3_income_events_import ON b3_income_events(import_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_b3_income_events_asset_date ON b3_income_events(portfolio_id, payment_date, asset_id, status)")


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
