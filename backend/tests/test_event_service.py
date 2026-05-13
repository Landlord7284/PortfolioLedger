from backend.database import get_db, init_db
from backend.domain.enums import AssetClass, EventType
from backend.services import asset_service, event_service, portfolio_service


def test_list_events_includes_derived_ledger_display_fields(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset = asset_service.create_asset(conn, AssetClass.ACAO.value, "XPTO3", market="BR")

        event_service.create_event(
            conn,
            portfolio["id"],
            asset["id"],
            EventType.COMPRA.value,
            "2024-01-01",
            "10",
            "1000",
        )
        event_service.create_event(
            conn,
            portfolio["id"],
            asset["id"],
            EventType.VENDA.value,
            "2024-01-02",
            "4",
            "600",
        )

        rows = event_service.list_events(conn, asset["id"], portfolio["id"])

    assert rows[0]["unit_price"] == "100"
    assert rows[0]["running_quantity"] == "10"
    assert rows[0]["running_total_cost"] == "1000"
    assert rows[0]["net_operation_value"] is None
    assert rows[0]["realized_event_result"] is None

    assert rows[1]["unit_price"] == "150"
    assert rows[1]["running_quantity"] == "6"
    assert rows[1]["running_total_cost"] == "600"
    assert rows[1]["net_operation_value"] is None
    assert rows[1]["realized_event_result"] == "200"


def test_create_event_persists_gross_value_only_for_sales(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset = asset_service.create_asset(conn, AssetClass.ACAO.value, "XPTO3", market="BR")

        purchase = event_service.create_event(
            conn,
            portfolio["id"],
            asset["id"],
            EventType.COMPRA.value,
            "2024-01-01",
            "10",
            "1000",
            gross_value="1005",
        )
        sale = event_service.create_event(
            conn,
            portfolio["id"],
            asset["id"],
            EventType.VENDA.value,
            "2024-01-02",
            "4",
            "590",
            gross_value="600",
        )

    assert purchase["gross_value"] is None
    assert sale["gross_value"] == "600"


def test_storno_and_correction_preserve_sale_gross_value_rule(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset = asset_service.create_asset(conn, AssetClass.ACAO.value, "XPTO3", market="BR")
        event_service.create_event(
            conn,
            portfolio["id"],
            asset["id"],
            EventType.COMPRA.value,
            "2024-01-01",
            "10",
            "1000",
        )
        sale = event_service.create_event(
            conn,
            portfolio["id"],
            asset["id"],
            EventType.VENDA.value,
            "2024-01-02",
            "4",
            "590",
            gross_value="600",
        )

        storno = event_service.storno_event(conn, sale["id"])
        second_sale = event_service.create_event(
            conn,
            portfolio["id"],
            asset["id"],
            EventType.VENDA.value,
            "2024-01-03",
            "2",
            "295",
            gross_value="300",
        )
        correction = event_service.correct_event(
            conn,
            second_sale["id"],
            EventType.COMPRA.value,
            "2024-01-04",
            "1",
            "100",
            gross_value="120",
        )

    assert storno["gross_value"] == "600"
    assert correction["gross_value"] is None
