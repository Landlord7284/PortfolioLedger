from backend.database import get_db, init_db
from backend.domain.enums import AssetClass, EventType
from io import BytesIO

from openpyxl import Workbook

from backend.services import asset_service, event_service, import_service, portfolio_service, report_service


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


def test_us_purchase_keeps_usd_event_value_and_replays_brl_position(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        conn.execute(
            "INSERT INTO ptax_cache (date, compra, venda) VALUES (?, ?, ?)",
            ("2024-01-02", 4.8, 5.0),
        )
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset = asset_service.create_asset(conn, AssetClass.STOCK.value, "MSFT")

        event = event_service.create_event(
            conn,
            portfolio["id"],
            asset["id"],
            EventType.COMPRA.value,
            "2024-01-02",
            "10",
            "1000",
        )
        position = event_service.get_position(conn, portfolio["id"], asset["id"])
        rows = event_service.list_events(conn, asset["id"], portfolio["id"])

    assert event["event_value"] == "1000"
    assert event["event_value_brl"] == "5000.00"
    assert event["ptax_venda"] == "5.0"
    assert position["total_cost"] == "5000.00"
    assert position["average_price"] == "500.00"
    assert position["total_cost_original"] == "1000"
    assert rows[0]["unit_price"] == "100"
    assert rows[0]["unit_price_brl"] == "500.00"
    assert rows[0]["running_total_cost"] == "5000.00"


def test_us_xlsx_import_converts_values_for_brl_position(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    workbook = Workbook()
    worksheet = workbook.active
    worksheet.append(["Classe", "Ativo", "Evento", "Data", "Quantidade", "Valor Evento", "Origem US"])
    worksheet.append(["Stock", "MSFT", "Compra", "2024-01-02", 10, 1000, None])
    source = BytesIO()
    workbook.save(source)
    source.seek(0)

    with get_db(db_path) as conn:
        conn.execute(
            "INSERT INTO ptax_cache (date, compra, venda) VALUES (?, ?, ?)",
            ("2024-01-02", 4.8, 5.0),
        )
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        result = import_service.import_to_ledger(conn, source, portfolio["id"])
        position = event_service.list_positions(conn, portfolio["id"])[0]

    assert result["imported"] == 1
    assert position["total_cost"] == "5000.00"
    assert position["total_cost_original"] == "1000"


def test_assets_and_rights_uses_brl_cost_for_us_assets(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        conn.execute(
            "INSERT INTO ptax_cache (date, compra, venda) VALUES (?, ?, ?)",
            ("2024-01-02", 4.8, 5.0),
        )
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset = asset_service.create_asset(conn, AssetClass.STOCK.value, "MSFT")
        event_service.create_event(
            conn,
            portfolio["id"],
            asset["id"],
            EventType.COMPRA.value,
            "2024-01-02",
            "10",
            "1000",
        )
        report = report_service.list_assets_and_rights(conn, portfolio["id"], 2024)

    assert report["rows"][0]["current_year_cost"] == "5000.00"
