from fastapi.testclient import TestClient

from backend.database import get_db, init_db
from backend.domain.enums import AssetClass, EventType
from backend.main import app
from backend.services import asset_service, capital_gain_report_service, event_service, portfolio_service, tax_service


def _regime(report, month, regime):
    month_row = next(row for row in report["months"] if row["year_month"] == month)
    return next(row for row in month_row["regimes"] if row["regime"] == regime)


def _setup(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    conn_ctx = get_db(db_path)
    conn = conn_ctx.__enter__()
    portfolio = portfolio_service.create_portfolio(conn, "Principal")
    return db_path, conn_ctx, conn, portfolio


def _close(conn_ctx):
    conn_ctx.__exit__(None, None, None)


def test_action_profit_under_monthly_limit_is_exempt(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        asset = asset_service.create_asset(conn, AssetClass.ACAO.value, "XPTO3", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-01-02", "100", "10000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, "2025-01-20", "100", "11000", gross_value="11000")

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    row = _regime(report, "2025-01", "B3_COMMON_15")
    assert report["months"] == [
        {
            "year_month": "2025-01",
            "month": 1,
            "regimes": report["months"][0]["regimes"],
        }
    ]
    assert row["gross_sale"] == "11000.00"
    assert row["realized_result"] == "1000.00"
    assert row["exempt_gain"] == "1000.00"
    assert row["taxable_result_before_compensation"] == "0.00"
    assert row["taxable_base"] == "0.00"
    assert row["darf_estimated"] == "0.00"
    assert row["initial_loss_carryforward"] == "0.00"
    assert row["final_loss_carryforward"] == "0.00"
    assert row["assets"][0]["fiscal_regime"] == "B3_COMMON_15"
    assert row["assets"][0]["realized_result"] == "1000.00"
    assert row["assets"][0]["theoretical_irrf"] == "0.55"
    assert row["assets"][0]["effective_irrf"] == "0.55"


def test_action_loss_under_monthly_limit_does_not_offset_etf_same_month(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        stock = asset_service.create_asset(conn, AssetClass.ACAO.value, "LOSS3", market="BR")
        etf = asset_service.create_asset(conn, AssetClass.ETF.value, "ETF11", market="BR")
        event_service.create_event(conn, portfolio["id"], stock["id"], EventType.COMPRA.value, "2025-01-02", "100", "10000")
        event_service.create_event(conn, portfolio["id"], stock["id"], EventType.VENDA.value, "2025-01-15", "100", "9000", gross_value="9000")
        event_service.create_event(conn, portfolio["id"], etf["id"], EventType.COMPRA.value, "2025-01-03", "100", "10000")
        event_service.create_event(conn, portfolio["id"], etf["id"], EventType.VENDA.value, "2025-01-18", "100", "11000", gross_value="11000")

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    row = _regime(report, "2025-01", "B3_COMMON_15")
    assert row["realized_result"] == "0.00"
    assert row["taxable_result_before_compensation"] == "1000.00"
    assert row["taxable_base"] == "1000.00"
    assert row["final_loss_carryforward"] == "0.00"


def test_action_above_limit_and_etf_use_common_bucket_chronologically(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        stock = asset_service.create_asset(conn, AssetClass.ACAO.value, "GAIN3", market="BR")
        etf = asset_service.create_asset(conn, AssetClass.ETF.value, "ETF11", market="BR")
        event_service.create_event(conn, portfolio["id"], stock["id"], EventType.COMPRA.value, "2025-01-02", "100", "10000")
        event_service.create_event(conn, portfolio["id"], stock["id"], EventType.VENDA.value, "2025-01-15", "100", "31000", gross_value="31000")
        event_service.create_event(conn, portfolio["id"], etf["id"], EventType.COMPRA.value, "2025-02-03", "100", "10000")
        event_service.create_event(conn, portfolio["id"], etf["id"], EventType.VENDA.value, "2025-02-18", "100", "9000", gross_value="9000")
        event_service.create_event(conn, portfolio["id"], etf["id"], EventType.COMPRA.value, "2025-03-03", "100", "10000")
        event_service.create_event(conn, portfolio["id"], etf["id"], EventType.VENDA.value, "2025-03-18", "100", "11500", gross_value="11500")

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    january = _regime(report, "2025-01", "B3_COMMON_15")
    february = _regime(report, "2025-02", "B3_COMMON_15")
    march = _regime(report, "2025-03", "B3_COMMON_15")
    assert january["exempt_gain"] == "0.00"
    assert january["taxable_base"] == "21000.00"
    assert february["final_loss_carryforward"] == "1000.00"
    assert march["initial_loss_carryforward"] == "1000.00"
    assert march["used_loss"] == "1000.00"
    assert march["taxable_base"] == "500.00"


def test_fii_fi_infra_crypto_and_irrf_override_are_separate(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        fii = asset_service.create_asset(conn, AssetClass.FII.value, "FUND11", market="BR")
        fi_infra = asset_service.create_asset(
            conn,
            AssetClass.FI_INFRA.value,
            "INFRA11",
            market="BR",
            fiscal_tax_treatment="EXEMPT_ZERO",
        )
        crypto = asset_service.create_asset(conn, AssetClass.CRIPTOMOEDA.value, "BTC", market="BR")
        etf = asset_service.create_asset(conn, AssetClass.ETF.value, "ETF11", market="BR")

        event_service.create_event(conn, portfolio["id"], fii["id"], EventType.COMPRA.value, "2025-04-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], fii["id"], EventType.VENDA.value, "2025-04-20", "100", "12000", gross_value="12000")
        event_service.create_event(conn, portfolio["id"], fi_infra["id"], EventType.COMPRA.value, "2025-04-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], fi_infra["id"], EventType.VENDA.value, "2025-04-21", "100", "11000", gross_value="11000")
        event_service.create_event(conn, portfolio["id"], crypto["id"], EventType.COMPRA.value, "2025-04-02", "1", "10000")
        event_service.create_event(conn, portfolio["id"], crypto["id"], EventType.VENDA.value, "2025-04-22", "1", "9500", gross_value="9500")
        conn.execute("UPDATE assets SET currency = 'USD' WHERE id = ?", (crypto["id"],))
        event_service.create_event(conn, portfolio["id"], etf["id"], EventType.COMPRA.value, "2025-05-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], etf["id"], EventType.VENDA.value, "2025-05-20", "100", "11000", gross_value="11000")
        tax_service.upsert_irrf_override(
            conn,
            portfolio_id=portfolio["id"],
            year_month="2025-05",
            regime="B3_COMMON_15",
            effective_irrf="50",
        )

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    fii_row = _regime(report, "2025-04", "B3_FII_FIAGRO_20")
    fi_infra_row = _regime(report, "2025-04", "FI_INFRA_EXEMPT")
    crypto_row = _regime(report, "2025-04", "CRYPTO_GCAP")
    etf_row = _regime(report, "2025-05", "B3_COMMON_15")

    assert fii_row["taxable_base"] == "2000.00"
    assert fii_row["tax_rate"] == "0.2"
    assert fi_infra_row["exempt_gain"] == "1000.00"
    assert fi_infra_row["darf_estimated"] == "0.00"
    assert crypto_row["realized_result"] == "-500.00"
    assert crypto_row["final_loss_carryforward"] == "500.00"
    assert crypto_row["darf_estimated"] == "0.00"
    assert etf_row["irrf_override"] == "50.00"
    assert etf_row["effective_irrf"] == "50.00"
    assert etf_row["assets"][0]["effective_irrf"] == "50.00"
    assert etf_row["darf_estimated"] == "100.00"


def test_supported_override_precedes_crypto_and_unsupported_override_is_rejected(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        crypto = asset_service.create_asset(
            conn,
            AssetClass.CRIPTOMOEDA.value,
            "BTC",
            market="BR",
            fiscal_regime_override="B3_COMMON_15",
        )
        event_service.create_event(conn, portfolio["id"], crypto["id"], EventType.COMPRA.value, "2025-06-01", "1", "10000")
        event_service.create_event(conn, portfolio["id"], crypto["id"], EventType.VENDA.value, "2025-06-20", "1", "12000", gross_value="12000")

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
        try:
            asset_service.create_asset(
                conn,
                AssetClass.ACAO.value,
                "BAD3",
                market="BR",
                fiscal_regime_override="FOREIGN_14754",
            )
        except ValueError as exc:
            unsupported_error = str(exc)
        else:
            unsupported_error = ""
    finally:
        _close(ctx)

    row = _regime(report, "2025-06", "B3_COMMON_15")
    assert row["assets"][0]["fiscal_regime"] == "B3_COMMON_15"
    assert "Regime fiscal nao suportado" in unsupported_error


def test_tax_parameters_are_selected_by_effective_period(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        conn.execute(
            """
            UPDATE fiscal_tax_parameters
            SET valid_until = '2025-06-30'
            WHERE regime = 'B3_COMMON_15' AND valid_from = '1900-01-01'
            """
        )
        conn.execute(
            """
            INSERT INTO fiscal_tax_parameters (
                regime, valid_from, tax_rate, withholding_rate, exemption_limit,
                darf_code, loss_bucket, monthly_darf_enabled
            )
            VALUES ('B3_COMMON_15', '2025-07-01', '0.10', '0.001', '0', '6015', 'B3_COMMON', 1)
            """
        )
        asset = asset_service.create_asset(conn, AssetClass.ETF.value, "ETF11", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-07-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, "2025-07-20", "100", "11000", gross_value="11000")

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    row = _regime(report, "2025-07", "B3_COMMON_15")
    assert row["tax_rate"] == "0.1"
    assert row["theoretical_irrf"] == "11.00"
    assert row["darf_estimated"] == "89.00"


def test_irrf_override_api_lifecycle_and_report_fallback(tmp_path, monkeypatch):
    db_path, ctx, conn, portfolio = _setup(tmp_path)
    try:
        asset = asset_service.create_asset(conn, AssetClass.ETF.value, "ETF11", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-08-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, "2025-08-20", "100", "11000", gross_value="11000")
    finally:
        _close(ctx)

    monkeypatch.setattr("backend.routers.tax.get_db", lambda: get_db(db_path))
    monkeypatch.setattr("backend.routers.reports.get_db", lambda: get_db(db_path))
    client = TestClient(app)

    response = client.put(
        "/api/tax/irrf-overrides",
        json={
            "portfolio_id": portfolio["id"],
            "year_month": "2025-08",
            "regime": "B3_COMMON_15",
            "effective_irrf": "20",
            "notes": "manual",
        },
    )
    assert response.status_code == 200
    override = response.json()
    assert override["effective_irrf"] == "20"

    update_response = client.put(
        "/api/tax/irrf-overrides",
        json={
            "portfolio_id": portfolio["id"],
            "year_month": "2025-08",
            "regime": "B3_COMMON_15",
            "effective_irrf": "50",
        },
    )
    assert update_response.status_code == 200
    assert update_response.json()["id"] == override["id"]
    assert update_response.json()["effective_irrf"] == "50"

    list_response = client.get(f"/api/tax/irrf-overrides?portfolio_id={portfolio['id']}&year=2025")
    assert list_response.status_code == 200
    assert len(list_response.json()) == 1

    negative_response = client.put(
        "/api/tax/irrf-overrides",
        json={
            "portfolio_id": portfolio["id"],
            "year_month": "2025-08",
            "regime": "B3_COMMON_15",
            "effective_irrf": "-1",
        },
    )
    assert negative_response.status_code == 400

    unsupported_response = client.put(
        "/api/tax/irrf-overrides",
        json={
            "portfolio_id": portfolio["id"],
            "year_month": "2025-08",
            "regime": "FOREIGN_14754",
            "effective_irrf": "1",
        },
    )
    assert unsupported_response.status_code == 400

    report_response = client.get(f"/api/reports/capital-gains?portfolio_id={portfolio['id']}&year=2025")
    assert report_response.status_code == 200
    row = _regime(report_response.json(), "2025-08", "B3_COMMON_15")
    assert row["theoretical_irrf"] == "0.55"
    assert row["irrf_override"] == "50.00"
    assert row["effective_irrf"] == "50.00"
    assert row["darf_estimated"] == "100.00"

    delete_response = client.delete(f"/api/tax/irrf-overrides/{override['id']}")
    assert delete_response.status_code == 200

    fallback_response = client.get(f"/api/reports/capital-gains?portfolio_id={portfolio['id']}&year=2025")
    row = _regime(fallback_response.json(), "2025-08", "B3_COMMON_15")
    assert row["irrf_override"] is None
    assert row["effective_irrf"] == "0.55"
