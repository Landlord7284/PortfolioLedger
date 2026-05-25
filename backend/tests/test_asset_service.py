import json
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook

from backend.database import get_db, init_db
from backend.domain.enums import AssetClass
from backend.main import app
from backend.services import asset_service
from backend.services.import_service import import_to_ledger
from backend.services.portfolio_service import create_portfolio


def test_delete_merged_target_clears_merge_reference(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        source = asset_service.create_asset(conn, AssetClass.ACAO.value, "AAAA3", market="BR")
        target = asset_service.create_asset(conn, AssetClass.ACAO.value, "BBBB3", market="BR")

        asset_service.merge_assets(conn, source["id"], target["id"])
        assert asset_service.delete_asset(conn, target["id"])

        assert asset_service.get_asset(conn, target["id"]) is None
        unmerged_source = asset_service.get_asset(conn, source["id"])
        assert unmerged_source["merged_into_asset_id"] is None
        assert unmerged_source["merged_at"] is None


def test_asset_service_persists_fiscal_fields_on_create_update_and_response(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        asset = asset_service.create_asset(
            conn,
            AssetClass.FI_INFRA.value,
            "INFRA11",
            market="BR",
            fiscal_regime_override="FI_INFRA_EXEMPT",
            fiscal_tax_treatment="EXEMPT_ZERO",
        )
        assert asset["fiscal_regime_override"] == "FI_INFRA_EXEMPT"
        assert asset["fiscal_tax_treatment"] == "EXEMPT_ZERO"

        updated = asset_service.update_asset_metadata(
            conn,
            asset["id"],
            fiscal_regime_override="B3_COMMON_15",
            fiscal_tax_treatment="TAXABLE",
        )

        assert updated["fiscal_regime_override"] == "B3_COMMON_15"
        assert updated["fiscal_tax_treatment"] == "TAXABLE"
        assert asset_service.get_asset(conn, asset["id"])["fiscal_tax_treatment"] == "TAXABLE"


def test_asset_api_contract_exposes_fiscal_fields_on_create_get_and_patch(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    monkeypatch.setattr("backend.routers.assets.get_db", lambda: get_db(db_path))
    client = TestClient(app)

    create_response = client.post(
        "/api/assets",
        json={
            "asset_class": AssetClass.FI_INFRA.value,
            "ticker": "INFRA11",
            "market": "BR",
            "fiscal_regime_override": "FI_INFRA_EXEMPT",
            "fiscal_tax_treatment": "EXEMPT_ZERO",
        },
    )

    assert create_response.status_code == 200
    created = create_response.json()
    assert created["fiscal_regime_override"] == "FI_INFRA_EXEMPT"
    assert created["fiscal_tax_treatment"] == "EXEMPT_ZERO"

    patch_response = client.patch(
        f"/api/assets/{created['id']}",
        json={
            "fiscal_regime_override": "B3_COMMON_15",
            "fiscal_tax_treatment": "TAXABLE",
        },
    )
    assert patch_response.status_code == 200
    patched = patch_response.json()
    assert patched["fiscal_regime_override"] == "B3_COMMON_15"
    assert patched["fiscal_tax_treatment"] == "TAXABLE"

    get_response = client.get(f"/api/assets/{created['id']}")
    assert get_response.status_code == 200
    fetched = get_response.json()
    assert fetched["fiscal_regime_override"] == "B3_COMMON_15"
    assert fetched["fiscal_tax_treatment"] == "TAXABLE"

    unsupported_response = client.post(
        "/api/assets",
        json={
            "asset_class": AssetClass.ACAO.value,
            "ticker": "FOREIGN3",
            "market": "BR",
            "fiscal_regime_override": "FOREIGN_14754",
        },
    )
    assert unsupported_response.status_code == 400


def test_probable_match_review_stores_operation_payload(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        asset_service.create_asset(conn, AssetClass.ACAO.value, "XPTO3", market="BR")

        with pytest.raises(ValueError, match="revis"):
            asset_service.create_asset(
                conn,
                "FII",
                "XPTO3",
                market="BR",
                event_date="2026-05-11",
                portfolio_id=7,
                event_type="Compra",
                quantity="10",
                event_value="1000",
                notes="teste",
                source="event_form",
            )

        reviews = asset_service.list_match_reviews(conn)
        assert len(reviews) == 1
        payload = json.loads(reviews[0]["operation_payload"])
        assert payload["ticker"] == "XPTO3"
        assert payload["asset_class"] == "FII"
        assert payload["market"] == "BR"
        assert payload["portfolio_id"] == 7
        assert payload["event_type"] == "Compra"
        assert payload["event_date"] == "2026-05-11"
        assert payload["quantity"] == "10"
        assert payload["event_value"] == "1000"
        assert payload["notes"] == "teste"


def test_probable_match_review_reuses_existing_and_preserves_first_payload(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        asset_service.create_asset(conn, AssetClass.ACAO.value, "XPTO3", market="BR")

        for quantity in ["10", "20"]:
            with pytest.raises(ValueError):
                asset_service.create_asset(
                    conn,
                    "FII",
                    "XPTO3",
                    market="BR",
                    event_date="2026-05-11",
                    portfolio_id=1,
                    event_type="Compra",
                    quantity=quantity,
                    event_value="1000",
                    source="event_form",
                )

        reviews = asset_service.list_match_reviews(conn)
        assert len(reviews) == 1
        payload = json.loads(reviews[0]["operation_payload"])
        assert payload["quantity"] == "10"


def test_import_review_stores_operation_payload(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Registro"
    sheet.append(["Classe", "Ativo", "Evento", "Data", "Quantidade", "Valor Evento", "Valor Bruto"])
    sheet.append(["FII", "XPTO3", "Venda", "2026-05-11", 10, 990, 1000])
    stream = BytesIO()
    workbook.save(stream)
    stream.seek(0)

    with get_db(db_path) as conn:
        portfolio = create_portfolio(conn, "Principal")
        asset_service.create_asset(conn, AssetClass.ACAO.value, "XPTO3", market="BR")

        result = import_to_ledger(conn, stream, portfolio["id"])

        assert result["imported"] == 0
        assert result["skipped"] == 1
        assert result["review_count"] == 1

        reviews = asset_service.list_match_reviews(conn)
        assert len(reviews) == 1
        payload = json.loads(reviews[0]["operation_payload"])
        assert payload["ticker"] == "XPTO3"
        assert payload["asset_class"] == "FII"
        assert payload["portfolio_id"] == portfolio["id"]
        assert payload["event_type"] == "Venda"
        assert payload["event_date"] == "2026-05-11"
        assert payload["quantity"] == "10"
        assert payload["event_value"] == "990"
        assert payload["gross_value"] == "1000"
        assert payload["source_row"] == 2


def test_import_xlsx_persists_gross_value_only_for_sales(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Registro"
    sheet.append(["Classe", "Ativo", "Evento", "Data", "Quantidade", "Valor Evento", "Valor Bruto"])
    sheet.append(["Ação", "XPTO3", "Compra", "2026-05-10", 10, 1000, 1005])
    sheet.append(["Ação", "XPTO3", "Venda", "2026-05-11", 4, 390, 400])
    stream = BytesIO()
    workbook.save(stream)
    stream.seek(0)

    with get_db(db_path) as conn:
        portfolio = create_portfolio(conn, "Principal")
        result = import_to_ledger(conn, stream, portfolio["id"])
        rows = conn.execute("SELECT * FROM events ORDER BY id").fetchall()

    assert result["imported"] == 2
    assert rows[0]["event_type"] == "Compra"
    assert rows[0]["gross_value"] is None
    assert rows[1]["event_type"] == "Venda"
    assert rows[1]["event_value"] == "390"
    assert rows[1]["gross_value"] == "400"


def test_import_xlsx_duplicate_preserves_sale_gross_value(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Registro"
    sheet.append(["Classe", "Ativo", "Evento", "Data", "Quantidade", "Valor Evento", "Valor Bruto"])
    sheet.append(["Ação", "XPTO3", "Compra", "2026-05-10", 10, 1000, None])
    sheet.append(["Ação", "XPTO3", "Venda", "2026-05-11", 4, 390, 400])
    stream = BytesIO()
    workbook.save(stream)

    with get_db(db_path) as conn:
        portfolio = create_portfolio(conn, "Principal")
        stream.seek(0)
        first = import_to_ledger(conn, stream, portfolio["id"])
        stream.seek(0)
        second = import_to_ledger(conn, stream, portfolio["id"])
        rows = conn.execute("SELECT * FROM events ORDER BY id").fetchall()

    assert first["duplicates"] == 0
    assert second["duplicates"] == 2
    assert rows[3]["event_type"] == "Venda"
    assert rows[3]["duplicate_flag"] == 1
    assert rows[3]["gross_value"] == "400"
