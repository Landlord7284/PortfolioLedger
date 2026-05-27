from fastapi.testclient import TestClient
import pytest

from backend.database import get_db, init_db
from backend.domain.enums import AssetClass, EventType
from backend.main import app
from backend.services import asset_service, capital_gain_report_service, event_service, portfolio_service, tax_service


def _regime(report, month, regime):
    month_row = next(row for row in report["months"] if row["year_month"] == month)
    return next(row for row in month_row["regimes"] if row["regime"] == regime)


def _month(report, month):
    return next(row for row in report["months"] if row["year_month"] == month)


def _darf_suggestion(report, month, darf_code, regime=None):
    month_row = _month(report, month)
    matches = [
        row
        for row in month_row["darf_suggestions"]
        if row["darf_code"] == darf_code and (regime is None or row["regime"] == regime)
    ]
    assert len(matches) == 1
    return matches[0]


def _setup(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    conn_ctx = get_db(db_path)
    conn = conn_ctx.__enter__()
    portfolio = portfolio_service.create_portfolio(conn, "Principal")
    return db_path, conn_ctx, conn, portfolio


def _close(conn_ctx):
    conn_ctx.__exit__(None, None, None)


def test_capital_gains_route_returns_annual_contract_and_keeps_january_snapshot(tmp_path, monkeypatch):
    db_path, ctx, conn, portfolio = _setup(tmp_path)
    try:
        asset = asset_service.create_asset(conn, AssetClass.ACAO.value, "XPTO3", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-01-02", "100", "10000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-02-02", "10", "1000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, "2025-03-20", "100", "11000", gross_value="11000")
    finally:
        _close(ctx)

    monkeypatch.setattr("backend.routers.reports.get_db", lambda: get_db(db_path))
    client = TestClient(app)

    response = client.get(f"/api/reports/capital-gains?portfolio_id={portfolio['id']}&year=2025")

    assert response.status_code == 200
    body = response.json()
    assert body["portfolio_id"] == portfolio["id"]
    assert body["year"] == 2025
    assert [month["year_month"] for month in body["months"]] == ["2025-01", "2025-03"]
    month = body["months"][1]
    assert month["month"] == 3
    assert month["regimes"]
    regime = month["regimes"][0]
    assert regime["regime"] == "B3_COMMON_15"
    assert regime["assets"]
    assert regime["assets"][0]["asset_id"] == asset["id"]


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
            "darf_suggestions": [],
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
    assert row["effective_irrf"] == "0.55"
    assert row["assets"][0]["effective_irrf"] == "0.55"


def test_january_snapshot_is_included_without_current_month_events_to_show_prior_loss(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        asset = asset_service.create_asset(conn, AssetClass.ETF.value, "LOSS11", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2024-12-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, "2024-12-20", "100", "9500", gross_value="9500")

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    assert [month["year_month"] for month in report["months"]] == ["2025-01"]
    row = _regime(report, "2025-01", "B3_COMMON_15")
    assert row["initial_loss_carryforward"] == "500.00"
    assert row["final_loss_carryforward"] == "500.00"
    assert row["realized_result"] == "0.00"


def test_neutral_exempt_stock_month_after_january_without_irrf_is_omitted(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        conn.execute(
            """
            UPDATE fiscal_tax_parameters
            SET withholding_rate = '0'
            WHERE regime = 'B3_COMMON_15'
            """
        )
        asset = asset_service.create_asset(conn, AssetClass.ACAO.value, "XPTO3", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-02-02", "100", "10000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, "2025-02-20", "100", "11500", gross_value="11500")

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    assert [month["year_month"] for month in report["months"]] == ["2025-01"]


def test_exempt_stock_month_with_irrf_is_included_for_audit(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        asset = asset_service.create_asset(conn, AssetClass.ACAO.value, "XPTO3", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-02-02", "100", "6000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, "2025-02-20", "100", "9000", gross_value="9000")

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    assert [month["year_month"] for month in report["months"]] == ["2025-01", "2025-02"]
    row = _regime(report, "2025-02", "B3_COMMON_15")
    assert row["exempt_gain"] == "3000.00"
    assert row["taxable_result_before_compensation"] == "0.00"
    assert row["darf_estimated"] == "0.00"
    assert row["effective_irrf"] == "0.45"


def test_loss_month_without_irrf_is_included_to_show_loss_origin(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        conn.execute(
            """
            UPDATE fiscal_tax_parameters
            SET withholding_rate = '0'
            WHERE regime = 'B3_COMMON_15'
            """
        )
        asset = asset_service.create_asset(conn, AssetClass.ACAO.value, "LOSS3", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-03-02", "100", "10000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, "2025-03-20", "100", "9500", gross_value="9500")

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    assert [month["year_month"] for month in report["months"]] == ["2025-01", "2025-03"]
    row = _regime(report, "2025-03", "B3_COMMON_15")
    assert row["taxable_result_before_compensation"] == "-500.00"
    assert row["darf_estimated"] == "0.00"
    assert row["effective_irrf"] == "0.00"
    assert row["final_loss_carryforward"] == "500.00"


def test_action_loss_under_monthly_limit_increases_loss_carryforward(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        asset = asset_service.create_asset(conn, AssetClass.ACAO.value, "LOSS3", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-01-02", "100", "10000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, "2025-01-20", "100", "9000", gross_value="9000")

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    row = _regime(report, "2025-01", "B3_COMMON_15")
    assert row["gross_sale"] == "9000.00"
    assert row["realized_result"] == "-1000.00"
    assert row["exempt_gain"] == "0.00"
    assert row["taxable_result_before_compensation"] == "-1000.00"
    assert row["taxable_base"] == "0.00"
    assert row["final_loss_carryforward"] == "1000.00"


def test_action_loss_under_monthly_limit_offsets_etf_same_month(tmp_path):
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
    assert row["taxable_result_before_compensation"] == "0.00"
    assert row["taxable_base"] == "0.00"
    assert row["darf_estimated"] == "0.00"
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
    assert january["tax_rate"] == "0.15"
    assert january["tax_due"] == "3150.00"
    assert january["theoretical_irrf"] == "1.55"
    assert january["effective_irrf"] == "1.55"
    assert january["darf_estimated"] == "3148.45"
    assert january["taxable_base"] == "21000.00"
    assert february["final_loss_carryforward"] == "1000.00"
    assert march["initial_loss_carryforward"] == "1000.00"
    assert march["used_loss"] == "1000.00"
    assert march["taxable_base"] == "500.00"


def test_etf_and_bdr_are_common_taxable_without_stock_exemption(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        etf = asset_service.create_asset(conn, AssetClass.ETF.value, "ETF11", market="BR")
        bdr = asset_service.create_asset(conn, AssetClass.BDR.value, "AAPL34", market="BR")
        event_service.create_event(conn, portfolio["id"], etf["id"], EventType.COMPRA.value, "2025-02-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], etf["id"], EventType.VENDA.value, "2025-02-20", "100", "11000", gross_value="11000")
        event_service.create_event(conn, portfolio["id"], bdr["id"], EventType.COMPRA.value, "2025-02-02", "100", "5000")
        event_service.create_event(conn, portfolio["id"], bdr["id"], EventType.VENDA.value, "2025-02-21", "100", "6000", gross_value="6000")

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    row = _regime(report, "2025-02", "B3_COMMON_15")
    assert row["gross_sale"] == "17000.00"
    assert row["exempt_gain"] == "0.00"
    assert row["taxable_base"] == "2000.00"
    assert row["darf_estimated"] == "299.15"
    assert {asset["asset_class"]: asset["fiscal_regime"] for asset in row["assets"]} == {
        AssetClass.BDR.value: "B3_COMMON_15",
        AssetClass.ETF.value: "B3_COMMON_15",
    }


def test_fii_fi_infra_crypto_and_irrf_override_are_separate(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        fii = asset_service.create_asset(conn, AssetClass.FII.value, "FUND11", market="BR")
        fi_infra = asset_service.create_asset(
            conn,
            AssetClass.FI_INFRA.value,
            "INFRA11",
            market="BR",
        )
        crypto = asset_service.create_asset(conn, AssetClass.CRIPTOMOEDA.value, "BTC", market="BR")
        etf = asset_service.create_asset(conn, AssetClass.ETF.value, "ETF11", market="BR")
        common = asset_service.create_asset(conn, AssetClass.ETF.value, "LOSS11", market="BR")

        event_service.create_event(conn, portfolio["id"], fii["id"], EventType.COMPRA.value, "2025-04-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], fii["id"], EventType.VENDA.value, "2025-04-20", "100", "12000", gross_value="12000")
        event_service.create_event(conn, portfolio["id"], common["id"], EventType.COMPRA.value, "2025-04-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], common["id"], EventType.VENDA.value, "2025-04-20", "100", "9000", gross_value="9000")
        event_service.create_event(conn, portfolio["id"], fi_infra["id"], EventType.COMPRA.value, "2025-04-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], fi_infra["id"], EventType.VENDA.value, "2025-04-21", "100", "11000", gross_value="11000")
        event_service.create_event(conn, portfolio["id"], crypto["id"], EventType.COMPRA.value, "2025-04-02", "1", "10000")
        event_service.create_event(conn, portfolio["id"], crypto["id"], EventType.VENDA.value, "2025-04-22", "1", "9500", gross_value="9500")
        conn.execute("UPDATE assets SET currency = 'USD' WHERE id = ?", (crypto["id"],))
        event_service.create_event(conn, portfolio["id"], etf["id"], EventType.COMPRA.value, "2025-03-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], etf["id"], EventType.VENDA.value, "2025-03-20", "100", "11000", gross_value="11000")
        tax_service.upsert_irrf_override(
            conn,
            portfolio_id=portfolio["id"],
            year_month="2025-03",
            regime="B3_COMMON_15",
            effective_irrf="50",
        )

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    fii_row = _regime(report, "2025-04", "B3_FII_FIAGRO_20")
    common_row = _regime(report, "2025-04", "B3_COMMON_15")
    fi_infra_row = _regime(report, "2025-04", "FI_INFRA_EXEMPT")
    crypto_row = _regime(report, "2025-04", "CRYPTO_GCAP")
    etf_row = _regime(report, "2025-03", "B3_COMMON_15")

    assert fii_row["taxable_base"] == "2000.00"
    assert fii_row["tax_rate"] == "0.2"
    assert _darf_suggestion(report, "2025-04", "6015", "B3_FII_FIAGRO_20")["darf_estimated"] == "399.40"
    assert common_row["final_loss_carryforward"] == "1000.00"
    assert fii_row["initial_loss_carryforward"] == "0.00"
    assert fii_row["used_loss"] == "0.00"
    assert fi_infra_row["exempt_gain"] == "1000.00"
    assert fi_infra_row["taxable_base"] == "0.00"
    assert fi_infra_row["darf_estimated"] == "0.00"
    assert fi_infra_row["final_loss_carryforward"] == "0.00"
    assert fi_infra_row["assets"][0]["exempt_gain"] == "1000.00"
    assert crypto_row["gross_sale"] == "9500.00"
    assert crypto_row["cost_basis"] == "10000.00"
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


def test_us_or_usd_assets_are_deferred_and_do_not_enter_initial_capital_gain_engine(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        us_stock = asset_service.create_asset(conn, AssetClass.ACAO.value, "AAPL", market="BR")
        usd_asset = asset_service.create_asset(conn, AssetClass.ETF.value, "USD11", market="BR")

        for asset in [us_stock, usd_asset]:
            event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-06-01", "10", "1000")
            event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, "2025-06-20", "10", "1200", gross_value="1200")
        conn.execute("UPDATE assets SET market = 'US', currency = 'USD' WHERE id = ?", (us_stock["id"],))
        conn.execute("UPDATE assets SET currency = 'USD' WHERE id = ?", (usd_asset["id"],))

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    assert [month["year_month"] for month in report["months"]] == ["2025-01"]
    assert _regime(report, "2025-01", "B3_COMMON_15")["assets"] == []


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


def test_fi_infra_follows_tax_parameter_effective_period_without_asset_treatment(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        conn.execute(
            """
            UPDATE fiscal_tax_parameters
            SET valid_until = '2025-06-30'
            WHERE regime = 'FI_INFRA_EXEMPT' AND valid_from = '1900-01-01'
            """
        )
        conn.execute(
            """
            INSERT INTO fiscal_tax_parameters (
                regime, valid_from, tax_rate, withholding_rate, exemption_limit,
                darf_code, loss_bucket, monthly_darf_enabled
            )
            VALUES ('FI_INFRA_EXEMPT', '2025-07-01', '0.20', '0', NULL, '6015', 'FI_INFRA', 1)
            """
        )
        asset = asset_service.create_asset(conn, AssetClass.FI_INFRA.value, "INFRA11", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-07-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, "2025-07-20", "100", "11000", gross_value="11000")

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    row = _regime(report, "2025-07", "FI_INFRA_EXEMPT")
    assert row["tax_rate"] == "0.2"
    assert row["realized_result"] == "1000.00"
    assert row["exempt_gain"] == "0.00"
    assert row["taxable_base"] == "1000.00"
    assert row["darf_estimated"] == "200.00"
    assert row["assets"][0]["exempt_gain"] == "0.00"


def test_fi_infra_zero_tax_rate_is_exempt_even_with_monthly_darf_enabled(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        conn.execute(
            """
            UPDATE fiscal_tax_parameters
            SET tax_rate = '0', darf_code = '6015', monthly_darf_enabled = 1
            WHERE regime = 'FI_INFRA_EXEMPT' AND valid_from = '1900-01-01'
            """
        )
        asset = asset_service.create_asset(conn, AssetClass.FI_INFRA.value, "INFRA11", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-01-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, "2025-01-20", "100", "11000", gross_value="11000")

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    row = _regime(report, "2025-01", "FI_INFRA_EXEMPT")
    assert row["realized_result"] == "1000.00"
    assert row["exempt_gain"] == "1000.00"
    assert row["taxable_base"] == "0.00"
    assert row["darf_estimated"] == "0.00"
    assert row["assets"][0]["exempt_gain"] == "1000.00"


def test_irrf_override_api_lifecycle_and_report_fallback(tmp_path, monkeypatch):
    db_path, ctx, conn, portfolio = _setup(tmp_path)
    try:
        asset = asset_service.create_asset(conn, AssetClass.ETF.value, "ETF11", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-08-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, "2025-08-20", "100", "11000", gross_value="11000")
        other = tax_service.upsert_irrf_override(
            conn,
            portfolio_id=portfolio["id"],
            year_month="2025-09",
            regime="B3_COMMON_15",
            effective_irrf="30",
        )
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
    assert len(list_response.json()) == 2

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
    invalid_month_response = client.put(
        "/api/tax/irrf-overrides",
        json={
            "portfolio_id": portfolio["id"],
            "year_month": "2025-13",
            "regime": "B3_COMMON_15",
            "effective_irrf": "1",
        },
    )
    assert invalid_month_response.status_code == 400
    missing_portfolio_response = client.put(
        "/api/tax/irrf-overrides",
        json={
            "portfolio_id": 999999,
            "year_month": "2025-08",
            "regime": "B3_COMMON_15",
            "effective_irrf": "1",
        },
    )
    assert missing_portfolio_response.status_code == 400

    report_response = client.get(f"/api/reports/capital-gains?portfolio_id={portfolio['id']}&year=2025")
    assert report_response.status_code == 200
    row = _regime(report_response.json(), "2025-08", "B3_COMMON_15")
    assert row["theoretical_irrf"] == "0.55"
    assert row["irrf_override"] == "50.00"
    assert row["effective_irrf"] == "50.00"
    assert row["darf_estimated"] == "100.00"

    delete_response = client.delete(f"/api/tax/irrf-overrides/{override['id']}")
    assert delete_response.status_code == 200
    list_after_delete_response = client.get(f"/api/tax/irrf-overrides?portfolio_id={portfolio['id']}&year=2025")
    assert [item["id"] for item in list_after_delete_response.json()] == [other["id"]]

    fallback_response = client.get(f"/api/reports/capital-gains?portfolio_id={portfolio['id']}&year=2025")
    row = _regime(fallback_response.json(), "2025-08", "B3_COMMON_15")
    assert row["irrf_override"] is None
    assert row["effective_irrf"] == "0.55"


def test_manual_tax_paid_override_replaces_only_payable_tax_and_zero_falls_back(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        conn.execute(
            """
            UPDATE fiscal_tax_parameters
            SET tax_rate = '0.01', withholding_rate = '0', exemption_limit = '0', minimum_darf_amount = '10.00'
            WHERE regime = 'B3_COMMON_15'
            """
        )
        asset = asset_service.create_asset(conn, AssetClass.ETF.value, "ETF11", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-01-02", "100", "10000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, "2025-01-20", "100", "20000", gross_value="20000")
        tax_service.upsert_capital_gain_tax_paid_override(
            conn,
            portfolio_id=portfolio["id"],
            year_month="2025-01",
            regime="B3_COMMON_15",
            manual_tax_paid="80",
        )

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
        tax_service.upsert_capital_gain_tax_paid_override(
            conn,
            portfolio_id=portfolio["id"],
            year_month="2025-01",
            regime="B3_COMMON_15",
            manual_tax_paid="0",
        )
        fallback_report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    row = _regime(report, "2025-01", "B3_COMMON_15")
    suggestion = _darf_suggestion(report, "2025-01", "6015")
    assert row["tax_due"] == "100.00"
    assert row["calculated_net_tax_payable"] == "100.00"
    assert row["manual_tax_paid"] == "80.00"
    assert row["net_tax_payable"] == "80.00"
    assert suggestion["current_month_net_tax"] == "80.00"
    assert suggestion["darf_estimated"] == "80.00"

    fallback_row = _regime(fallback_report, "2025-01", "B3_COMMON_15")
    fallback_suggestion = _darf_suggestion(fallback_report, "2025-01", "6015")
    assert fallback_row["manual_tax_paid"] is None
    assert fallback_row["net_tax_payable"] == "100.00"
    assert fallback_suggestion["darf_estimated"] == "100.00"


def test_manual_capital_gain_event_enters_report_without_ledger_event(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        manual = tax_service.create_capital_gain_manual_event(
            conn,
            {
                "portfolio_id": portfolio["id"],
                "year_month": "2025-05",
                "regime": "B3_COMMON_15",
                "ticker": "DIREITO XPTO",
                "gross_sale": "500",
                "realized_result": "200",
            },
        )

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
        ledger_count = conn.execute("SELECT COUNT(*) AS count FROM events").fetchone()["count"]
    finally:
        _close(ctx)

    row = _regime(report, "2025-05", "B3_COMMON_15")
    asset = row["assets"][0]
    assert ledger_count == 0
    assert row["gross_sale"] == "500.00"
    assert row["realized_result"] == "200.00"
    assert row["taxable_result_before_compensation"] == "200.00"
    assert row["taxable_base"] == "200.00"
    assert row["tax_due"] == "30.00"
    assert asset["manual_event_id"] == manual["id"]
    assert asset["is_manual"] is True
    assert asset["ticker"] == "DIREITO XPTO"
    assert asset["asset_id"] == -manual["id"]


def test_loss_carryforward_crosses_year_by_bucket(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        asset = asset_service.create_asset(conn, AssetClass.ETF.value, "ETF11", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2024-11-01", "100", "10000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, "2024-12-20", "100", "9000", gross_value="9000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-01-02", "100", "10000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, "2025-01-20", "100", "11500", gross_value="11500")

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    row = _regime(report, "2025-01", "B3_COMMON_15")
    assert [month["year_month"] for month in report["months"]] == ["2025-01"]
    assert row["initial_loss_carryforward"] == "1000.00"
    assert row["used_loss"] == "1000.00"
    assert row["taxable_base"] == "500.00"
    assert row["final_loss_carryforward"] == "0.00"


def test_irrf_credit_carries_within_year_and_resets_next_year(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        asset = asset_service.create_asset(conn, AssetClass.ETF.value, "ETF11", market="BR")
        for date, sale in [
            ("2025-01-20", "11000"),
            ("2025-02-20", "11000"),
            ("2025-12-20", "11000"),
            ("2026-01-20", "11000"),
        ]:
            event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, date[:8] + "01", "100", "10000")
            event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, date, "100", sale, gross_value=sale)
        tax_service.upsert_irrf_override(
            conn,
            portfolio_id=portfolio["id"],
            year_month="2025-01",
            regime="B3_COMMON_15",
            effective_irrf="200",
        )
        tax_service.upsert_irrf_override(
            conn,
            portfolio_id=portfolio["id"],
            year_month="2025-12",
            regime="B3_COMMON_15",
            effective_irrf="200",
        )

        report_2025 = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
        report_2026 = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2026)
    finally:
        _close(ctx)

    january = _regime(report_2025, "2025-01", "B3_COMMON_15")
    february = _regime(report_2025, "2025-02", "B3_COMMON_15")
    december = _regime(report_2025, "2025-12", "B3_COMMON_15")
    next_january = _regime(report_2026, "2026-01", "B3_COMMON_15")

    assert january["tax_due"] == "150.00"
    assert january["used_irrf"] == "150.00"
    assert january["final_irrf_carryforward"] == "50.00"
    assert january["darf_estimated"] == "0.00"
    assert february["initial_irrf_carryforward"] == "50.00"
    assert february["used_irrf"] == "50.55"
    assert february["darf_estimated"] == "99.45"
    assert december["final_irrf_carryforward"] == "50.00"
    assert next_january["initial_irrf_carryforward"] == "0.00"
    assert next_january["used_irrf"] == "0.55"
    assert next_january["darf_estimated"] == "149.45"


def test_minimum_darf_defers_until_threshold_and_crosses_year(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        conn.execute(
            """
            UPDATE fiscal_tax_parameters
            SET tax_rate = '0.001', withholding_rate = '0', exemption_limit = '0'
            WHERE regime = 'B3_COMMON_15'
            """
        )
        asset = asset_service.create_asset(conn, AssetClass.ETF.value, "ETF11", market="BR")
        for date in ["2025-01-20", "2025-02-20", "2025-12-20", "2026-01-20"]:
            event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, date[:8] + "01", "100", "10000")
            event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, date, "100", "15000", gross_value="15000")

        report_2025 = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
        report_2026 = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2026)
    finally:
        _close(ctx)

    january = _regime(report_2025, "2025-01", "B3_COMMON_15")
    february = _regime(report_2025, "2025-02", "B3_COMMON_15")
    december = _regime(report_2025, "2025-12", "B3_COMMON_15")
    next_january = _regime(report_2026, "2026-01", "B3_COMMON_15")

    assert january["tax_due"] == "5.00"
    assert january["minimum_darf_amount"] == "10.00"
    assert january["darf_before_minimum"] == "5.00"
    assert january["darf_estimated"] == "0.00"
    assert january["final_darf_carryforward"] == "5.00"
    assert february["initial_darf_carryforward"] == "5.00"
    assert february["darf_before_minimum"] == "10.00"
    assert february["darf_estimated"] == "10.00"
    assert february["final_darf_carryforward"] == "0.00"
    assert december["final_darf_carryforward"] == "5.00"
    assert next_january["initial_darf_carryforward"] == "5.00"
    assert next_january["darf_estimated"] == "10.00"


def test_minimum_darf_carryforward_is_separate_by_regime_after_regime_irrf(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        conn.execute(
            """
            UPDATE fiscal_tax_parameters
            SET tax_rate = '0.0006', withholding_rate = '0', exemption_limit = '0',
                minimum_darf_amount = '10.00', darf_code = '6015', monthly_darf_enabled = 1
            WHERE regime = 'B3_COMMON_15'
            """
        )
        conn.execute(
            """
            UPDATE fiscal_tax_parameters
            SET tax_rate = '0.001', withholding_rate = '0',
                minimum_darf_amount = '10.00', darf_code = '6015', monthly_darf_enabled = 1
            WHERE regime = 'B3_FII_FIAGRO_20'
            """
        )
        common = asset_service.create_asset(conn, AssetClass.ETF.value, "ETF11", market="BR")
        fii = asset_service.create_asset(conn, AssetClass.FII.value, "FUND11", market="BR")
        event_service.create_event(conn, portfolio["id"], common["id"], EventType.COMPRA.value, "2025-01-02", "100", "10000")
        event_service.create_event(conn, portfolio["id"], common["id"], EventType.VENDA.value, "2025-01-20", "100", "20000", gross_value="20000")
        event_service.create_event(conn, portfolio["id"], fii["id"], EventType.COMPRA.value, "2025-01-02", "100", "10000")
        event_service.create_event(conn, portfolio["id"], fii["id"], EventType.VENDA.value, "2025-01-20", "100", "15000", gross_value="15000")
        tax_service.upsert_irrf_override(conn, portfolio_id=portfolio["id"], year_month="2025-01", regime="B3_COMMON_15", effective_irrf="0.50")
        tax_service.upsert_irrf_override(conn, portfolio_id=portfolio["id"], year_month="2025-01", regime="B3_FII_FIAGRO_20", effective_irrf="0.10")

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    common_row = _regime(report, "2025-01", "B3_COMMON_15")
    fii_row = _regime(report, "2025-01", "B3_FII_FIAGRO_20")
    common_suggestion = _darf_suggestion(report, "2025-01", "6015", "B3_COMMON_15")
    fii_suggestion = _darf_suggestion(report, "2025-01", "6015", "B3_FII_FIAGRO_20")

    assert common_row["tax_due"] == "6.00"
    assert common_row["used_irrf"] == "0.50"
    assert common_row["net_tax_payable"] == "5.50"
    assert fii_row["tax_due"] == "5.00"
    assert fii_row["used_irrf"] == "0.10"
    assert fii_row["net_tax_payable"] == "4.90"
    assert common_suggestion["regime"] == "B3_COMMON_15"
    assert common_suggestion["current_month_net_tax"] == "5.50"
    assert common_suggestion["darf_before_minimum"] == "5.50"
    assert common_suggestion["darf_estimated"] == "0.00"
    assert common_suggestion["final_darf_carryforward"] == "5.50"
    assert fii_suggestion["regime"] == "B3_FII_FIAGRO_20"
    assert fii_suggestion["current_month_net_tax"] == "4.90"
    assert fii_suggestion["darf_before_minimum"] == "4.90"
    assert fii_suggestion["darf_estimated"] == "0.00"
    assert fii_suggestion["final_darf_carryforward"] == "4.90"


def test_minimum_darf_carryforward_is_not_shared_by_6015_across_regimes_and_months(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        conn.execute(
            """
            UPDATE fiscal_tax_parameters
            SET tax_rate = '0.001', withholding_rate = '0', minimum_darf_amount = '10.00',
                darf_code = '6015', monthly_darf_enabled = 1
            WHERE regime = 'B3_FII_FIAGRO_20'
            """
        )
        conn.execute(
            """
            UPDATE fiscal_tax_parameters
            SET tax_rate = '0.01', withholding_rate = '0', exemption_limit = '0',
                minimum_darf_amount = '10.00', darf_code = '6015', monthly_darf_enabled = 1
            WHERE regime = 'B3_COMMON_15'
            """
        )
        fii = asset_service.create_asset(conn, AssetClass.FII.value, "FUND11", market="BR")
        common = asset_service.create_asset(conn, AssetClass.ETF.value, "ETF11", market="BR")
        event_service.create_event(conn, portfolio["id"], fii["id"], EventType.COMPRA.value, "2025-01-02", "100", "10000")
        event_service.create_event(conn, portfolio["id"], fii["id"], EventType.VENDA.value, "2025-01-20", "100", "15000", gross_value="15000")
        event_service.create_event(conn, portfolio["id"], common["id"], EventType.COMPRA.value, "2025-02-02", "100", "10000")
        event_service.create_event(conn, portfolio["id"], common["id"], EventType.VENDA.value, "2025-02-20", "100", "20000", gross_value="20000")

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    january = _darf_suggestion(report, "2025-01", "6015", "B3_FII_FIAGRO_20")
    february = _darf_suggestion(report, "2025-02", "6015", "B3_COMMON_15")
    assert january["current_month_net_tax"] == "5.00"
    assert january["darf_before_minimum"] == "5.00"
    assert january["darf_estimated"] == "0.00"
    assert january["final_darf_carryforward"] == "5.00"
    assert february["initial_darf_carryforward"] == "0.00"
    assert february["current_month_net_tax"] == "100.00"
    assert february["darf_before_minimum"] == "100.00"
    assert february["darf_estimated"] == "100.00"
    assert february["final_darf_carryforward"] == "0.00"


def test_irrf_carryforward_is_not_shared_between_common_and_fii_even_with_same_darf_code(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        conn.execute(
            """
            UPDATE fiscal_tax_parameters
            SET tax_rate = '0.0006', withholding_rate = '0', exemption_limit = '0',
                minimum_darf_amount = '10.00', darf_code = '6015', monthly_darf_enabled = 1
            WHERE regime = 'B3_COMMON_15'
            """
        )
        conn.execute(
            """
            UPDATE fiscal_tax_parameters
            SET tax_rate = '0.001', withholding_rate = '0',
                minimum_darf_amount = '10.00', darf_code = '6015', monthly_darf_enabled = 1
            WHERE regime = 'B3_FII_FIAGRO_20'
            """
        )
        common = asset_service.create_asset(conn, AssetClass.ETF.value, "ETF11", market="BR")
        fii = asset_service.create_asset(conn, AssetClass.FII.value, "FUND11", market="BR")
        event_service.create_event(conn, portfolio["id"], common["id"], EventType.COMPRA.value, "2025-01-02", "100", "10000")
        event_service.create_event(conn, portfolio["id"], common["id"], EventType.VENDA.value, "2025-01-20", "100", "20000", gross_value="20000")
        event_service.create_event(conn, portfolio["id"], fii["id"], EventType.COMPRA.value, "2025-01-02", "100", "10000")
        event_service.create_event(conn, portfolio["id"], fii["id"], EventType.VENDA.value, "2025-01-20", "100", "15000", gross_value="15000")
        tax_service.upsert_irrf_override(conn, portfolio_id=portfolio["id"], year_month="2025-01", regime="B3_COMMON_15", effective_irrf="10.00")
        tax_service.upsert_irrf_override(conn, portfolio_id=portfolio["id"], year_month="2025-01", regime="B3_FII_FIAGRO_20", effective_irrf="0.00")

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    common_row = _regime(report, "2025-01", "B3_COMMON_15")
    fii_row = _regime(report, "2025-01", "B3_FII_FIAGRO_20")
    suggestion = _darf_suggestion(report, "2025-01", "6015", "B3_FII_FIAGRO_20")

    assert common_row["tax_due"] == "6.00"
    assert common_row["used_irrf"] == "6.00"
    assert common_row["final_irrf_carryforward"] == "4.00"
    assert common_row["net_tax_payable"] == "0.00"
    assert fii_row["tax_due"] == "5.00"
    assert fii_row["used_irrf"] == "0.00"
    assert fii_row["final_irrf_carryforward"] == "0.00"
    assert fii_row["net_tax_payable"] == "5.00"
    assert suggestion["current_month_net_tax"] == "5.00"
    assert suggestion["darf_estimated"] == "0.00"
    assert suggestion["final_darf_carryforward"] == "5.00"


def test_fii_darf_uses_only_fii_irrf_when_common_has_irrf_carryforward(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        conn.execute(
            """
            UPDATE fiscal_tax_parameters
            SET tax_rate = '0.20', withholding_rate = '0', minimum_darf_amount = '10.00',
                darf_code = '6015', monthly_darf_enabled = 1
            WHERE regime = 'B3_FII_FIAGRO_20'
            """
        )
        fii = asset_service.create_asset(conn, AssetClass.FII.value, "FUND11", market="BR")
        event_service.create_event(conn, portfolio["id"], fii["id"], EventType.COMPRA.value, "2025-02-02", "100", "10000")
        event_service.create_event(conn, portfolio["id"], fii["id"], EventType.VENDA.value, "2025-02-20", "100", "10100", gross_value="10100")
        tax_service.upsert_irrf_override(conn, portfolio_id=portfolio["id"], year_month="2025-01", regime="B3_COMMON_15", effective_irrf="5.00")
        tax_service.upsert_irrf_override(conn, portfolio_id=portfolio["id"], year_month="2025-01", regime="B3_FII_FIAGRO_20", effective_irrf="3.00")
        tax_service.upsert_irrf_override(conn, portfolio_id=portfolio["id"], year_month="2025-02", regime="B3_COMMON_15", effective_irrf="0.00")

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    common_row = _regime(report, "2025-02", "B3_COMMON_15")
    fii_row = _regime(report, "2025-02", "B3_FII_FIAGRO_20")
    fii_suggestion = _darf_suggestion(report, "2025-02", "6015", "B3_FII_FIAGRO_20")

    assert common_row["initial_irrf_carryforward"] == "5.00"
    assert common_row["final_irrf_carryforward"] == "5.00"
    assert fii_row["tax_due"] == "20.00"
    assert fii_row["initial_irrf_carryforward"] == "3.00"
    assert fii_row["used_irrf"] == "3.00"
    assert fii_row["net_tax_payable"] == "17.00"
    assert fii_suggestion["regime"] == "B3_FII_FIAGRO_20"
    assert fii_suggestion["darf_code"] == "6015"
    assert fii_suggestion["darf_estimated"] == "17.00"


def test_stock_sale_above_exemption_uses_withholding_and_accumulates_small_darf(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        asset = asset_service.create_asset(conn, AssetClass.ACAO.value, "XPTO3", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-03-02", "1", "21000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, "2025-03-20", "1", "21018", gross_value="21018")

        report = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
    finally:
        _close(ctx)

    row = _regime(report, "2025-03", "B3_COMMON_15")
    suggestion = _darf_suggestion(report, "2025-03", "6015", "B3_COMMON_15")

    assert row["gross_sale"] == "21018.00"
    assert row["taxable_base"] == "18.00"
    assert row["tax_due"] == "2.70"
    assert row["effective_irrf"] == "1.05"
    assert row["used_irrf"] == "1.05"
    assert row["net_tax_payable"] == "1.65"
    assert row["darf_estimated"] == "0.00"
    assert row["final_darf_carryforward"] == "1.65"
    assert suggestion["regime"] == "B3_COMMON_15"
    assert suggestion["darf_estimated"] == "0.00"
    assert suggestion["final_darf_carryforward"] == "1.65"


def test_irrf_resets_at_year_end_and_darf_carryforward_stays_separate_by_regime(tmp_path):
    _, ctx, conn, portfolio = _setup(tmp_path)
    try:
        conn.execute(
            """
            UPDATE fiscal_tax_parameters
            SET tax_rate = '0.0006', withholding_rate = '0', exemption_limit = '0',
                minimum_darf_amount = '10.00', darf_code = '6015', monthly_darf_enabled = 1
            WHERE regime = 'B3_COMMON_15'
            """
        )
        conn.execute(
            """
            UPDATE fiscal_tax_parameters
            SET tax_rate = '0.001', withholding_rate = '0',
                minimum_darf_amount = '10.00', darf_code = '6015', monthly_darf_enabled = 1
            WHERE regime = 'B3_FII_FIAGRO_20'
            """
        )
        common = asset_service.create_asset(conn, AssetClass.ETF.value, "ETF11", market="BR")
        fii = asset_service.create_asset(conn, AssetClass.FII.value, "FUND11", market="BR")
        event_service.create_event(conn, portfolio["id"], common["id"], EventType.COMPRA.value, "2025-12-02", "100", "10000")
        event_service.create_event(conn, portfolio["id"], common["id"], EventType.VENDA.value, "2025-12-20", "100", "20000", gross_value="20000")
        event_service.create_event(conn, portfolio["id"], fii["id"], EventType.COMPRA.value, "2025-12-02", "100", "10000")
        event_service.create_event(conn, portfolio["id"], fii["id"], EventType.VENDA.value, "2025-12-20", "100", "15000", gross_value="15000")
        event_service.create_event(conn, portfolio["id"], common["id"], EventType.COMPRA.value, "2026-01-02", "100", "10000")
        event_service.create_event(conn, portfolio["id"], common["id"], EventType.VENDA.value, "2026-01-20", "100", "20000", gross_value="20000")
        tax_service.upsert_irrf_override(conn, portfolio_id=portfolio["id"], year_month="2025-12", regime="B3_COMMON_15", effective_irrf="10.00")

        report_2025 = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2025)
        report_2026 = capital_gain_report_service.list_capital_gains(conn, portfolio["id"], 2026)
    finally:
        _close(ctx)

    december_common = _regime(report_2025, "2025-12", "B3_COMMON_15")
    december_darf = _darf_suggestion(report_2025, "2025-12", "6015", "B3_FII_FIAGRO_20")
    next_january_common = _regime(report_2026, "2026-01", "B3_COMMON_15")
    next_january_darf = _darf_suggestion(report_2026, "2026-01", "6015", "B3_COMMON_15")

    assert december_common["final_irrf_carryforward"] == "4.00"
    assert december_darf["final_darf_carryforward"] == "5.00"
    assert next_january_common["initial_irrf_carryforward"] == "0.00"
    assert next_january_darf["initial_darf_carryforward"] == "0.00"
    assert next_january_darf["final_darf_carryforward"] == "6.00"


@pytest.mark.skip(reason="Nao ha segundo codigo de DARF mensal ativo no escopo atual alem do 6015.")
def test_minimum_darf_carryforward_is_not_shared_across_different_darf_codes(tmp_path):
    pass


def test_fiscal_tax_parameter_api_lifecycle_and_overlap_validation(tmp_path, monkeypatch):
    db_path, ctx, _conn, _ = _setup(tmp_path)
    _close(ctx)

    monkeypatch.setattr("backend.routers.tax.get_db", lambda: get_db(db_path))
    client = TestClient(app)

    list_response = client.get("/api/tax/parameters")
    assert list_response.status_code == 200
    parameters = list_response.json()
    assert {item["regime"] for item in parameters} >= {
        "B3_COMMON_15",
        "B3_FII_FIAGRO_20",
        "FI_INFRA_EXEMPT",
        "CRYPTO_GCAP",
    }
    common_default = next(item for item in parameters if item["regime"] == "B3_COMMON_15")
    assert common_default["valid_from"] == "1900-01-01"
    assert common_default["active"] is True
    assert common_default["minimum_darf_amount"] == "10.00"

    close_default_response = client.patch(
        f"/api/tax/parameters/{common_default['id']}",
        json={"valid_until": "2025-06-30"},
    )
    assert close_default_response.status_code == 200
    assert close_default_response.json()["valid_until"] == "2025-06-30"

    create_response = client.post(
        "/api/tax/parameters",
        json={
            "regime": "B3_COMMON_15",
            "valid_from": "2025-07-01",
            "tax_rate": "0.10",
            "withholding_rate": "0.001",
            "exemption_limit": "0",
            "darf_code": "6015",
            "minimum_darf_amount": "20.00",
            "loss_bucket": "B3_COMMON",
            "active": True,
            "monthly_darf_enabled": True,
        },
    )
    assert create_response.status_code == 200
    created = create_response.json()
    assert created["tax_rate"] == "0.10"
    assert created["minimum_darf_amount"] == "20.00"
    assert created["active"] is True

    minimum_update_response = client.patch(
        f"/api/tax/parameters/{created['id']}",
        json={"minimum_darf_amount": "5.00"},
    )
    assert minimum_update_response.status_code == 200
    assert minimum_update_response.json()["minimum_darf_amount"] == "5.00"

    overlap_response = client.post(
        "/api/tax/parameters",
        json={
            "regime": "B3_COMMON_15",
            "valid_from": "2025-05-01",
            "valid_until": "2025-07-15",
            "tax_rate": "0.12",
            "withholding_rate": "0",
            "active": True,
        },
    )
    assert overlap_response.status_code == 400
    assert "sobreposto" in overlap_response.json()["detail"]

    inactive_overlap_response = client.post(
        "/api/tax/parameters",
        json={
            "regime": "B3_COMMON_15",
            "valid_from": "2025-05-01",
            "valid_until": "2025-07-15",
            "tax_rate": "0.12",
            "withholding_rate": "0",
            "active": False,
        },
    )
    assert inactive_overlap_response.status_code == 200
    assert inactive_overlap_response.json()["active"] is False

    negative_minimum_response = client.post(
        "/api/tax/parameters",
        json={
            "regime": "B3_COMMON_15",
            "valid_from": "2026-01-01",
            "tax_rate": "0.12",
            "withholding_rate": "0",
            "minimum_darf_amount": "-1",
            "active": False,
        },
    )
    assert negative_minimum_response.status_code == 400
    assert "DARF minima" in negative_minimum_response.json()["detail"]

    deactivate_response = client.patch(
        f"/api/tax/parameters/{created['id']}",
        json={"active": False},
    )
    assert deactivate_response.status_code == 200
    assert deactivate_response.json()["active"] is False
