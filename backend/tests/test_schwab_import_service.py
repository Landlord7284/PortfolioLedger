import json
from decimal import Decimal

from backend.database import get_db, init_db
from backend.domain.enums import AssetClass, EventType
from backend.services import (
    asset_service,
    event_service,
    foreign_annual_report_service,
    foreign_report_service,
    portfolio_service,
    ptax_service,
)
from backend.services import schwab_import_service as schwab_service
from backend.services.schwab_import_service import SourceFile, import_schwab_json_batch


def _patch_ptax(monkeypatch):
    def fake_get_ptax(_date, conn=None):
        return {"venda": Decimal("5.00"), "compra": Decimal("4.90")}

    monkeypatch.setattr("backend.services.ptax_service.get_ptax", fake_get_ptax)
    monkeypatch.setattr("backend.services.fiscal_lot_service.get_ptax", fake_get_ptax)


def _sample_json_bytes():
    payload = {
        "FromDate": "01/01/2024",
        "ToDate": "12/31/2025",
        "TotalTransactionsAmount": "$1,234.56",
        "TotalFeesAndCommAmount": "$0.01",
        "BrokerageTransactions": [
            {
                "Date": "12/01/2025 as of 11/28/2025",
                "Action": "Cash In Lieu",
                "Symbol": "SCCO",
                "Description": "SOUTHERN COPPER CORP",
                "Quantity": "",
                "Price": "",
                "Fees & Comm": "",
                "Amount": "$2.30",
                "AcctgRuleCd": "1",
            },
            {
                "Date": "11/17/2025 as of 11/14/2025",
                "Action": "NRAPTPTAX_1446f",
                "Symbol": "EPD",
                "Description": "ENTERPRISE PRODS PART LP",
                "Quantity": "",
                "Price": "",
                "Fees & Comm": "",
                "Amount": "-$0.27",
                "AcctgRuleCd": "1",
            },
            {
                "Date": "01/16/2025",
                "Action": "Wire Received",
                "Symbol": "",
                "Description": "WIRED FUNDS RECEIVED",
                "Quantity": "",
                "Price": "",
                "Fees & Comm": "",
                "Amount": "$1,018.73",
                "AcctgRuleCd": "1",
            },
            {
                "Date": "12/30/2024",
                "Action": "Credit Interest",
                "Symbol": "",
                "Description": "SCHWAB1 INT 11/27-12/29",
                "Quantity": "",
                "Price": "",
                "Fees & Comm": "",
                "Amount": "$0.02",
                "AcctgRuleCd": "1",
            },
            {
                "Date": "12/29/2024",
                "Action": "Cash Dividend",
                "Symbol": "SCCO",
                "Description": "SOUTHERN COPPER CORP",
                "Quantity": "",
                "Price": "",
                "Fees & Comm": "",
                "Amount": "$1.80",
                "AcctgRuleCd": "1",
            },
            {
                "Date": "12/29/2024",
                "Action": "NRA Tax Adj",
                "Symbol": "SCCO",
                "Description": "SOUTHERN COPPER CORP",
                "Quantity": "",
                "Price": "",
                "Fees & Comm": "",
                "Amount": "-$0.54",
                "AcctgRuleCd": "1",
            },
            {
                "Date": "12/28/2024",
                "Action": "Cash Dividend",
                "Symbol": "",
                "Description": "TDA TRAN - QUALIFIED DIVIDEND (MSFT)",
                "Quantity": "",
                "Price": "",
                "Fees & Comm": "",
                "Amount": "$3.41",
                "AcctgRuleCd": "1",
            },
            {
                "Date": "12/28/2024",
                "Action": "Journaled Shares",
                "Symbol": "",
                "Description": "TDA TRAN - W-8 WITHHOLDING (MSFT)",
                "Quantity": "",
                "Price": "",
                "Fees & Comm": "",
                "Amount": "-$1.02",
                "AcctgRuleCd": "1",
            },
            {
                "Date": "12/15/2024",
                "Action": "Internal Transfer",
                "Symbol": "SCCO",
                "Description": "SOUTHERN COPPER CORP",
                "Quantity": "2",
                "Price": "",
                "Fees & Comm": "",
                "Amount": "",
                "AcctgRuleCd": "1",
            },
            {
                "Date": "12/14/2024",
                "Action": "Journaled Shares",
                "Symbol": "SCCO",
                "Description": "TDA TRAN - TRANSFER OF SECURITY OR OPTION OUT (SCCO)",
                "Quantity": "-2",
                "Price": "",
                "Fees & Comm": "",
                "Amount": "",
                "AcctgRuleCd": "1",
            },
            {
                "Date": "12/01/2024",
                "Action": "Spin-off",
                "Symbol": "SOLV",
                "Description": "SOLVENTUM CORP",
                "Quantity": "2",
                "Price": "",
                "Fees & Comm": "",
                "Amount": "",
                "AcctgRuleCd": "1",
            },
            {
                "Date": "11/28/2024",
                "Action": "Sell",
                "Symbol": "SCCO",
                "Description": "SOUTHERN COPPER CORP",
                "Quantity": "1",
                "Price": "$110.00",
                "Fees & Comm": "$0.01",
                "Amount": "$109.99",
                "AcctgRuleCd": "1",
            },
            {
                "Date": "11/27/2024",
                "Action": "Buy",
                "Symbol": "SCCO",
                "Description": "SOUTHERN COPPER CORP",
                "Quantity": "2",
                "Price": "$100.1977",
                "Fees & Comm": "",
                "Amount": "-$200.40",
                "AcctgRuleCd": "1",
            },
        ],
    }
    return json.dumps(payload).encode("utf-8")


def _json_bytes(transactions, *, from_date="01/01/2024", to_date="12/31/2025"):
    return json.dumps(
        {
            "AccountNumber": "XXX910",
            "FromDate": from_date,
            "ToDate": to_date,
            "TotalTransactionsAmount": "$0.00",
            "TotalFeesAndCommAmount": "$0.00",
            "BrokerageTransactions": transactions,
        }
    ).encode("utf-8")


def _buy_transaction():
    return {
        "Date": "11/27/2024",
        "Action": "Buy",
        "Symbol": "SCCO",
        "Description": "SOUTHERN COPPER CORP",
        "Quantity": "2",
        "Price": "$100.1977",
        "Fees & Comm": "",
        "Amount": "-$200.40",
        "AcctgRuleCd": "1",
    }


def _sell_transaction():
    return {
        "Date": "11/28/2024",
        "Action": "Sell",
        "Symbol": "SCCO",
        "Description": "SOUTHERN COPPER CORP",
        "Quantity": "1",
        "Price": "$110.00",
        "Fees & Comm": "$0.01",
        "Amount": "$109.99",
        "AcctgRuleCd": "1",
    }


def _cash_in_lieu_transaction():
    return {
        "Date": "12/01/2025 as of 11/28/2025",
        "Action": "Cash In Lieu",
        "Symbol": "SCCO",
        "Description": "SOUTHERN COPPER CORP",
        "Quantity": "",
        "Price": "",
        "Fees & Comm": "",
        "Amount": "$2.30",
        "AcctgRuleCd": "1",
    }


def _cash_in_lieu_transaction_with_quantity():
    row = _cash_in_lieu_transaction()
    row["Quantity"] = "0.5"
    return row


def _dividend_transaction(amount="$1.80", date="12/29/2024"):
    return {
        "Date": date,
        "Action": "Cash Dividend",
        "Symbol": "SCCO",
        "Description": "SOUTHERN COPPER CORP",
        "Quantity": "",
        "Price": "",
        "Fees & Comm": "",
        "Amount": amount,
        "AcctgRuleCd": "1",
    }


def _foreign_tax_transaction(amount="-$0.54"):
    return {
        "Date": "03/21/2024",
        "Action": "NRA Tax Adj",
        "Symbol": "SCCO",
        "Description": "SOUTHERN COPPER CORP",
        "Quantity": "",
        "Price": "",
        "Fees & Comm": "",
        "Amount": amount,
        "AcctgRuleCd": "1",
    }


def _interest_transaction(amount="$0.02"):
    return {
        "Date": "03/22/2024",
        "Action": "Credit Interest",
        "Symbol": "",
        "Description": "SCHWAB1 INT 02/27-03/21",
        "Quantity": "",
        "Price": "",
        "Fees & Comm": "",
        "Amount": amount,
        "AcctgRuleCd": "1",
    }


def test_schwab_import_warms_ptax_cache_for_financial_events(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    calls = []

    def fake_fetch(value):
        calls.append(value.isoformat())
        return {"compra": Decimal("4.90"), "venda": Decimal("5.00")}

    monkeypatch.setattr(ptax_service, "_fetch_ptax_from_bcb", fake_fetch)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        result = import_schwab_json_batch(
            conn,
            portfolio["id"],
            [
                SourceFile(
                    "financial.json",
                    _json_bytes(
                        [
                            _dividend_transaction("$10.00", date="03/20/2024"),
                            _foreign_tax_transaction("-$2.00"),
                            _interest_transaction("$0.50"),
                        ],
                        to_date="03/22/2024",
                    ),
                )
            ],
        )
        cached = conn.execute("SELECT date, compra, venda FROM ptax_cache ORDER BY date").fetchall()

    assert result["imported_foreign_events"] == 3
    assert result["warning_count"] == 0
    assert result["errors"] == []
    assert calls == ["2024-03-20", "2024-03-21", "2024-03-22"]
    assert [(row["date"], row["compra"], row["venda"]) for row in cached] == [
        ("2024-03-20", 4.9, 5.0),
        ("2024-03-21", 4.9, 5.0),
        ("2024-03-22", 4.9, 5.0),
    ]


def test_schwab_import_keeps_financial_events_when_ptax_warm_fails(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    def fail_get_ptax(_date, conn=None):
        raise RuntimeError("BC indisponivel")

    monkeypatch.setattr(ptax_service, "get_ptax", fail_get_ptax)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        result = import_schwab_json_batch(
            conn,
            portfolio["id"],
            [
                SourceFile(
                    "financial.json",
                    _json_bytes(
                        [
                            _dividend_transaction("$10.00", date="03/20/2024"),
                            _foreign_tax_transaction("-$2.00"),
                            _interest_transaction("$0.50"),
                        ],
                        to_date="03/22/2024",
                    ),
                )
            ],
        )
        tx_count = conn.execute(
            "SELECT COUNT(*) AS count FROM schwab_transactions WHERE status = 'imported'"
        ).fetchone()["count"]
        cache_count = conn.execute("SELECT COUNT(*) AS count FROM ptax_cache").fetchone()["count"]

    assert result["imported_foreign_events"] == 3
    assert result["warning_count"] == 3
    assert result["errors"] == []
    assert tx_count == 3
    assert cache_count == 0
    assert all("PTAX nao cacheada" in warning for warning in result["files"][0]["warnings"])


def test_foreign_annual_report_uses_ptax_cache_warmed_by_schwab_import(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    def fake_fetch(value):
        return {"compra": Decimal("4.90"), "venda": Decimal("5.00")}

    monkeypatch.setattr(ptax_service, "_fetch_ptax_from_bcb", fake_fetch)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        import_schwab_json_batch(
            conn,
            portfolio["id"],
            [
                SourceFile(
                    "dividend.json",
                    _json_bytes(
                        [_dividend_transaction("$10.00", date="03/20/2024")],
                        to_date="03/20/2024",
                    ),
                )
            ],
        )

        def fail_fetch(_date):
            raise AssertionError("BCB should not be called after import warmed PTAX cache")

        monkeypatch.setattr(ptax_service, "_fetch_ptax_from_bcb", fail_fetch)
        report = foreign_annual_report_service.list_foreign_annual_report(conn, portfolio["id"], 2024)

    assert report["missing_ptax_dates"] == []
    assert report["rows"][0]["gain_loss"] == "50.00"


def test_schwab_import_classifies_and_persists_events(tmp_path, monkeypatch):
    _patch_ptax(monkeypatch)
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")

        result = import_schwab_json_batch(
            conn,
            portfolio["id"],
            [SourceFile("schwab.json", _sample_json_bytes(), account_key="XXX910")],
        )
        events = conn.execute("SELECT * FROM events ORDER BY event_date, sequence_num").fetchall()
        tx_rows = conn.execute("SELECT * FROM schwab_transactions ORDER BY source_row").fetchall()
        alerts = schwab_service.list_asset_alerts(conn, portfolio["id"])
        position = event_service.list_positions(conn, portfolio["id"])

    assert result["imported_ledger_events"] == 3
    assert result["imported_foreign_events"] == 7
    assert result["ignored"] == 2
    assert result["review_count"] == 1
    assert [event["event_type"] for event in events] == [
        EventType.COMPRA.value,
        EventType.VENDA.value,
        EventType.VENDA_FRACAO.value,
    ]
    assert events[2]["quantity"] == "0"
    assert events[2]["event_value"] == "2.30"
    assert any(row["normalized_subtype"] == "w8_withholding" and row["source_symbol"] is None for row in tx_rows)
    assert any(row["normalized_subtype"] == "ptp_1446f" for row in tx_rows)
    assert any(row["normalized_category"] == "cash_transfer" and row["amount"] == "1018.73" for row in tx_rows)
    assert alerts[0]["ticker"] == "SOLV"
    assert alerts[0]["quantity"] == "2"
    assert position[0]["quantity"] == "1"


def test_schwab_import_is_idempotent_for_same_file(tmp_path, monkeypatch):
    _patch_ptax(monkeypatch)
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        source = SourceFile("schwab.json", _sample_json_bytes(), account_key="XXX910")

        first = import_schwab_json_batch(conn, portfolio["id"], [source])
        second = import_schwab_json_batch(conn, portfolio["id"], [source])
        events_count = conn.execute("SELECT COUNT(*) AS count FROM events").fetchone()["count"]
        tx_count = conn.execute("SELECT COUNT(*) AS count FROM schwab_transactions").fetchone()["count"]
        alerts_count = conn.execute("SELECT COUNT(*) AS count FROM schwab_asset_alerts").fetchone()["count"]

    assert first["imported_ledger_events"] == 3
    assert second["imported_ledger_events"] == 0
    assert second["duplicates"] == 10
    assert events_count == 3
    assert tx_count == 13
    assert alerts_count == 1


def test_schwab_import_processes_multiple_files_chronologically(tmp_path, monkeypatch):
    _patch_ptax(monkeypatch)
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")

        result = import_schwab_json_batch(
            conn,
            portfolio["id"],
            [
                SourceFile(
                    "2024-11-28-sell.json",
                    _json_bytes([_sell_transaction()], from_date="11/28/2024", to_date="11/28/2024"),
                ),
                SourceFile(
                    "2024-11-27-buy.json",
                    _json_bytes([_buy_transaction()], from_date="11/27/2024", to_date="11/27/2024"),
                ),
            ],
        )
        events = conn.execute("SELECT * FROM events ORDER BY event_date, sequence_num").fetchall()
        position = event_service.get_position(conn, portfolio["id"], events[0]["asset_id"])

    assert [file["filename"] for file in result["files"]] == [
        "2024-11-27-buy.json",
        "2024-11-28-sell.json",
    ]
    assert result["imported_ledger_events"] == 2
    assert result["errors"] == []
    assert [event["event_type"] for event in events] == [EventType.COMPRA.value, EventType.VENDA.value]
    assert position["quantity"] == "1"


def test_schwab_import_sends_existing_manual_buy_to_review(tmp_path, monkeypatch):
    _patch_ptax(monkeypatch)
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset = asset_service.create_asset(conn, AssetClass.STOCK.value, "SCCO", market="US")
        existing = event_service.create_event(
            conn,
            portfolio_id=portfolio["id"],
            asset_id=asset["id"],
            event_type=EventType.COMPRA.value,
            event_date="2024-11-27",
            quantity="2",
            event_value="200.40",
        )

        result = import_schwab_json_batch(
            conn,
            portfolio["id"],
            [SourceFile("schwab-buy.json", _json_bytes([_buy_transaction()]))],
        )
        events_count = conn.execute("SELECT COUNT(*) AS count FROM events").fetchone()["count"]
        tx = conn.execute("SELECT * FROM schwab_transactions").fetchone()

        confirmed = schwab_service.confirm_transaction_duplicate(conn, tx["id"])

    assert result["imported_ledger_events"] == 0
    assert result["review_count"] == 1
    assert events_count == 1
    assert tx["status"] == "review"
    assert json.loads(tx["duplicate_candidate_event_ids"]) == [existing["id"]]
    assert confirmed["status"] == "duplicate_confirmed"
    assert confirmed["duplicate_of_ledger_event_id"] == existing["id"]


def test_schwab_import_is_idempotent_for_overlapping_financial_events(tmp_path, monkeypatch):
    _patch_ptax(monkeypatch)
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    interest = {
        "Date": "12/30/2024",
        "Action": "Credit Interest",
        "Symbol": "",
        "Description": "SCHWAB1 INT 11/27-12/29",
        "Quantity": "",
        "Price": "",
        "Fees & Comm": "",
        "Amount": "$0.02",
        "AcctgRuleCd": "1",
    }

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        first = import_schwab_json_batch(
            conn,
            portfolio["id"],
            [SourceFile("first.json", _json_bytes([_dividend_transaction()], to_date="12/29/2024"))],
        )
        second = import_schwab_json_batch(
            conn,
            portfolio["id"],
            [SourceFile("overlap.json", _json_bytes([_dividend_transaction(), interest], to_date="12/30/2024"))],
        )
        tx_count = conn.execute("SELECT COUNT(*) AS count FROM schwab_transactions").fetchone()["count"]

    assert first["imported_foreign_events"] == 1
    assert second["duplicates"] == 1
    assert second["imported_foreign_events"] == 1
    assert second["review_count"] == 0
    assert tx_count == 3


def test_schwab_cash_in_lieu_uses_v_fracao_and_duplicate_review(tmp_path, monkeypatch):
    _patch_ptax(monkeypatch)
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset = asset_service.create_asset(conn, AssetClass.STOCK.value, "SCCO", market="US")
        existing = event_service.create_event(
            conn,
            portfolio_id=portfolio["id"],
            asset_id=asset["id"],
            event_type=EventType.VENDA_FRACAO.value,
            event_date="2025-12-01",
            quantity=None,
            event_value="2.30",
        )

        result = import_schwab_json_batch(
            conn,
            portfolio["id"],
            [SourceFile("cash-in-lieu.json", _json_bytes([_cash_in_lieu_transaction()]))],
        )
        events = conn.execute("SELECT * FROM events ORDER BY id").fetchall()
        tx = conn.execute("SELECT * FROM schwab_transactions").fetchone()

    assert result["imported_ledger_events"] == 0
    assert result["review_count"] == 1
    assert len(events) == 1
    assert events[0]["event_type"] == EventType.VENDA_FRACAO.value
    assert events[0]["quantity"] == "0"
    assert tx["status"] == "review"
    assert json.loads(tx["duplicate_candidate_event_ids"]) == [existing["id"]]


def test_schwab_cash_in_lieu_uses_source_quantity_when_present(tmp_path, monkeypatch):
    _patch_ptax(monkeypatch)
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset = asset_service.create_asset(conn, AssetClass.STOCK.value, "SCCO", market="US")
        event_service.create_event(
            conn,
            portfolio_id=portfolio["id"],
            asset_id=asset["id"],
            event_type=EventType.COMPRA.value,
            event_date="2025-11-01",
            quantity="1",
            event_value="10.00",
        )
        result = import_schwab_json_batch(
            conn,
            portfolio["id"],
            [SourceFile("cash-in-lieu.json", _json_bytes([_cash_in_lieu_transaction_with_quantity()]))],
        )
        event = conn.execute("SELECT * FROM events WHERE event_type = ?", (EventType.VENDA_FRACAO.value,)).fetchone()

    assert result["imported_ledger_events"] == 1
    assert event["event_type"] == EventType.VENDA_FRACAO.value
    assert event["quantity"] == "0.5"


def test_foreign_report_consolidates_schwab_events(tmp_path, monkeypatch):
    _patch_ptax(monkeypatch)
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        import_schwab_json_batch(
            conn,
            portfolio["id"],
            [SourceFile("schwab.json", _sample_json_bytes(), account_key="UNKNOWN")],
        )

        report = foreign_report_service.list_foreign_report(conn, portfolio["id"], 2025)

    totals = {row["category"]: row for row in report["totals"]}
    assert totals[EventType.VENDA_FRACAO.value]["amount_usd"] == "2.30"
    assert totals[EventType.VENDA_FRACAO.value]["amount_brl"] == "11.50"
    assert totals["Imposto pago no exterior"]["amount_usd"] == "0.27"
    assert report["missing_ptax_dates"] == []
