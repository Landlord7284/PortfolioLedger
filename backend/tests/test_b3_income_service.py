from datetime import date

from backend.database import get_db, init_db
from backend.domain.enums import AssetClass
from backend.services import asset_service, b3_income_service, portfolio_service


def _import_id(conn, portfolio_id: int, month: str = "2026-03") -> int:
    cur = conn.execute(
        """
        INSERT INTO b3_monthly_imports (portfolio_id, filename, reference_month, reference_date)
        VALUES (?, ?, ?, ?)
        """,
        (portfolio_id, f"{month}.xlsx", month, f"{month}-28"),
    )
    return cur.lastrowid


def _income(conn, import_id: int, portfolio_id: int, **values) -> None:
    conn.execute(
        """
        INSERT INTO b3_income_events (
            import_id, portfolio_id, asset_id, payment_date, event_type,
            product, ticker, quantity, unit_price, net_value, status, raw_payload
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            import_id,
            portfolio_id,
            values.get("asset_id"),
            values["payment_date"],
            values["event_type"],
            values.get("product"),
            values.get("ticker"),
            values.get("quantity", "0"),
            values.get("unit_price", "0"),
            values["net_value"],
            values.get("status", "imported"),
            "{}",
        ),
    )


def test_b3_incomes_summary_chart_filters_and_table(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    monkeypatch.setattr(b3_income_service, "date", type("FixedDate", (), {"today": staticmethod(lambda: date(2026, 5, 17))}))

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        itsa = asset_service.create_asset(conn, AssetClass.ACAO.value, "ITSA4", market="BR", name="Itausa")
        knri = asset_service.create_asset(conn, AssetClass.FII.value, "KNRI11", market="BR", name="Kinea")
        import_id = _import_id(conn, portfolio["id"], "2026-03")
        _income(conn, import_id, portfolio["id"], asset_id=itsa["id"], payment_date="2026-03-10", event_type="Dividendos", product="ITSA4 - Itausa", ticker="ITSA4", quantity="100", net_value="120.00")
        _income(conn, import_id, portfolio["id"], asset_id=knri["id"], payment_date="2026-03-20", event_type="Rendimento", product="KNRI11 - Kinea", ticker="KNRI11", quantity="10", net_value="80.00")
        _income(conn, import_id, portfolio["id"], asset_id=itsa["id"], payment_date="2026-04-15", event_type="Juros sobre Capital Próprio", product="ITSA4 - Itausa", ticker="ITSA4", quantity="100", net_value="60.00")

        report = b3_income_service.list_b3_incomes(
            conn,
            portfolio["id"],
            period="year",
            asset_class=AssetClass.ACAO.value,
            table_year=2026,
            table_month=3,
        )

    assert report["summary"]["total_net_value"] == "260.00"
    assert report["summary"]["monthly_average"] == "52.00"
    assert report["summary"]["month_count"] == 5
    assert report["filters"]["default_year"] == 2026
    assert report["filters"]["default_month"] == 4
    assert report["filters"]["asset_classes"] == [AssetClass.ACAO.value, AssetClass.FII.value]
    march = next(month for month in report["chart"]["months"] if month["month"] == "2026-03")
    assert march["total_net_value"] == "120.00"
    assert march["top_events"][0]["label"] == "ITSA4"
    assert march["top_events"][0]["share"] == "100.00"
    assert report["table"]["total_net_value"] == "200.00"
    assert [row["ticker"] for row in report["table"]["rows"]] == ["ITSA4", "KNRI11"]


def test_b3_incomes_includes_review_fallback_rows(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    monkeypatch.setattr(b3_income_service, "date", type("FixedDate", (), {"today": staticmethod(lambda: date(2026, 5, 17))}))

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        import_id = _import_id(conn, portfolio["id"], "2026-02")
        _income(conn, import_id, portfolio["id"], payment_date="2026-02-12", event_type="Dividendos", product="XPTO3 - Empresa XPTO", ticker="XPTO3", quantity="5", net_value="25.50", status="review")

        report = b3_income_service.list_b3_incomes(conn, portfolio["id"], period="12m", table_year=2026, table_month=2)

    assert report["summary"]["total_net_value"] == "25.50"
    assert report["filters"]["assets"] == []
    assert report["table"]["rows"][0]["ticker"] == "XPTO3"
    assert report["table"]["rows"][0]["name"] == "XPTO3 - Empresa XPTO"
