from pathlib import Path
from io import BytesIO

import pytest
from openpyxl import Workbook

from backend.database import get_db, init_db
from backend.domain.enums import AssetClass, EventType
from backend.services import b3_monthly_import_service as b3_service
from backend.services import asset_service, event_service, portfolio_service
from backend.services.b3_monthly_import_service import SourceFile, import_b3_monthly_batch, sanitize_b3_monthly_import


def _sheet_rows(rows_by_sheet, sheet_name):
    if sheet_name in rows_by_sheet:
        return rows_by_sheet[sheet_name]
    variants = {
        sheet_name.encode("latin1", errors="ignore").decode("utf-8", errors="ignore"),
        sheet_name.encode("utf-8", errors="ignore").decode("latin1", errors="ignore"),
    }
    for variant in variants:
        if variant in rows_by_sheet:
            return rows_by_sheet[variant]
    return []


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
            "Valor Atualizado MTM",
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
        for row in _sheet_rows(rows_by_sheet, sheet_name):
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
            "Posição - Renda Fixa": [["DEB - CIA TESTE", "ITAU", "CIA", "DEB123", "IPCA", "DEPOSITADO", "01/01/2024", "01/01/2030", 1, 1, "-", "-", "-", 102.05, 1020.5]],
            "Posição - Tesouro Direto": [["Tesouro IPCA+ 2029", "ITAU", "BRSTN", "IPCA", "15/05/2029", 1, 1, 0, "-", 100, 110, 109, 111.22]],
            "Proventos Recebidos": [["KNOX11 - KNOX DEBT FDO", "28/11/2025", EventType.AMORTIZACAO.value, "BTG", "10", 2.5, 25]],
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


def test_b3_amortization_imports_duplicate_by_type_asset_and_date_with_flag(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    content = _workbook_bytes(
        {
            "Proventos Recebidos": [["KNOX11 - KNOX DEBT FDO", "28/11/2025", EventType.AMORTIZACAO.value, "BTG", "10", 2.5, 25]],
        }
    )

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset = asset_service.create_asset(conn, AssetClass.FII.value, "KNOX11", market="BR")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.COMPRA.value, "2025-01-01", "10", "1000")
        event_service.create_event(conn, portfolio["id"], asset["id"], EventType.AMORTIZACAO.value, "2025-11-28", "0", "24.99")

        result = import_b3_monthly_batch(conn, portfolio["id"], [SourceFile("2025-11.xlsx", content)])
        events = conn.execute("SELECT * FROM events WHERE event_type = ? ORDER BY id", (EventType.AMORTIZACAO.value,)).fetchall()
        income = conn.execute("SELECT * FROM b3_income_events").fetchone()
        asset_row = conn.execute("SELECT duplicate_flag FROM assets WHERE id = ?", (asset["id"],)).fetchone()

    assert result["auto_events_created"] == 1
    assert result["duplicates"] >= 1
    assert any("amortizacao ja existia no ledger" in detail for detail in result["files"][0]["duplicate_details"])
    assert len(events) == 2
    assert events[1]["event_value"] == "25"
    assert events[1]["duplicate_flag"] == 1
    assert asset_row["duplicate_flag"] == 1
    assert income["status"] == "ledger_event_created"
    assert income["ledger_event_id"] == events[1]["id"]


def test_b3_import_is_idempotent_for_same_file(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    content = _workbook_bytes(
        {
            "Posição - Ações": [["XPTO3 - XPTO S.A.", "ITAU", "1", "XPTO3", "12345678000190", None, "ON", None, 10, 10, "-", "-", 12.34, 123.4]],
            "Proventos Recebidos": [["KNOX11 - KNOX DEBT FDO", "28/11/2025", EventType.AMORTIZACAO.value, "BTG", "10", 2.5, 25]],
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
    assert any("ja reprocessada para 2025-11" in detail for detail in second["files"][0]["duplicate_details"])
    assert any("ja processado neste arquivo" in detail for detail in second["files"][0]["duplicate_details"])
    assert prices == 1
    assert incomes == 1
    assert amortizations == 1


def test_sanitize_b3_monthly_import_removes_b3_rows_and_cancels_auto_ledger_events(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    content = _workbook_bytes(
        {
            "PosiÃ§Ã£o - AÃ§Ãµes": [["XPTO3 - XPTO S.A.", "ITAU", "1", "XPTO3", "12345678000190", None, "ON", None, 10, 10, "-", "-", 12.34, 123.4]],
            "PosiÃ§Ã£o - Fundos": [["ABCD11 - ABCD FII", "ITAU", "1", "ABCD11", "11111111000111", None, "Cotas", None, 10, 10, "-", "-", 95.5, 955]],
            "PosiÃ§Ã£o - Renda Fixa": [["DEB - CIA TESTE", "ITAU", "CIA", "DEB123", "IPCA", "DEPOSITADO", "01/01/2024", "01/01/2030", 1, 1, "-", "-", "-", 102.05, 1020.5]],
            "PosiÃ§Ã£o - Tesouro Direto": [["Tesouro IPCA+ 2029", "ITAU", "BRSTN", "IPCA", "15/05/2029", 1, 1, 0, "-", 100, 110, 109, 111.22]],
            "Proventos Recebidos": [["KNOX11 - KNOX DEBT FDO", "28/11/2025", EventType.AMORTIZACAO.value, "BTG", "10", 2.5, 25]],
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
        manual = event_service.create_event(conn, portfolio["id"], knox["id"], EventType.COMPRA.value, "2025-01-01", "10", "1000")

        import_b3_monthly_batch(conn, portfolio["id"], [SourceFile("2025-11.xlsx", content)])
        import_id = conn.execute("SELECT id FROM b3_monthly_imports WHERE portfolio_id = ?", (portfolio["id"],)).fetchone()["id"]
        conn.execute(
            """
            INSERT INTO b3_market_prices (
                import_id, asset_id, reference_month, reference_date, source_sheet,
                source_row, ticker, product, value, is_unit_price, status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (import_id, knox["id"], "2025-11", "2025-11-30", "Posicao - Fundos", 99, "KNOX11", "KNOX11", "10", 1, "imported"),
        )
        auto_event = conn.execute(
            "SELECT * FROM events WHERE event_type = ? AND id <> ?",
            (EventType.AMORTIZACAO.value, manual["id"]),
        ).fetchone()

        result = sanitize_b3_monthly_import(conn, portfolio["id"], "2025-11")
        imports = conn.execute("SELECT COUNT(*) AS count FROM b3_monthly_imports").fetchone()["count"]
        prices = conn.execute("SELECT COUNT(*) AS count FROM b3_market_prices").fetchone()["count"]
        incomes = conn.execute("SELECT COUNT(*) AS count FROM b3_income_events").fetchone()["count"]
        cancelled_auto = conn.execute("SELECT is_cancelled FROM events WHERE id = ?", (auto_event["id"],)).fetchone()
        active_manual = conn.execute("SELECT is_cancelled FROM events WHERE id = ?", (manual["id"],)).fetchone()
        position = event_service.get_position(conn, portfolio["id"], knox["id"])

    assert result == {
        "portfolio_id": portfolio["id"],
        "reference_month": "2025-11",
        "imports_removed": 1,
        "market_prices_removed": 5,
        "income_events_removed": 1,
        "ledger_events_cancelled": 1,
    }
    assert imports == 0
    assert prices == 0
    assert incomes == 0
    assert cancelled_auto["is_cancelled"] == 1
    assert active_manual["is_cancelled"] == 0
    assert position["quantity"] == "10"
    assert position["total_cost"] == "1000"


def test_sanitize_b3_monthly_import_is_scoped_to_portfolio(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        first = portfolio_service.create_portfolio(conn, "Principal")
        second = portfolio_service.create_portfolio(conn, "Reserva")
        asset = asset_service.create_asset(conn, AssetClass.ACAO.value, "XPTO3", market="BR", cnpj="12345678000190")
        first_import = conn.execute(
            """
            INSERT INTO b3_monthly_imports (portfolio_id, filename, reference_month, reference_date)
            VALUES (?, ?, ?, ?)
            """,
            (first["id"], "2025-11.xlsx", "2025-11", "2025-11-30"),
        ).lastrowid
        second_import = conn.execute(
            """
            INSERT INTO b3_monthly_imports (portfolio_id, filename, reference_month, reference_date)
            VALUES (?, ?, ?, ?)
            """,
            (second["id"], "2025-11.xlsx", "2025-11", "2025-11-30"),
        ).lastrowid
        for import_id, source_row in [(first_import, 2), (second_import, 3)]:
            conn.execute(
                """
                INSERT INTO b3_market_prices (
                    import_id, asset_id, reference_month, reference_date, source_sheet,
                    source_row, ticker, product, value, is_unit_price, status
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (import_id, asset["id"], "2025-11", "2025-11-30", "Posicao - Acoes", source_row, "XPTO3", "XPTO3", "10", 1, "imported"),
            )
        result = sanitize_b3_monthly_import(conn, first["id"], "2025-11")
        remaining_import = conn.execute("SELECT portfolio_id FROM b3_monthly_imports").fetchone()
        remaining_prices = conn.execute("SELECT COUNT(*) AS count FROM b3_market_prices").fetchone()["count"]

    assert result["imports_removed"] == 1
    assert remaining_import["portfolio_id"] == second["id"]
    assert remaining_prices == 1


def test_sanitize_b3_monthly_import_validates_reference_month(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        try:
            sanitize_b3_monthly_import(conn, 1, "2025-13")
        except ValueError as exc:
            assert "YYYY-MM" in str(exc)
        else:
            raise AssertionError("sanitize_b3_monthly_import should reject invalid months")


def test_b3_market_price_preserves_multiple_b3_rows_for_same_asset_month_sheet(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    content = _workbook_bytes(
        {
            "Posição - Ações": [
                ["XPTO3 - XPTO S.A.", "ITAU", "1", "XPTO3", "12345678000190", None, "ON", None, 10, 10, "-", "-", 12.34, 123.4],
                ["XPTO3 - XPTO S.A.", "BTG", "2", "XPTO3", "12345678000190", None, "ON", None, 5, 5, "-", "-", 12.35, 61.75],
            ],
        }
    )

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset_service.create_asset(conn, AssetClass.ACAO.value, "XPTO3", market="BR", cnpj="12345678000190")

        result = import_b3_monthly_batch(conn, portfolio["id"], [SourceFile("2025-11.xlsx", content)])
        rows = conn.execute("SELECT * FROM b3_market_prices").fetchall()

    assert result["imported_prices"] == 2
    assert result["duplicates"] == 0
    assert len(rows) == 2
    assert [row["value"] for row in rows] == ["12.34", "12.35"]


def test_b3_income_preserves_same_asset_date_type_with_different_values(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    content = _workbook_bytes(
        {
            "Proventos Recebidos": [
                ["EQTL3 - EQUATORIAL ENERGIA S.A.", "28/11/2025", "Juros Sobre Capital Próprio", "ITAU", "10", 0.4, 4],
                ["EQTL3 - EQUATORIAL ENERGIA S.A.", "28/11/2025", "Juros Sobre Capital Próprio", "ITAU", "10", 0.5, 5],
            ],
        }
    )

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset_service.create_asset(conn, AssetClass.ACAO.value, "EQTL3", market="BR")

        result = import_b3_monthly_batch(conn, portfolio["id"], [SourceFile("2025-11.xlsx", content)])
        rows = conn.execute("SELECT * FROM b3_income_events ORDER BY source_row").fetchall()

    assert result["imported_incomes"] == 2
    assert result["duplicates"] == 0
    assert len(rows) == 2
    assert [row["net_value"] for row in rows] == ["4", "5"]


def test_b3_income_matches_known_assets_when_product_ticker_has_alpha_suffix(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    content = _workbook_bytes(
        {
            "Proventos Recebidos": [
                ["HGLG11L - PÁTRIA LOG - FDO INV IMOB - RESPONSABILIDADE LTDA.", "15/01/2026", "Rendimento", "ITAU", "500", 1.1, 550],
                ["KNRI11L - KINEA RENDA IMOBILIÁRIA FDO INV IMOB - FII", "15/01/2026", "Rendimento", "ITAU", "2361", 1.25, 2951.25],
                ["FRAS3L - FRAS-LE S.A.", "16/01/2026", "Juros Sobre Capital Próprio", "ITAU", "4800", 0.37, 1506.58],
                ["AAPL34X - APPLE INC.", "16/01/2026", "Dividendo", "ITAU", "12", 0.5, 6],
            ],
        }
    )

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        hglg = asset_service.create_asset(conn, AssetClass.FII.value, "HGLG11", market="BR")
        knri = asset_service.create_asset(conn, AssetClass.FII.value, "KNRI11", market="BR", name="KINEA RENDA IMOBILIÁRIA FDO INV IMOB - FII")
        fras = asset_service.create_asset(conn, AssetClass.ACAO.value, "FRAS3", market="BR", name="FRAS-LE S.A.")
        aapl = asset_service.create_asset(conn, AssetClass.BDR.value, "AAPL34", market="BR", name="APPLE INC.")

        result = import_b3_monthly_batch(conn, portfolio["id"], [SourceFile("2026-01.xlsx", content)])
        incomes = conn.execute("SELECT * FROM b3_income_events ORDER BY source_row").fetchall()
        reviews = asset_service.list_match_reviews(conn)

    assert result["imported_incomes"] == 4
    assert result["review_count"] == 0
    assert reviews == []
    assert [row["ticker"] for row in incomes] == ["HGLG11", "KNRI11", "FRAS3", "AAPL34"]
    assert [row["asset_id"] for row in incomes] == [hglg["id"], knri["id"], fras["id"], aapl["id"]]
    assert [row["status"] for row in incomes] == ["imported", "imported", "imported", "imported"]
    assert incomes[0]["product"].startswith("HGLG11L - ")


def test_b3_income_l_suffix_keeps_review_when_canonical_ticker_is_ambiguous(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    content = _workbook_bytes(
        {
            "Proventos Recebidos": [
                ["HGLG11L - PÁTRIA LOG - FDO INV IMOB - RESPONSABILIDADE LTDA.", "15/01/2026", "Rendimento", "ITAU", "500", 1.1, 550],
            ],
        }
    )

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset_service.create_asset(conn, AssetClass.FII.value, "HGLG11", market="BR")
        asset_service.create_asset(conn, AssetClass.FII.value, "HGLG11", market="BR", allow_existing=False)

        result = import_b3_monthly_batch(conn, portfolio["id"], [SourceFile("2026-01.xlsx", content)])
        income = conn.execute("SELECT * FROM b3_income_events").fetchone()
        reviews = asset_service.list_match_reviews(conn)

    assert result["imported_incomes"] == 1
    assert result["review_count"] == 1
    assert income["asset_id"] is None
    assert income["ticker"] == "HGLG11"
    assert income["status"] == "review"
    assert len(reviews) == 1
    assert reviews[0]["ticker"] == "HGLG11"


def test_b3_income_l_suffix_keeps_review_when_registered_name_conflicts(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    content = _workbook_bytes(
        {
            "Proventos Recebidos": [
                ["FRAS3L - FRAS-LE S.A.", "16/01/2026", "Juros Sobre Capital Próprio", "ITAU", "4800", 0.37, 1506.58],
            ],
        }
    )

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset_service.create_asset(conn, AssetClass.ACAO.value, "FRAS3", market="BR", name="EMPRESA DIFERENTE S.A.")

        result = import_b3_monthly_batch(conn, portfolio["id"], [SourceFile("2026-01.xlsx", content)])
        income = conn.execute("SELECT * FROM b3_income_events").fetchone()
        reviews = asset_service.list_match_reviews(conn)

    assert result["review_count"] == 1
    assert income["asset_id"] is None
    assert income["ticker"] == "FRAS3"
    assert income["status"] == "review"
    assert len(reviews) == 1
    assert reviews[0]["ticker"] == "FRAS3"


def test_b3_market_price_consolidates_fixed_income_and_treasury_positions(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    content = _workbook_bytes(
        {
            "Posição - Renda Fixa": [
                ["DEB - CIA TESTE", "ITAU", "CIA", "DEB123", "IPCA", "DEPOSITADO", "01/01/2024", "01/01/2030", 1, 1, "-", "-", "-", 100, 1000],
                ["DEB - CIA TESTE", "BTG", "CIA", "DEB123", "IPCA", "DEPOSITADO", "01/01/2024", "01/01/2030", 2, 2, "-", "-", "-", 100, 2000],
            ],
            "Posição - Tesouro Direto": [
                ["Tesouro IPCA+ com Juros Semestrais 2045", "ITAU", "BRSTN", "IPCA", "15/05/2045", 1, 1, 0, "-", 100, 110, 109, 111],
                ["Tesouro IPCA+ com Juros Semestrais 2045", "BTG", "BRSTN", "IPCA", "15/05/2045", 2, 2, 0, "-", 200, 220, 218, 222],
            ],
        }
    )

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        deb = asset_service.create_asset(conn, AssetClass.DEBENTURE.value, "DEB123", market="BR")
        tesouro = asset_service.create_asset(
            conn,
            AssetClass.TESOURO_DIRETO.value,
            "TD2045",
            market="BR",
            name="Tesouro IPCA+ com Juros Semestrais 2045",
            maturity_date="2045-05-15",
        )

        result = import_b3_monthly_batch(conn, portfolio["id"], [SourceFile("2025-11.xlsx", content)])
        second = import_b3_monthly_batch(conn, portfolio["id"], [SourceFile("2025-11.xlsx", content)])
        deb_price = conn.execute("SELECT * FROM b3_market_prices WHERE asset_id = ?", (deb["id"],)).fetchone()
        tesouro_price = conn.execute("SELECT * FROM b3_market_prices WHERE asset_id = ?", (tesouro["id"],)).fetchone()
        rows = conn.execute("SELECT COUNT(*) AS count FROM b3_market_prices").fetchone()["count"]

    assert result["imported_prices"] == 4
    assert result["duplicates"] == 0
    assert second["imported_prices"] == 0
    assert second["duplicates"] == 4
    assert rows == 2
    assert deb_price["value"] == "3000"
    assert deb_price["is_unit_price"] == 0
    assert tesouro_price["value"] == "333"
    assert tesouro_price["is_unit_price"] == 0


def test_b3_fixed_income_stops_on_blank_product_filters_and_creates_debenture_with_maturity(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    content = _workbook_bytes(
        {
            "PosiÃ§Ã£o - Renda Fixa": [
                ["CDB - BANCO TESTE", "ITAU", "BANCO TESTE", "CDB123", "IPCA", "DEPOSITADO", "01/01/2024", "01/01/2030", 1, 1, "-", "-", "-", 100, 100],
                ["CRI - SEC TESTE", "ITAU", "SEC TESTE", "CRI123", "IPCA", "DEPOSITADO", "01/01/2024", "01/01/2031", 1, 1, "-", "-", "-", 100, 200],
                ["DEB - CIA NOVA", "ITAU", "CIA NOVA", "DEB999", "IPCA", "DEPOSITADO", "01/01/2024", "15/07/2032", 7, 7, "-", "-", "-", 100, 700],
                [None, "BTG", "CIA IGNORADA", "DEB000", "IPCA", "DEPOSITADO", "01/01/2024", "15/07/2033", 1, 1, "-", "-", "-", 100, 999],
                ["DEB - CIA DEPOIS", "BTG", "CIA DEPOIS", "DEB111", "IPCA", "DEPOSITADO", "01/01/2024", "15/07/2034", 1, 1, "-", "-", "-", 100, 111],
            ],
        }
    )

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        result = import_b3_monthly_batch(conn, portfolio["id"], [SourceFile("2025-11.xlsx", content)])
        assets = asset_service.list_assets(conn)
        prices = conn.execute("SELECT * FROM b3_market_prices").fetchall()

    assert result["imported_prices"] == 1
    assert len(prices) == 1
    assert prices[0]["ticker"] == "DEB999"
    assert prices[0]["value"] == "700"
    assert len(assets) == 1
    assert assets[0]["current_ticker"] == "DEB999"
    assert assets[0]["name"] == "CIA NOVA"
    assert assets[0]["maturity_date"] == "2032-07-15"


def test_b3_debenture_income_matches_position_by_product_and_clean_quantity(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    content = _workbook_bytes(
        {
            "PosiÃ§Ã£o - Renda Fixa": [
                ["DEB - CIA MATCH", "ITAU", "CIA MATCH", "MATCH1", "IPCA", "DEPOSITADO", "01/01/2024", "15/07/2032", 4200, 4200, "-", "-", "-", 100, 4200],
            ],
            "Proventos Recebidos": [
                ["DEB - CIA MATCH", "28/11/2025", "PAGAMENTO DE JUROS", "ITAU", "'4.200 ações'", 0.1, 420],
            ],
        }
    )

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        result = import_b3_monthly_batch(conn, portfolio["id"], [SourceFile("2025-11.xlsx", content)])
        income = conn.execute("SELECT * FROM b3_income_events").fetchone()

    assert result["imported_prices"] == 1
    assert result["imported_incomes"] == 1
    assert result["review_count"] == 0
    assert income["ticker"] == "MATCH1"
    assert income["quantity"] == "4200"
    assert income["status"] == "imported"


def test_b3_income_summary_only_for_cri_and_unmapped_without_ledger_or_review(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    content = _workbook_bytes(
        {
            "Proventos Recebidos": [
                ["CRI - SEC TESTE", "18/02/2026", "PAGAMENTO DE JUROS", "ITAU", "4", 34.535, 138.14],
                ["Produto sem regra", "18/02/2026", "Rendimento", "ITAU", "1", 10, 10],
            ],
        }
    )

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        result = import_b3_monthly_batch(conn, portfolio["id"], [SourceFile("2026-02.xlsx", content)])
        incomes = conn.execute("SELECT * FROM b3_income_events ORDER BY source_row").fetchall()
        events_count = conn.execute("SELECT COUNT(*) AS count FROM events").fetchone()["count"]
        reviews = asset_service.list_match_reviews(conn)

    assert result["imported_incomes"] == 2
    assert result["review_count"] == 0
    assert events_count == 0
    assert reviews == []
    assert [row["status"] for row in incomes] == ["summary_only", "summary_only"]
    assert [row["asset_id"] for row in incomes] == [None, None]


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


def test_b3_import_reuses_pending_review_for_unmatched_asset(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    content = _workbook_bytes(
        {
            "Posição - Ações": [["MISS3 - MISSING S.A.", "ITAU", "1", "MISS3", "12345678000190", None, "ON", None, 10, 10, "-", "-", 12.34, 123.4]],
        }
    )

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        first = import_b3_monthly_batch(conn, portfolio["id"], [SourceFile("2025-11.xlsx", content)])
        second = import_b3_monthly_batch(conn, portfolio["id"], [SourceFile("2025-11.xlsx", content)])
        reviews = asset_service.list_match_reviews(conn)
        price = conn.execute("SELECT * FROM b3_market_prices").fetchone()

    assert first["review_count"] == 1
    assert second["review_count"] == 1
    assert len(reviews) == 1
    assert price["review_id"] == reviews[0]["id"]


def test_b3_upserts_normalize_status_ticker_and_boolean_or_reject_invalid_values(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset = asset_service.create_asset(conn, AssetClass.ACAO.value, "XPTO3", market="BR")
        import_id = conn.execute(
            """
            INSERT INTO b3_monthly_imports (portfolio_id, filename, reference_month, reference_date)
            VALUES (?, ?, ?, ?)
            """,
            (portfolio["id"], "2025-11.xlsx", "2025-11", "2025-11-30"),
        ).lastrowid

        with pytest.raises(ValueError, match="Status de importacao"):
            b3_service._upsert_market_price(
                conn,
                {
                    "import_id": import_id,
                    "asset_id": asset["id"],
                    "reference_month": "2025-11",
                    "reference_date": "2025-11-30",
                    "source_sheet": "Posição - Ações",
                    "source_row": 2,
                    "ticker": " xpto3 ",
                    "product": "XPTO3",
                    "cnpj": None,
                    "maturity_date": None,
                    "value": "10",
                    "is_unit_price": True,
                    "status": "IMPORTED",
                    "review_id": None,
                    "raw_payload": {},
                },
            )
        assert conn.execute("SELECT COUNT(*) AS count FROM b3_market_prices").fetchone()["count"] == 0

        b3_service._upsert_market_price(
            conn,
            {
                "import_id": import_id,
                "asset_id": asset["id"],
                "reference_month": "2025-11",
                "reference_date": "2025-11-30",
                "source_sheet": "Posição - Ações",
                "source_row": 2,
                "ticker": " xpto3 ",
                "product": "XPTO3",
                "cnpj": None,
                "maturity_date": None,
                "value": "10",
                "is_unit_price": "0",
                "status": "imported",
                "review_id": None,
                "raw_payload": {},
            },
        )
        price = conn.execute("SELECT * FROM b3_market_prices").fetchone()
        assert price["ticker"] == "XPTO3"
        assert price["is_unit_price"] == 0
        assert price["status"] == "imported"

        with pytest.raises(ValueError, match="Status de importacao"):
            b3_service._upsert_income(
                conn,
                {
                    "import_id": import_id,
                    "portfolio_id": portfolio["id"],
                    "asset_id": asset["id"],
                    "source_row": 3,
                    "payment_date": "2025-11-28",
                    "event_type": "Rendimento",
                    "product": "XPTO3",
                    "ticker": "xpto3",
                    "quantity": "1",
                    "unit_price": "1",
                    "net_value": "1",
                    "status": "done",
                    "ledger_event_id": None,
                    "review_id": None,
                    "raw_payload": {},
                },
            )
        assert conn.execute("SELECT COUNT(*) AS count FROM b3_income_events").fetchone()["count"] == 0


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
