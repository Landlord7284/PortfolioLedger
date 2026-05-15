from openpyxl import load_workbook

from backend.database import get_db, init_db
from backend.domain.enums import AssetClass, EventType
from backend.services import asset_service, event_service, portfolio_service, report_service


def test_assets_and_rights_replays_year_end_positions(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset = asset_service.create_asset(
            conn,
            AssetClass.ACAO.value,
            "XPTO3",
            market="BR",
            name="XPTO SA",
            cnpj="00.000.000/0001-00",
        )

        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2024-01-01", "10", "1000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-01-01", "5", "750")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.VENDA.value, "2025-06-01", "3", "420")

        report = report_service.list_assets_and_rights(conn, portfolio["id"], 2025)

    assert report["previous_cutoff"] == "2024-12-31"
    assert report["current_cutoff"] == "2025-12-31"
    assert len(report["rows"]) == 1
    row = report["rows"][0]
    assert row["ticker"] == "XPTO3"
    assert row["quantity"] == "12.00"
    assert row["name"] == "XPTO SA"
    assert row["cnpj"] == "00.000.000/0001-00"
    assert row["previous_year_cost"] == "1000.00"
    assert row["current_year_cost"] == "1400.00"


def test_assets_and_rights_filters_non_report_classes(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset = asset_service.create_asset(conn, AssetClass.TESOURO_DIRETO.value, "TD2029", market="BR")

        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-01-01", "1", "1000")

        report = report_service.list_assets_and_rights(conn, portfolio["id"], 2025)

    assert report["rows"] == []


def test_assets_and_rights_xlsx_uses_report_rows(tmp_path):
    db_path = tmp_path / "ledger.db"
    xlsx_path = tmp_path / "report.xlsx"
    init_db(db_path)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset = asset_service.create_asset(conn, AssetClass.FII.value, "ABCD11", market="BR", name="ABCD FII")

        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-01-01", "10", "950")

        xlsx_path.write_bytes(report_service.build_assets_and_rights_xlsx(conn, portfolio["id"], 2025))

    workbook = load_workbook(xlsx_path)
    worksheet = workbook["Bens e Direitos"]

    assert worksheet["A1"].value == "CLASSE"
    assert worksheet["B1"].value == "TICKER"
    assert worksheet["D1"].value == "NOME ATIVO"
    assert worksheet["F1"].value == "Situação em 31/12/2024"
    assert worksheet["G1"].value == "Situação em 31/12/2025"
    assert worksheet["A2"].value == AssetClass.FII.value
    assert worksheet["B2"].value == "ABCD11"
    assert worksheet["C2"].value == 10
    assert worksheet["D2"].value == "ABCD FII"
    assert worksheet["F2"].value == 0
    assert worksheet["G2"].value == 950
    assert worksheet["C2"].number_format == "#,##0.00########"
    assert worksheet["F2"].number_format == "#,##0.00"
    assert worksheet["G2"].number_format == "#,##0.00"
