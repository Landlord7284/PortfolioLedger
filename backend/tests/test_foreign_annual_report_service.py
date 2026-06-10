from decimal import Decimal

from backend.database import get_db, init_db
from backend.domain.enums import AssetClass, EventType
from backend.services import (
    asset_service,
    capital_gain_report_service,
    event_service,
    foreign_annual_report_service,
    portfolio_service,
)


def _seed_ptax(conn, date, compra="4.90", venda="5.00"):
    conn.execute(
        "INSERT INTO ptax_cache (date, compra, venda) VALUES (?, ?, ?)",
        (date, float(compra), float(venda)),
    )


def _setup(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    conn_ctx = get_db(db_path)
    conn = conn_ctx.__enter__()
    portfolio = portfolio_service.create_portfolio(conn, "Principal")
    return conn_ctx, conn, portfolio


def _close(conn_ctx):
    conn_ctx.__exit__(None, None, None)


def _stock(conn, ticker="MSFT", name=None):
    return asset_service.create_asset(conn, AssetClass.STOCK.value, ticker, market="US", name=name)


def _buy(conn, portfolio, asset, date, qty, total_usd):
    return event_service.create_event(
        conn,
        portfolio["id"],
        asset["id"],
        EventType.COMPRA.value,
        date,
        qty,
        total_usd,
    )


def _sell(conn, portfolio, asset, date, qty, total_usd, gross_value=None):
    return event_service.create_event(
        conn,
        portfolio["id"],
        asset["id"],
        EventType.VENDA.value,
        date,
        qty,
        total_usd,
        gross_value=gross_value,
    )


def _schwab_import(conn, portfolio):
    cur = conn.execute(
        """
        INSERT INTO schwab_imports (portfolio_id, filename, file_hash)
        VALUES (?, ?, ?)
        """,
        (portfolio["id"], "schwab.json", f"hash-{portfolio['id']}-{id(conn)}"),
    )
    return cur.lastrowid


def _schwab_tx(conn, import_id, portfolio, source_row, category, amount, date, asset=None, symbol=None):
    conn.execute(
        """
        INSERT INTO schwab_transactions (
            import_id, portfolio_id, source_row, asset_id, source_symbol,
            event_date, amount, normalized_category, normalized_type, status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported')
        """,
        (
            import_id,
            portfolio["id"],
            source_row,
            asset["id"] if asset else None,
            symbol or (asset["ticker"] if asset and "ticker" in asset else None),
            date,
            amount,
            category,
            category,
        ),
    )


def _first_row(report):
    assert len(report["rows"]) == 1
    return report["rows"][0]


def test_us_sale_post_2024_enters_foreign_report_and_creates_tax_event(tmp_path):
    ctx, conn, portfolio = _setup(tmp_path)
    try:
        _seed_ptax(conn, "2024-01-02", venda="5.00")
        _seed_ptax(conn, "2024-01-10", venda="5.50")
        asset = _stock(conn)
        _buy(conn, portfolio, asset, "2024-01-02", "10", "1000")
        sale = _sell(conn, portfolio, asset, "2024-01-10", "4", "480")

        report = foreign_annual_report_service.list_foreign_annual_report(conn, portfolio["id"], 2024)
        tax_rows = conn.execute("SELECT * FROM tax_event WHERE sale_event_id = ?", (sale["id"],)).fetchall()
    finally:
        _close(ctx)

    row = _first_row(report)
    assert row["ticker"] == "MSFT"
    assert row["gain_loss"] == "640.00"
    assert row["line_tax_due"] == "96.00"
    assert row["taxable_base"] == "640.00"
    assert report["consolidated_tax_due"] == "96.00"
    assert len(tax_rows) == 1


def test_us_sale_stays_out_of_national_capital_gains_report(tmp_path):
    ctx, conn, portfolio = _setup(tmp_path)
    try:
        _seed_ptax(conn, "2024-01-02", venda="5.00")
        _seed_ptax(conn, "2024-01-10", venda="5.50")
        asset = _stock(conn)
        _buy(conn, portfolio, asset, "2024-01-02", "10", "1000")
        _sell(conn, portfolio, asset, "2024-01-10", "4", "480")

        foreign_annual_report_service.list_foreign_annual_report(conn, portfolio["id"], 2024)
        national = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2024)
    finally:
        _close(ctx)

    assert national["months"] == []


def test_sale_and_dividends_in_same_year_sum_gain_loss(tmp_path):
    ctx, conn, portfolio = _setup(tmp_path)
    try:
        _seed_ptax(conn, "2024-01-02", venda="5.00")
        _seed_ptax(conn, "2024-01-10", venda="5.50")
        _seed_ptax(conn, "2024-03-20", venda="5.00")
        asset = _stock(conn)
        _buy(conn, portfolio, asset, "2024-01-02", "10", "1000")
        _sell(conn, portfolio, asset, "2024-01-10", "4", "480")
        import_id = _schwab_import(conn, portfolio)
        _schwab_tx(conn, import_id, portfolio, 1, "dividend", "10.00", "2024-03-20", asset=asset)

        report = foreign_annual_report_service.list_foreign_annual_report(conn, portfolio["id"], 2024)
    finally:
        _close(ctx)

    row = _first_row(report)
    assert row["gain_loss"] == "690.00"
    assert row["line_tax_due"] == "103.50"
    assert row["taxable_base"] == "690.00"


def test_dividend_with_withholding_above_national_rate_zeroes_taxable_base(tmp_path):
    ctx, conn, portfolio = _setup(tmp_path)
    try:
        _seed_ptax(conn, "2024-04-10", venda="5.00")
        asset = _stock(conn)
        import_id = _schwab_import(conn, portfolio)
        _schwab_tx(conn, import_id, portfolio, 1, "dividend", "10.00", "2024-04-10", asset=asset)
        _schwab_tx(conn, import_id, portfolio, 2, "foreign_tax", "-2.00", "2024-04-10", asset=asset)

        report = foreign_annual_report_service.list_foreign_annual_report(conn, portfolio["id"], 2024)
    finally:
        _close(ctx)

    row = _first_row(report)
    assert row["gain_loss"] == "50.00"
    assert row["line_tax_due"] == "7.50"
    assert row["foreign_tax_paid"] == "10.00"
    assert row["taxable_base"] == "0.00"
    assert row["balance"] == "0.00"
    assert report["consolidated_tax_due"] == "0.00"


def test_negative_final_balance_carries_to_next_year(tmp_path):
    ctx, conn, portfolio = _setup(tmp_path)
    try:
        _seed_ptax(conn, "2024-01-02", venda="5.00")
        _seed_ptax(conn, "2024-01-10", venda="5.00")
        asset = _stock(conn)
        _buy(conn, portfolio, asset, "2024-01-02", "10", "1000")
        _sell(conn, portfolio, asset, "2024-01-10", "4", "320")

        report_2024 = foreign_annual_report_service.list_foreign_annual_report(conn, portfolio["id"], 2024)
        report_2025 = foreign_annual_report_service.list_foreign_annual_report(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    assert report_2024["final_balance"] == "-400.00"
    assert report_2024["loss_carryforward"] == "400.00"
    assert report_2025["initial_loss_carryforward"] == "400.00"
    assert report_2025["final_balance"] == "-400.00"
    assert report_2025["loss_carryforward"] == "400.00"


def test_fraction_sale_enters_as_patrimonial_sale_without_schwab_double_count(tmp_path):
    ctx, conn, portfolio = _setup(tmp_path)
    try:
        _seed_ptax(conn, "2025-11-28", venda="5.00")
        asset = _stock(conn)
        event_service.create_event(
            conn,
            portfolio["id"],
            asset["id"],
            EventType.VENDA_FRACAO.value,
            "2025-11-28",
            "0",
            "2.00",
        )
        import_id = _schwab_import(conn, portfolio)
        conn.execute(
            """
            INSERT INTO schwab_transactions (
                import_id, portfolio_id, source_row, asset_id, source_symbol,
                event_date, amount, normalized_category, normalized_type, status
            )
            VALUES (?, ?, 1, ?, 'MSFT', '2025-11-28', '2.00', 'ledger', 'cash_in_lieu', 'ledger_event_created')
            """,
            (import_id, portfolio["id"], asset["id"]),
        )

        report = foreign_annual_report_service.list_foreign_annual_report(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    row = _first_row(report)
    assert row["gain_loss"] == "10.00"
    assert row["taxable_base"] == "10.00"


def test_schwab_dividends_and_withholding_are_not_reduced_by_partial_sale(tmp_path):
    ctx, conn, portfolio = _setup(tmp_path)
    try:
        _seed_ptax(conn, "2024-01-02", venda="5.00")
        _seed_ptax(conn, "2024-02-10", venda="5.00")
        _seed_ptax(conn, "2024-03-20", venda="5.00")
        asset = _stock(conn)
        _buy(conn, portfolio, asset, "2024-01-02", "10", "1000")
        _sell(conn, portfolio, asset, "2024-02-10", "5", "600")
        import_id = _schwab_import(conn, portfolio)
        _schwab_tx(conn, import_id, portfolio, 1, "dividend", "100.00", "2024-03-20", asset=asset)
        _schwab_tx(conn, import_id, portfolio, 2, "foreign_tax", "-30.00", "2024-03-20", asset=asset)

        report = foreign_annual_report_service.list_foreign_annual_report(conn, portfolio["id"], 2024)
    finally:
        _close(ctx)

    row = _first_row(report)
    assert row["gain_loss"] == "1000.00"
    assert row["foreign_tax_paid"] == "150.00"
    assert row["taxable_base"] == "0.00"
    assert report["consolidated_tax_due"] == "0.00"
