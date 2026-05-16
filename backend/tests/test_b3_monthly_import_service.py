from pathlib import Path
from io import BytesIO

from openpyxl import Workbook

from backend.database import get_db, init_db
from backend.domain.enums import AssetClass, EventType
from backend.services import asset_service, event_service, portfolio_service
from backend.services.b3_monthly_import_service import SourceFile, import_b3_monthly_batch


def _workbook_bytes(rows_by_sheet=None):
    rows_by_sheet = rows_by_sheet or {}
    wb = Workbook()
    wb.remove(wb.active)

    headers = {
        "Posição - Ações": [
            "Produto", "Instituição", "Conta", "Código de Negociação", "CNPJ da Empresa",
            "Código ISIN / Distribuição", "Tipo", "Escriturador", "Quantidade",
            "Quantidade Disponível", "Quantidade Indisponível", "Motivo", "Preço de Fechamento",
            "Valor Atualizado",
        ],
        "Posição - Fundos": [
            "Produto", "Instituição", "Conta", "Código de Negociação", "CNPJ do Fundo",
            "Código ISIN / Distribuição", "Tipo", "Administrador", "Quantidade",
            "Quantidade Disponível", "Quantidade Indisponível", "Motivo", "Preço de Fechamento",
            "Valor Atualizado",
        ],
        "Posição - Renda Fixa": [
            "Produto", "Instituição", "Emissor", "Código", "Indexador", "Tipo de regime",
            "Data de Emissão", "Vencimento", "Quantidade", "Quantidade Disponível",
            "Quantidade Indisponível", "Motivo", "Contraparte", "Preço Atualizado MTM",
        ],
        "Posição - Tesouro Direto": [
            "Produto", "Instituição", "Código ISIN", "Indexador", "Vencimento", "Quantidade",
            "Quantidade Disponível", "Quantidade Indisponível", "Motivo", "Valor Aplicado",
            "Valor bruto", "Valor líquido", "Valor Atualizado",
        ],
        "Proventos Recebidos": [
            "Produto", "Pagamento", "Tipo de Evento", "Instituição", "Quantidade",
            "Preço unitário", "Valor líquido",
        ],
    }
    for sheet_name, sheet_headers in headers.items():
        ws = wb.create_sheet(sheet_name)
        ws.append(sheet_headers)
        for row in rows_by_sheet.get(sheet_name, []):
            ws.append(row)

    stream = BytesIO()
    wb.save(stream)
    return stream.getvalue()


def test_b3_import_persists_market_prices_income_and_auto_amortization(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    content = _workbook_bytes(
        {
            "Posição - Ações": [["XPTO3 - XPTO S.A.", "ITAU", "1", "XPTO3", "12345678000190", None, "ON", None, 10, 10, "-", "-", 12.34, 123.4]],
            "Posição - Fundos": [["ABCD11 - ABCD FII", "ITAU", "1", "ABCD11", "11111111000111", None, "Cotas", None, 10, 10, "-", "-", 95.5, 955]],
            "Posição - Renda Fixa": [["DEB - CIA TESTE", "ITAU", "CIA", "DEB123", "IPCA", "DEPOSITADO", "01/01/2024", "01/01/2030", 1, 1, "-", "-", "-", 1020.5]],
            "Posição - Tesouro Direto": [["Tesouro IPCA+ 2029", "ITAU", "BRSTN", "IPCA", "15/05/2029", 1, 1, 0, "-", 100, 110, 109, 111.22]],
            "Proventos Recebidos": [["KNOX11 - KNOX DEBT FDO", "28/11/2025", "Amortização", "BTG", "10", 2.5, 25]],
        }
    )

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset_service.create_asset(conn, AssetClass.ACAO.value, "XPTO3", market="BR", cnpj="12345678000190")
        asset_service.create_asset(conn, AssetClass.FII.value, "ABCD11", market="BR", cnpj="11111111000111")
        asset_service.create_asset(conn, AssetClass.DEBENTURE.value, "DEB123", market="BR")
        asset_service.create_asset(
            conn,
            AssetClass.TESOURO_DIRETO.value,
            "TD2029",
            market="BR",
            name="Tesouro IPCA+ 2029",
            maturity_date="2029-05-15",
        )
        knox = asset_service.create_asset(conn, AssetClass.FII.value, "KNOX11", market="BR")
        event_service.create_event(conn, portfolio["id"], knox["id"], EventType.COMPRA.value, "2025-01-01", "10", "1000")

        result = import_b3_monthly_batch(conn, portfolio["id"], [SourceFile("2025-11.xlsx", content)])
        prices = conn.execute("SELECT * FROM b3_market_prices ORDER BY source_sheet").fetchall()
        incomes = conn.execute("SELECT * FROM b3_income_events").fetchall()
        events = conn.execute("SELECT * FROM events WHERE event_type = ? ORDER BY id", (EventType.AMORTIZACAO.value,)).fetchall()

    assert result["imported_prices"] == 4
    assert result["imported_incomes"] == 1
    assert result["auto_events_created"] == 1
    assert len(prices) == 4
    assert len(incomes) == 1
    assert incomes[0]["ledger_event_id"] == events[0]["id"]
    assert events[0]["event_date"] == "2025-11-28"
    assert events[0]["quantity"] == "0"
    assert events[0]["event_value"] == "25"


def test_b3_amortization_deduplicates_by_type_asset_and_date_not_value(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    content = _workbook_bytes(
        {
            "Proventos Recebidos": [["KNOX11 - KNOX DEBT FDO", "28/11/2025", "Amortização", "BTG", "10", 2.5, 25]],
        }
    )

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset = asset_service.create_asset(conn, AssetClass.FII.value, "KNOX11", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-01-01", "10", "1000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.AMORTIZACAO.value, "2025-11-28", "0", "24.99")

        result = import_b3_monthly_batch(conn, portfolio["id"], [SourceFile("2025-11.xlsx", content)])
        events = conn.execute("SELECT * FROM events WHERE event_type = ?", (EventType.AMORTIZACAO.value,)).fetchall()
        income = conn.execute("SELECT * FROM b3_income_events").fetchone()

    assert result["auto_events_created"] == 0
    assert result["duplicates"] >= 1
    assert len(events) == 1
    assert income["status"] == "ledger_duplicate"
    assert income["ledger_event_id"] is None


def test_b3_import_is_idempotent_for_same_file(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    content = _workbook_bytes(
        {
            "Posição - Ações": [["XPTO3 - XPTO S.A.", "ITAU", "1", "XPTO3", "12345678000190", None, "ON", None, 10, 10, "-", "-", 12.34, 123.4]],
            "Proventos Recebidos": [["KNOX11 - KNOX DEBT FDO", "28/11/2025", "Amortização", "BTG", "10", 2.5, 25]],
        }
    )

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset_service.create_asset(conn, AssetClass.ACAO.value, "XPTO3", market="BR", cnpj="12345678000190")
        knox = asset_service.create_asset(conn, AssetClass.FII.value, "KNOX11", market="BR")
        event_service.create_event(conn, portfolio["id"], knox["id"], EventType.COMPRA.value, "2025-01-01", "10", "1000")

        first = import_b3_monthly_batch(conn, portfolio["id"], [SourceFile("2025-11.xlsx", content)])
        second = import_b3_monthly_batch(conn, portfolio["id"], [SourceFile("2025-11.xlsx", content)])
        prices = conn.execute("SELECT COUNT(*) AS count FROM b3_market_prices").fetchone()["count"]
        incomes = conn.execute("SELECT COUNT(*) AS count FROM b3_income_events").fetchone()["count"]
        amortizations = conn.execute("SELECT COUNT(*) AS count FROM events WHERE event_type = ?", (EventType.AMORTIZACAO.value,)).fetchone()["count"]

    assert first["auto_events_created"] == 1
    assert second["auto_events_created"] == 0
    assert second["duplicates"] >= 2
    assert prices == 1
    assert incomes == 1
    assert amortizations == 1


def test_b3_import_creates_review_for_unmatched_asset(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    content = _workbook_bytes(
        {
            "Posição - Ações": [["MISS3 - MISSING S.A.", "ITAU", "1", "MISS3", "12345678000190", None, "ON", None, 10, 10, "-", "-", 12.34, 123.4]],
        }
    )

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        result = import_b3_monthly_batch(conn, portfolio["id"], [SourceFile("2025-11.xlsx", content)])
        reviews = asset_service.list_match_reviews(conn)
        price = conn.execute("SELECT * FROM b3_market_prices").fetchone()

    assert result["review_count"] == 1
    assert len(reviews) == 1
    assert price["status"] == "review"
    assert price["review_id"] == reviews[0]["id"]


def test_b3_batch_processes_files_chronologically(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    content = _workbook_bytes()

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        result = import_b3_monthly_batch(
            conn,
            portfolio["id"],
            [SourceFile("2025-11.xlsx", content), SourceFile("2025-10.xlsx", content)],
        )

    assert [file["reference_month"] for file in result["files"]] == ["2025-10", "2025-11"]


def test_real_2025_11_b3_file_parses_without_global_failure(tmp_path):
    source_path = Path(__file__).resolve().parents[2] / "2025-11.xlsx"
    if not source_path.exists():
        return

    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        result = import_b3_monthly_batch(conn, portfolio["id"], [SourceFile("2025-11.xlsx", source_path.read_bytes())])

    assert result["files_processed"] == 1
    assert result["total_rows"] > 0
