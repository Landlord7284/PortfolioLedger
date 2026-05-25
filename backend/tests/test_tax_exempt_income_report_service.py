from fastapi.testclient import TestClient

from backend.database import get_db, init_db
from backend.domain.enums import AssetClass, EventType
from backend.main import app
from backend.services import asset_service, event_service, portfolio_service, tax_exempt_income_report_service


def _setup(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    conn_ctx = get_db(db_path)
    conn = conn_ctx.__enter__()
    portfolio = portfolio_service.create_portfolio(conn, "Principal")
    return db_path, conn_ctx, conn, portfolio


def _close(conn_ctx):
    conn_ctx.__exit__(None, None, None)


def _group(report, source):
    return next(group for group in report["groups"] if group["source"] == source)


def _b3_import(conn, portfolio_id):
    cur = conn.execute(
        """
        INSERT INTO b3_monthly_imports (
            portfolio_id, filename, reference_month, reference_date
        )
        VALUES (?, '2025-12.xlsx', '2025-12', '2025-12-31')
        """,
        (portfolio_id,),
    )
    return cur.lastrowid


def _b3_income(conn, import_id, portfolio_id, asset_id, *, payment_date, event_type, net_value, ledger_event_id=None, source_row=1):
    conn.execute(
        """
        INSERT INTO b3_income_events (
            import_id, portfolio_id, asset_id, source_row, payment_date,
            event_type, product, ticker, quantity, unit_price, net_value,
            status, ledger_event_id
        )
        VALUES (?, ?, ?, ?, ?, ?, 'Produto Teste', 'INFRA11', '1', ?, ?, 'imported', ?)
        """,
        (
            import_id,
            portfolio_id,
            asset_id,
            source_row,
            payment_date,
            event_type,
            net_value,
            net_value,
            ledger_event_id,
        ),
    )


def test_stock_sales_under_monthly_limit_are_consolidated_with_source_events(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        first = asset_service.create_asset(conn, AssetClass.ACAO.value, "AAA3", market="BR")
        second = asset_service.create_asset(conn, AssetClass.ACAO.value, "BBB3", market="BR")
        event_service.create_event(conn, portfolio["id"], first["id"], EventType.COMPRA.value, "2025-03-01", "100", "10000")
        first_sale = event_service.create_event(conn, portfolio["id"], first["id"], EventType.VENDA.value, "2025-03-10", "100", "11000", gross_value="11000")
        event_service.create_event(conn, portfolio["id"], second["id"], EventType.COMPRA.value, "2025-03-02", "100", "5000")
        second_sale = event_service.create_event(conn, portfolio["id"], second["id"], EventType.VENDA.value, "2025-03-11", "100", "6000", gross_value="6000")

        report = tax_exempt_income_report_service.list_tax_exempt_income(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    group = _group(report, "stock_sales_20k_exemption")
    assert group["label"] == "Ganhos líquidos em operações no mercado à vista de ações"
    assert group["total"] == "2000.00"
    assert group["months"][0]["year_month"] == "2025-03"
    assert group["months"][0]["total"] == "2000.00"
    assert {asset["ticker"]: asset["amount"] for asset in group["months"][0]["assets"]} == {
        "AAA3": "1000.00",
        "BBB3": "1000.00",
    }
    source_ids = {
        event["event_id"]
        for asset in group["months"][0]["assets"]
        for event in asset["source_events"]
    }
    assert source_ids == {first_sale["id"], second_sale["id"]}


def test_stock_loss_under_limit_and_etf_bdr_do_not_enter_stock_exemption_group(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        stock = asset_service.create_asset(conn, AssetClass.ACAO.value, "LOSS3", market="BR")
        etf = asset_service.create_asset(conn, AssetClass.ETF.value, "ETF11", market="BR")
        bdr = asset_service.create_asset(conn, AssetClass.BDR.value, "AAPL34", market="BR")
        event_service.create_event(conn, portfolio["id"], stock["id"], EventType.COMPRA.value, "2025-04-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], stock["id"], EventType.VENDA.value, "2025-04-10", "100", "9000", gross_value="9000")
        event_service.create_event(conn, portfolio["id"], etf["id"], EventType.COMPRA.value, "2025-04-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], etf["id"], EventType.VENDA.value, "2025-04-11", "100", "11000", gross_value="11000")
        event_service.create_event(conn, portfolio["id"], bdr["id"], EventType.COMPRA.value, "2025-04-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], bdr["id"], EventType.VENDA.value, "2025-04-12", "100", "11000", gross_value="11000")

        report = tax_exempt_income_report_service.list_tax_exempt_income(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    group = _group(report, "stock_sales_20k_exemption")
    assert group["total"] == "0.00"
    assert group["months"] == []


def test_fi_infra_includes_b3_income_and_positive_exempt_sale_without_negative_loss(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        fi_income = asset_service.create_asset(
            conn,
            AssetClass.FI_INFRA.value,
            "INCOME11",
            market="BR",
            fiscal_tax_treatment="EXEMPT_ZERO",
        )
        fi_gain = asset_service.create_asset(
            conn,
            AssetClass.FI_INFRA.value,
            "GAIN11",
            market="BR",
            fiscal_tax_treatment="EXEMPT_ZERO",
        )
        fi_loss = asset_service.create_asset(
            conn,
            AssetClass.FI_INFRA.value,
            "LOSS11",
            market="BR",
            fiscal_tax_treatment="EXEMPT_ZERO",
        )
        import_id = _b3_import(conn, portfolio["id"])
        _b3_income(conn, import_id, portfolio["id"], fi_income["id"], payment_date="2025-05-15", event_type="Rendimento", net_value="123.45")
        event_service.create_event(conn, portfolio["id"], fi_gain["id"], EventType.COMPRA.value, "2025-05-01", "100", "10000")
        gain_sale = event_service.create_event(conn, portfolio["id"], fi_gain["id"], EventType.VENDA.value, "2025-05-20", "100", "11000", gross_value="11000")
        event_service.create_event(conn, portfolio["id"], fi_loss["id"], EventType.COMPRA.value, "2025-05-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], fi_loss["id"], EventType.VENDA.value, "2025-05-21", "100", "9000", gross_value="9000")

        report = tax_exempt_income_report_service.list_tax_exempt_income(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    group = _group(report, "fi_infra")
    assert group["total"] == "1123.45"
    month = group["months"][0]
    assert month["year_month"] == "2025-05"
    assert month["total"] == "1123.45"
    amounts = {(asset["ticker"], asset["source_event_type"]): asset["amount"] for asset in month["assets"]}
    assert amounts[("GAIN11", "capital_gain_sale")] == "1000.00"
    assert amounts[("INCOME11", "b3:Rendimento")] == "123.45"
    assert "LOSS11" not in {asset["ticker"] for asset in month["assets"]}
    gain_asset = next(asset for asset in month["assets"] if asset["ticker"] == "GAIN11")
    assert gain_asset["source_events"][0]["event_id"] == gain_sale["id"]


def test_crypto_and_foreign_regimes_do_not_enter_tax_exempt_income(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        crypto = asset_service.create_asset(conn, AssetClass.CRIPTOMOEDA.value, "BTC", market="BR")
        foreign = asset_service.create_asset(conn, AssetClass.ACAO.value, "FOR3", market="BR")
        conn.execute("UPDATE assets SET fiscal_regime_override = 'FOREIGN_14754' WHERE id = ?", (foreign["id"],))
        event_service.create_event(conn, portfolio["id"], crypto["id"], EventType.COMPRA.value, "2025-06-01", "1", "10000")
        event_service.create_event(conn, portfolio["id"], crypto["id"], EventType.VENDA.value, "2025-06-20", "1", "12000", gross_value="12000")
        event_service.create_event(conn, portfolio["id"], foreign["id"], EventType.COMPRA.value, "2025-06-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], foreign["id"], EventType.VENDA.value, "2025-06-21", "100", "12000", gross_value="12000")

        report = tax_exempt_income_report_service.list_tax_exempt_income(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    assert report["total"] == "0.00"
    assert _group(report, "stock_sales_20k_exemption")["months"] == []
    assert _group(report, "fi_infra")["months"] == []


def test_tax_exempt_income_route_returns_contract(tmp_path, monkeypatch):
    db_path, ctx, conn, portfolio = _setup(tmp_path)
    try:
        asset = asset_service.create_asset(conn, AssetClass.ACAO.value, "AAA3", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-03-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, "2025-03-10", "100", "11000", gross_value="11000")
    finally:
        _close(ctx)

    monkeypatch.setattr("backend.routers.reports.get_db", lambda: get_db(db_path))
    client = TestClient(app)

    response = client.get(f"/api/reports/tax-exempt-income?portfolio_id={portfolio['id']}&year=2025")

    assert response.status_code == 200
    body = response.json()
    assert body["portfolio_id"] == portfolio["id"]
    assert body["year"] == 2025
    assert body["total"] == "1000.00"
    assert [group["source"] for group in body["groups"]] == ["stock_sales_20k_exemption", "fi_infra"]
