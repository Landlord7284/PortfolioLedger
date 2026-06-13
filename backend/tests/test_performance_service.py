from datetime import date as real_date

from backend.database import get_db, init_db
from backend.domain.enums import AssetClass, EventType
from backend.services import asset_service, event_service, performance_service, portfolio_service
from backend.services import dashboard_service


class FixedDate(real_date):
    @classmethod
    def today(cls):
        return cls(2026, 3, 28)


def _import_id(conn, portfolio_id: int, month: str) -> int:
    cur = conn.execute(
        """
        INSERT INTO b3_monthly_imports (portfolio_id, filename, reference_month, reference_date)
        VALUES (?, ?, ?, ?)
        """,
        (portfolio_id, f"{month}.xlsx", month, f"{month}-28"),
    )
    return cur.lastrowid


def _price(conn, import_id: int, asset_id: int, month: str, value: str) -> None:
    conn.execute(
        """
        INSERT INTO b3_market_prices (
            import_id, asset_id, reference_month, reference_date, source_sheet,
            source_row, ticker, value, is_unit_price, status, raw_payload
        )
        VALUES (?, ?, ?, ?, 'Posicao - Teste', 1, 'TST', ?, 1, 'imported', '{}')
        """,
        (import_id, asset_id, month, f"{month}-28", value),
    )


def test_twr_br_neutralizes_br_flows_and_ignores_us_assets(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    monkeypatch.setattr(dashboard_service, "date", FixedDate)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        br_asset = asset_service.create_asset(conn, AssetClass.ACAO.value, "ITSA4", market="BR")
        us_asset = asset_service.create_asset(conn, AssetClass.STOCK.value, "AAPL", market="US")

        event_service.create_event(conn, portfolio["id"], br_asset["id"], EventType.COMPRA.value, "2026-01-10", "100", "1000")
        conn.execute(
            """
            INSERT INTO events (
                portfolio_id, asset_id, event_type, event_date, quantity,
                event_value, event_value_brl, sequence_num
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (portfolio["id"], us_asset["id"], EventType.COMPRA.value, "2026-01-12", "10", "500", "2500", 999),
        )
        event_service.create_event(conn, portfolio["id"], br_asset["id"], EventType.COMPRA.value, "2026-02-05", "100", "1200")
        event_service.create_event(conn, portfolio["id"], br_asset["id"], EventType.VENDA.value, "2026-03-10", "50", "650")

        jan_import = _import_id(conn, portfolio["id"], "2026-01")
        feb_import = _import_id(conn, portfolio["id"], "2026-02")
        mar_import = _import_id(conn, portfolio["id"], "2026-03")
        _price(conn, jan_import, br_asset["id"], "2026-01", "10")
        _price(conn, feb_import, br_asset["id"], "2026-02", "12")
        _price(conn, mar_import, br_asset["id"], "2026-03", "13")

        report = performance_service.get_twr(conn, portfolio["id"], period="year")

    assert report["market"] == "BR"
    assert [row["year_month"] for row in report["series"]] == ["2026-01", "2026-02", "2026-03"]
    assert report["series"][0]["market_value"] == "1000.00"
    assert report["series"][0]["flow_in"] == "1000.00"
    assert report["series"][0]["monthly_return_pct"] == "0.00"
    assert report["series"][1]["market_value"] == "2400.00"
    assert report["series"][1]["flow_in"] == "1200.00"
    assert report["series"][1]["monthly_return_pct"] == "20.00"
    assert report["series"][2]["market_value"] == "1950.00"
    assert report["series"][2]["flow_out"] == "650.00"
    assert report["series"][2]["monthly_return_pct"] == "8.33"
    assert report["summary"]["quota_value"] == "130.00000000"
    assert report["summary"]["accumulated_return_pct"] == "30.00"


def test_twr_br_marks_cost_fallback_when_monthly_quote_is_missing(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    monkeypatch.setattr(dashboard_service, "date", FixedDate)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset = asset_service.create_asset(conn, AssetClass.FII.value, "XPTO11", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2026-01-10", "10", "1000")

        jan_import = _import_id(conn, portfolio["id"], "2026-01")
        _price(conn, jan_import, asset["id"], "2026-01", "100")

        report = performance_service.get_twr(conn, portfolio["id"], period="year")

    feb = next(row for row in report["series"] if row["year_month"] == "2026-02")
    assert feb["market_value"] == "1000.00"
    assert feb["uses_cost_fallback"] is True
    assert feb["missing_quote_count"] == 1
    assert report["summary"]["uses_cost_fallback"] is True
    assert report["summary"]["fallback_month_count"] == 2
