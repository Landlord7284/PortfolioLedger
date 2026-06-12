from datetime import date as real_date

from backend.database import get_db, init_db
from backend.domain.enums import AssetClass, EventType
from backend.services import asset_service, dashboard_service, event_service, portfolio_service


class FixedDate(real_date):
    @classmethod
    def today(cls):
        return cls(2026, 5, 28)


def _import_id(conn, portfolio_id: int, month: str = "2026-05") -> int:
    cur = conn.execute(
        """
        INSERT INTO b3_monthly_imports (portfolio_id, filename, reference_month, reference_date)
        VALUES (?, ?, ?, ?)
        """,
        (portfolio_id, f"{month}.xlsx", month, f"{month}-28"),
    )
    return cur.lastrowid


def _price(conn, import_id: int, asset_id: int, *, month: str = "2026-05", value: str, is_unit_price: bool = True, row: int = 1) -> None:
    conn.execute(
        """
        INSERT INTO b3_market_prices (
            import_id, asset_id, reference_month, reference_date, source_sheet,
            source_row, ticker, value, is_unit_price, status, raw_payload
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', '{}')
        """,
        (
            import_id,
            asset_id,
            month,
            f"{month}-28",
            "Posição - Teste",
            row,
            f"TST{row}",
            value,
            1 if is_unit_price else 0,
        ),
    )


def _income(conn, import_id: int, portfolio_id: int, asset_id: int, *, payment_date: str, value: str) -> None:
    conn.execute(
        """
        INSERT INTO b3_income_events (
            import_id, portfolio_id, asset_id, payment_date, event_type,
            product, ticker, quantity, unit_price, net_value, status, raw_payload
        )
        VALUES (?, ?, ?, ?, 'Dividendos', 'ITSA4 - Itausa', 'ITSA4', '100', '1.20', ?, 'imported', '{}')
        """,
        (import_id, portfolio_id, asset_id, payment_date, value),
    )


def test_dashboard_uses_b3_market_value_and_explicit_cost_fallback(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    monkeypatch.setattr(dashboard_service, "date", FixedDate)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        stock = asset_service.create_asset(
            conn,
            AssetClass.ACAO.value,
            "ITSA4",
            market="BR",
            name="Itausa",
            sector="Financeiro",
            subsector="Bancos",
            segment="Banco",
        )
        fii = asset_service.create_asset(conn, AssetClass.FII.value, "KNRI11", market="BR", name="Kinea", segment="Logística")

        event_service.create_event(conn, portfolio["id"], stock["id"], EventType.COMPRA.value, "2025-01-10", "100", "1000")
        event_service.create_event(conn, portfolio["id"], fii["id"], EventType.COMPRA.value, "2025-02-10", "10", "900")
        event_service.create_event(conn, portfolio["id"], stock["id"], EventType.VENDA.value, "2026-03-15", "40", "600")

        import_id = _import_id(conn, portfolio["id"], "2026-05")
        _price(conn, import_id, stock["id"], value="12", row=1)
        _income(conn, import_id, portfolio["id"], stock["id"], payment_date="2026-04-10", value="120.00")

        report = dashboard_service.get_dashboard(conn, portfolio["id"], period="year")
        stock_only = dashboard_service.get_dashboard(conn, portfolio["id"], period="year", asset_class=AssetClass.ACAO.value)

    assert report["summary"]["market_value"] == "1620.00"
    assert report["summary"]["cost_basis"] == "1500.00"
    assert report["summary"]["unrealized_result"] == "120.00"
    assert report["summary"]["unrealized_result_pct"] == "8.00"
    assert report["summary"]["realized_result"] == "200.00"
    assert report["summary"]["income"] == "120.00"
    assert report["summary"]["income_monthly_avg"] == "24.00"
    assert report["summary"]["income_month_count"] == 5
    assert report["summary"]["market_value_month"] == "2026-05"
    assert report["summary"]["market_value_uses_cost_fallback"] is True
    assert report["summary"]["market_value_cost_fallback_count"] == 1
    assert report["operational_alerts"]["missing_recent_quotes_summary"] == ["KNRI11"]
    current_positions = {position["current_ticker"]: position for position in report["current_positions"]}
    assert current_positions["ITSA4"]["sector"] == "Financeiro"
    assert current_positions["ITSA4"]["subsector"] == "Bancos"
    assert current_positions["ITSA4"]["segment"] == "Banco"
    assert current_positions["ITSA4"]["market_value"] == "720.00"
    assert current_positions["ITSA4"]["unrealized_result"] == "120.00"
    assert current_positions["ITSA4"]["uses_cost_fallback"] is False
    assert current_positions["KNRI11"]["segment"] == "Logística"
    assert current_positions["KNRI11"]["market_value"] == "900.00"
    assert current_positions["KNRI11"]["uses_cost_fallback"] is True

    may = report["equity_curve"][-1]
    assert may["year_month"] == "2026-05"
    assert may["market_value"] == "1620.00"
    assert may["cost_basis"] == "1500.00"
    assert may["contributions_in"] == "0.00"
    assert may["contributions_out"] == "0.00"
    assert may["net_contribution"] == "0.00"
    assert may["net_contributions_accumulated"] == "1300.00"
    assert may["uses_cost_fallback"] is True
    march = next(month for month in report["equity_curve"] if month["year_month"] == "2026-03")
    assert march["contributions_in"] == "0.00"
    assert march["contributions_out"] == "600.00"
    assert march["net_contribution"] == "-600.00"

    assert stock_only["summary"]["market_value"] == "720.00"
    assert stock_only["summary"]["cost_basis"] == "600.00"
    assert stock_only["summary"]["realized_result"] == "200.00"
    assert stock_only["summary"]["market_value_uses_cost_fallback"] is False
    assert stock_only["allocation"] == [
        {
            "asset_class": AssetClass.ACAO.value,
            "market_value": "720.00",
            "weight_pct": "100.00",
            "uses_cost_fallback": False,
            "market_value_supported": True,
        }
    ]
    assert [position["asset_class"] for position in stock_only["current_positions"]] == [AssetClass.ACAO.value]


def test_dashboard_uses_consolidated_b3_value_for_non_unit_prices(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    monkeypatch.setattr(dashboard_service, "date", FixedDate)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        debenture = asset_service.create_asset(conn, AssetClass.DEBENTURE.value, "DEB123", market="BR")
        event_service.create_event(conn, portfolio["id"], debenture["id"], EventType.COMPRA.value, "2025-01-10", "3", "2700")

        import_id = _import_id(conn, portfolio["id"], "2026-05")
        _price(conn, import_id, debenture["id"], value="3000", is_unit_price=False, row=1)

        report = dashboard_service.get_dashboard(conn, portfolio["id"], period="12m")

    assert report["summary"]["market_value"] == "3000.00"
    assert report["summary"]["cost_basis"] == "2700.00"
    assert report["summary"]["unrealized_result"] == "300.00"
    assert report["summary"]["market_value_uses_cost_fallback"] is False


def test_dashboard_current_positions_include_treasury_indexer(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    monkeypatch.setattr(dashboard_service, "date", FixedDate)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        treasury = asset_service.create_asset(
            conn,
            AssetClass.TESOURO_DIRETO.value,
            "TESOURO-IPCA-2035",
            treasury_indexer="IPCA",
        )
        event_service.create_event(conn, portfolio["id"], treasury["id"], EventType.COMPRA.value, "2026-01-10", "1", "1000")

        report = dashboard_service.get_dashboard(conn, portfolio["id"], period="year")

    [position] = report["current_positions"]
    assert position["asset_class"] == AssetClass.TESOURO_DIRETO.value
    assert position["treasury_indexer"] == "IPCA"


def test_dashboard_falls_back_to_cost_when_no_quotes_exist(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    monkeypatch.setattr(dashboard_service, "date", FixedDate)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset = asset_service.create_asset(conn, AssetClass.FII.value, "XPTO11", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2026-01-10", "10", "1000")

        report = dashboard_service.get_dashboard(conn, portfolio["id"], period="year")

    assert report["summary"]["market_value"] == "1000.00"
    assert report["summary"]["cost_basis"] == "1000.00"
    assert report["summary"]["unrealized_result"] == "0.00"
    assert report["summary"]["market_value_month"] is None
    assert report["operational_alerts"]["no_quotes"] is True
    assert report["operational_alerts"]["missing_recent_quotes_count"] == 1
    assert report["operational_alerts"]["uses_cost_fallback"] is True


def test_dashboard_uses_cost_fallback_for_crypto_market_value(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    monkeypatch.setattr(dashboard_service, "date", FixedDate)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        crypto = asset_service.create_asset(conn, AssetClass.CRIPTOMOEDA.value, "BTC", market="BR")
        event_service.create_event(conn, portfolio["id"], crypto["id"], EventType.COMPRA.value, "2026-01-10", "0.5", "1000")
        import_id = _import_id(conn, portfolio["id"], "2026-05")
        _price(conn, import_id, crypto["id"], value="5000", row=1)

        report = dashboard_service.get_dashboard(conn, portfolio["id"], period="year")

    assert report["summary"]["market_value"] == "1000.00"
    assert report["summary"]["cost_basis"] == "1000.00"
    assert report["summary"]["unrealized_result"] == "0.00"
    assert report["summary"]["market_value_uses_cost_fallback"] is True
    assert report["summary"]["market_value_cost_fallback_count"] == 1
    assert report["summary"]["market_value_unsupported_count"] == 0
    assert report["summary"]["market_value_month"] is None
    assert report["operational_alerts"]["no_quotes"] is True
    assert report["operational_alerts"]["missing_recent_quotes_count"] == 1
    assert report["operational_alerts"]["missing_recent_quotes_summary"] == ["BTC"]
    assert report["allocation"][0]["market_value_supported"] is True


def test_dashboard_net_contributions_ignore_non_cash_events(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    monkeypatch.setattr(dashboard_service, "date", FixedDate)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset = asset_service.create_asset(conn, AssetClass.ACAO.value, "CASH3", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2026-01-10", "100", "1000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.BONIFICACAO.value, "2026-02-10", "10", "100")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.DESDOBRAMENTO.value, "2026-03-10", "110", "0")

        report = dashboard_service.get_dashboard(conn, portfolio["id"], period="year")

    january = next(month for month in report["equity_curve"] if month["year_month"] == "2026-01")
    february = next(month for month in report["equity_curve"] if month["year_month"] == "2026-02")
    march = next(month for month in report["equity_curve"] if month["year_month"] == "2026-03")
    assert january["contributions_in"] == "1000.00"
    assert january["contributions_out"] == "0.00"
    assert january["net_contribution"] == "1000.00"
    assert january["net_contributions_accumulated"] == "1000.00"
    assert february["contributions_in"] == "0.00"
    assert february["contributions_out"] == "0.00"
    assert february["net_contribution"] == "0.00"
    assert february["net_contributions_accumulated"] == "1000.00"
    assert march["contributions_in"] == "0.00"
    assert march["contributions_out"] == "0.00"
    assert march["net_contribution"] == "0.00"
    assert march["net_contributions_accumulated"] == "1000.00"
    assert march["cost_basis"] == "1100.00"
