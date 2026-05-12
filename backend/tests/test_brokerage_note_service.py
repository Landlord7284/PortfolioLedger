import pytest

from backend.database import get_db, init_db
from backend.domain.enums import AssetClass
from backend.services import asset_service
from backend.services.brokerage_note_service import (
    BrokerageNoteValidationError,
    calculate_brokerage_note,
    save_brokerage_note,
)
from backend.services.portfolio_service import create_portfolio


def _operation(ticker="AAAA3", operation_type="Compra", quantity="10", gross_value="1000.00", asset_class=None):
    return {
        "asset_class": asset_class or AssetClass.ACAO.value,
        "ticker": ticker,
        "operation_type": operation_type,
        "quantity": quantity,
        "gross_value": gross_value,
    }


def _payload(debit_credit="D", net_amount="1001.00", operations=None):
    return {
        "note_date": "2026-05-11",
        "debit_credit": debit_credit,
        "net_amount": net_amount,
        "operations": operations or [_operation()],
    }


def test_base_spreadsheet_case():
    result = calculate_brokerage_note({
        "note_date": "2026-04-23",
        "debit_credit": "C",
        "net_amount": "13720.37",
        "operations": [
            _operation("KLBN4", "C", "1600", "5872.00"),
            _operation("LJQQ33", "V", "10000", "19600.00"),
        ],
    })

    assert result["summary"]["purchase_total"] == "5872.00"
    assert result["summary"]["sale_total"] == "19600.00"
    assert result["summary"]["operation_total"] == "25472.00"
    assert result["summary"]["operation_difference"] == "-13728.00"
    assert result["summary"]["total_costs"] == "7.63"
    assert result["summary"]["reconciled"] is True

    assert result["events"][0]["ticker"] == "KLBN4"
    assert result["events"][0]["event_type"] == "Compra"
    assert result["events"][0]["quantity"] == "1600"
    assert result["events"][0]["calculated_price"] == "3.67"
    assert result["events"][0]["allocated_fee"] == "1.75"
    assert result["events"][0]["event_value"] == "5873.75"

    assert result["events"][1]["ticker"] == "LJQQ33"
    assert result["events"][1]["event_type"] == "Venda"
    assert result["events"][1]["quantity"] == "10000"
    assert result["events"][1]["calculated_price"] == "1.96"
    assert result["events"][1]["allocated_fee"] == "5.87"
    assert result["events"][1]["event_value"] == "19594.13"


def test_accepts_mojibake_asset_class_alias():
    result = calculate_brokerage_note(_payload(operations=[
        _operation(asset_class="AÃ§Ã£o"),
    ]))

    assert result["events"][0]["asset_class"] == AssetClass.ACAO.value


def test_calculates_purchase_note_with_debit_net_amount():
    result = calculate_brokerage_note(_payload())

    assert result["summary"]["reconciled"] is True
    assert result["summary"]["total_costs"] == "1.00"
    assert result["events"][0]["event_type"] == "Compra"
    assert result["events"][0]["event_value"] == "1001.00"


def test_calculates_sale_note_with_credit_net_amount():
    result = calculate_brokerage_note(_payload(
        debit_credit="C",
        net_amount="999.00",
        operations=[_operation(operation_type="Venda")],
    ))

    assert result["summary"]["reconciled"] is True
    assert result["summary"]["total_costs"] == "1.00"
    assert result["events"][0]["event_type"] == "Venda"
    assert result["events"][0]["event_value"] == "999.00"


def test_rejects_invalid_debit_credit():
    with pytest.raises(BrokerageNoteValidationError, match="D/C"):
        calculate_brokerage_note(_payload(debit_credit="X"))


def test_rejects_invalid_operation_type():
    with pytest.raises(BrokerageNoteValidationError, match="Operação"):
        calculate_brokerage_note(_payload(operations=[_operation(operation_type="Troca")]))


@pytest.mark.parametrize("quantity", ["0", "-1"])
def test_rejects_zero_or_negative_quantity(quantity):
    with pytest.raises(BrokerageNoteValidationError, match="quantidade"):
        calculate_brokerage_note(_payload(operations=[_operation(quantity=quantity)]))


@pytest.mark.parametrize("gross_value", ["0", "-1"])
def test_rejects_zero_or_negative_gross_value(gross_value):
    with pytest.raises(BrokerageNoteValidationError, match="valor bruto"):
        calculate_brokerage_note(_payload(operations=[_operation(gross_value=gross_value)]))


def test_rejects_unreconciled_note_with_negative_total_costs():
    with pytest.raises(BrokerageNoteValidationError, match="não reconciliada"):
        calculate_brokerage_note(_payload(
            debit_credit="C",
            net_amount="10.00",
            operations=[_operation(operation_type="Compra", gross_value="1000.00")],
        ))


def test_rejects_operation_without_ticker():
    with pytest.raises(BrokerageNoteValidationError, match="ticker"):
        calculate_brokerage_note(_payload(operations=[_operation(ticker="")]))


def test_save_creates_ledger_events_through_import_pipeline(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        portfolio = create_portfolio(conn, "Principal")
        result = save_brokerage_note(conn, _payload(), portfolio["id"])

        rows = conn.execute("SELECT * FROM events").fetchall()
        assert result["import_result"]["imported"] == 1
        assert len(rows) == 1
        assert rows[0]["event_type"] == "Compra"
        assert rows[0]["event_value"] == "1001.00"


def test_save_sends_ambiguous_asset_to_review(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        portfolio = create_portfolio(conn, "Principal")
        asset_service.create_asset(conn, AssetClass.ACAO.value, "XPTO3", market="BR")
        result = save_brokerage_note(conn, _payload(
            operations=[_operation("XPTO3", asset_class="FII")],
        ), portfolio["id"])

        assert result["import_result"]["review_count"] == 1
        assert result["import_result"]["imported"] == 0
        assert len(asset_service.list_match_reviews(conn)) == 1


def test_save_marks_duplicate_like_xlsx_import(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        portfolio = create_portfolio(conn, "Principal")
        first = save_brokerage_note(conn, _payload(), portfolio["id"])
        second = save_brokerage_note(conn, _payload(), portfolio["id"])

        rows = conn.execute("SELECT * FROM events ORDER BY id").fetchall()
        assert first["import_result"]["duplicates"] == 0
        assert second["import_result"]["duplicates"] == 1
        assert len(rows) == 2
        assert rows[1]["duplicate_flag"] == 1
