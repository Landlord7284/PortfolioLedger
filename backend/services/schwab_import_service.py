"""Schwab/TDA JSON importer.

Schwab transaction exports are treated as an auditable source. Only trade-like
events that belong in patrimonial replay create ledger events; all source rows
are preserved in ``schwab_transactions`` by import row.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from backend.domain.engine import to_decimal
from backend.domain.enums import AssetClass, EventType
from backend.domain.normalization import normalize_ticker
from backend.services import asset_service, event_service


SOURCE = "SCHWAB"
SOURCE_FORMAT = "JSON"
UNKNOWN_ACCOUNT = "UNKNOWN"

DIVIDEND_ACTIONS = {
    "Cash Dividend",
    "Qualified Dividend",
    "Non-Qualified Div",
    "Qual Div Reinvest",
    "Pr Yr Cash Div",
    "Pr Yr Non-Qual Div",
}
WITHHOLDING_ACTIONS = {
    "NRA Tax Adj",
    "Foreign Tax Paid",
    "Pr Yr NRA Tax",
    "NRAPTPTAX_1446f",
}
INTEREST_ACTIONS = {"Credit Interest", "Bond Interest"}
TRADE_ACTIONS = {"Buy", "Sell"}
_TICKER_IN_PARENS_RE = re.compile(r"\(([A-Z0-9./\- ]+)\)\s*$", re.IGNORECASE)


@dataclass
class SourceFile:
    filename: str
    content: bytes
    account_key: str | None = None


@dataclass(frozen=True)
class ParsedDate:
    event_date: str
    effective_date: str | None


def _json_dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, default=str, sort_keys=True)


def _clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _money(value: Any) -> str | None:
    text = _clean_text(value)
    if text is None:
        return None
    cleaned = text.replace("$", "").replace(",", "").replace(" ", "")
    if cleaned.startswith("(") and cleaned.endswith(")"):
        cleaned = "-" + cleaned[1:-1]
    if cleaned in {"", "-"}:
        return None
    try:
        return str(Decimal(cleaned))
    except InvalidOperation as exc:
        raise ValueError(f"Valor monetario invalido: {value}") from exc


def _decimal(value: Any) -> str | None:
    text = _clean_text(value)
    if text is None:
        return None
    try:
        return str(to_decimal(text.replace("$", "").replace(",", "")))
    except Exception as exc:
        raise ValueError(f"Decimal invalido: {value}") from exc


def _date(value: Any) -> str | None:
    text = _clean_text(value)
    if text is None:
        return None
    return datetime.strptime(text, "%m/%d/%Y").date().isoformat()


def _parse_transaction_date(value: Any) -> ParsedDate:
    text = _clean_text(value)
    if text is None:
        raise ValueError("Data ausente.")
    parts = [part.strip() for part in text.split(" as of ", 1)]
    event_date = _date(parts[0])
    effective_date = _date(parts[1]) if len(parts) == 2 else None
    if event_date is None:
        raise ValueError(f"Data invalida: {value}")
    return ParsedDate(event_date, effective_date)


def _source_file_hash(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _normalize_account_key(value: str | None) -> str:
    text = _clean_text(value)
    return text.upper() if text else UNKNOWN_ACCOUNT


def _normalize_schwab_ticker(value: str | None) -> str | None:
    text = _clean_text(value)
    if not text:
        return None
    text = text.replace(" ", "").replace("/", "").replace(".", "")
    return normalize_ticker(text)


def _extract_ticker(raw_symbol: str | None, description: str | None) -> str | None:
    symbol = _normalize_schwab_ticker(raw_symbol)
    if symbol:
        return symbol
    match = _TICKER_IN_PARENS_RE.search(description or "")
    if not match:
        return None
    return _normalize_schwab_ticker(match.group(1))


def _infer_asset_class(ticker: str, description: str | None) -> str:
    desc = (description or "").upper()
    if "REIT" in desc:
        return AssetClass.REIT.value
    if "ETF" in desc:
        return AssetClass.ETF.value
    return AssetClass.STOCK.value


def _category(action: str | None, description: str | None) -> tuple[str, str | None, str | None]:
    action = action or ""
    desc = (description or "").upper()
    if action in TRADE_ACTIONS:
        return "ledger", action.lower(), None
    if action == "Cash In Lieu":
        return "ledger", "cash_in_lieu", None
    if action == "Spin-off":
        return "asset_alert", "spin_off", None
    if action == "Journaled Shares":
        if "W-8 WITHHOLDING" in desc:
            return "foreign_tax", "withholding", "w8_withholding"
        if "TRANSFER OF SECURITY OR OPTION OUT" in desc:
            return "ignored", "custody_transfer", "transfer_out"
        if "CASH MOVEMENT" in desc or "ACCOUNT TRANSFER" in desc:
            return "ignored", "custody_transfer", "cash_migration"
        return "ignored", "journaled_shares", "unclassified"
    if action == "Internal Transfer":
        return "ignored", "custody_transfer", "internal_transfer"
    if action in DIVIDEND_ACTIONS:
        return "dividend", "dividend", action
    if action in WITHHOLDING_ACTIONS:
        subtype = "ptp_1446f" if action == "NRAPTPTAX_1446f" else action
        return "foreign_tax", "withholding", subtype
    if action in INTEREST_ACTIONS:
        return "interest", "cash_interest", action
    if action in {"Wire Received", "MoneyLink Transfer"}:
        return "cash_transfer", "cash_movement", "in" if not (description or "").startswith("-") else None
    return "unknown", None, None


def _economic_fingerprint(row: dict) -> str:
    fields = [
        SOURCE,
        row.get("account_key") or UNKNOWN_ACCOUNT,
        row.get("event_date"),
        row.get("effective_date"),
        row.get("source_action"),
        row.get("ticker"),
        row.get("source_description"),
        row.get("quantity"),
        row.get("price"),
        row.get("amount"),
        row.get("fees_comm"),
        row.get("acctg_rule_cd"),
    ]
    raw = "|".join("" if value is None else str(value) for value in fields)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def parse_schwab_json(source: SourceFile) -> dict:
    try:
        payload = json.loads(source.content.decode("utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"JSON Schwab invalido: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError("JSON Schwab deve conter um objeto no topo.")
    transactions = payload.get("BrokerageTransactions")
    if not isinstance(transactions, list):
        raise ValueError("JSON Schwab deve conter BrokerageTransactions como lista.")

    account_key = _normalize_account_key(source.account_key)
    rows = []
    for row_index, raw in enumerate(transactions, start=1):
        if not isinstance(raw, dict):
            raise ValueError(f"Linha {row_index}: transacao deve ser objeto.")
        parsed_date = _parse_transaction_date(raw.get("Date"))
        action = _clean_text(raw.get("Action"))
        description = _clean_text(raw.get("Description"))
        ticker = _extract_ticker(raw.get("Symbol"), description)
        category, normalized_type, subtype = _category(action, description)
        normalized = {
            "source_row": row_index,
            "account_key": account_key,
            "source_action": action,
            "source_description": description,
            "source_symbol": _clean_text(raw.get("Symbol")),
            "source_date_raw": _clean_text(raw.get("Date")),
            "event_date": parsed_date.event_date,
            "effective_date": parsed_date.effective_date,
            "ticker": ticker,
            "quantity": _decimal(raw.get("Quantity")),
            "price": _money(raw.get("Price")),
            "amount": _money(raw.get("Amount")),
            "fees_comm": _money(raw.get("Fees & Comm")),
            "acctg_rule_cd": _clean_text(raw.get("AcctgRuleCd")),
            "normalized_category": category,
            "normalized_type": normalized_type,
            "normalized_subtype": subtype,
            "raw_payload": raw,
        }
        normalized["economic_fingerprint"] = _economic_fingerprint(normalized)
        rows.append(normalized)

    return {
        "filename": source.filename,
        "file_hash": _source_file_hash(source.content),
        "account_key": account_key,
        "from_date": _date(payload.get("FromDate")),
        "to_date": _date(payload.get("ToDate")),
        "total_transactions_amount": _money(payload.get("TotalTransactionsAmount")),
        "total_fees_comm_amount": _money(payload.get("TotalFeesAndCommAmount")),
        "rows": rows,
    }


def _upsert_import(conn: sqlite3.Connection, portfolio_id: int, parsed: dict) -> int:
    conn.execute(
        """
        INSERT INTO schwab_imports (
            portfolio_id, account_key, filename, file_hash, from_date, to_date,
            total_transactions_amount, total_fees_comm_amount
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(portfolio_id, account_key, file_hash) DO UPDATE SET
            filename = excluded.filename,
            from_date = excluded.from_date,
            to_date = excluded.to_date,
            total_transactions_amount = excluded.total_transactions_amount,
            total_fees_comm_amount = excluded.total_fees_comm_amount,
            total_rows = 0,
            imported_ledger_events = 0,
            imported_foreign_events = 0,
            ignored = 0,
            duplicates = 0,
            review_count = 0,
            warning_count = 0,
            errors = NULL,
            status = 'processed',
            updated_at = datetime('now')
        """,
        (
            portfolio_id,
            parsed["account_key"],
            parsed["filename"],
            parsed["file_hash"],
            parsed["from_date"],
            parsed["to_date"],
            parsed["total_transactions_amount"],
            parsed["total_fees_comm_amount"],
        ),
    )
    row = conn.execute(
        "SELECT id FROM schwab_imports WHERE portfolio_id = ? AND account_key = ? AND file_hash = ?",
        (portfolio_id, parsed["account_key"], parsed["file_hash"]),
    ).fetchone()
    return row["id"]


def _existing_transaction(conn: sqlite3.Connection, import_id: int, source_row: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM schwab_transactions WHERE import_id = ? AND source_row = ?",
        (import_id, source_row),
    ).fetchone()


def _find_prior_duplicate(conn: sqlite3.Connection, portfolio_id: int, account_key: str, fingerprint: str, import_id: int) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT * FROM schwab_transactions
        WHERE portfolio_id = ?
          AND account_key = ?
          AND economic_fingerprint = ?
          AND import_id <> ?
          AND status != 'ignored'
        ORDER BY id LIMIT 1
        """,
        (portfolio_id, account_key, fingerprint, import_id),
    ).fetchone()


def _upsert_transaction(conn: sqlite3.Connection, values: dict) -> tuple[sqlite3.Row, bool]:
    existing = _existing_transaction(conn, values["import_id"], values["source_row"])
    params = (
        values["portfolio_id"],
        values["account_key"],
        values.get("asset_id"),
        values.get("ledger_event_id"),
        values.get("source_action"),
        values.get("source_description"),
        values.get("source_symbol"),
        values.get("source_date_raw"),
        values.get("event_date"),
        values.get("effective_date"),
        values.get("quantity"),
        values.get("price"),
        values.get("amount"),
        values.get("fees_comm"),
        values.get("acctg_rule_cd"),
        values["normalized_category"],
        values.get("normalized_type"),
        values.get("normalized_subtype"),
        values["status"],
        values.get("economic_fingerprint"),
        values.get("duplicate_of_transaction_id"),
        values.get("asset_match_review_id"),
        values.get("asset_alert_id"),
        _json_dumps(values.get("raw_payload") or {}),
    )
    if existing:
        conn.execute(
            """
            UPDATE schwab_transactions
            SET portfolio_id = ?, account_key = ?, asset_id = ?, ledger_event_id = COALESCE(ledger_event_id, ?),
                source_action = ?, source_description = ?, source_symbol = ?, source_date_raw = ?,
                event_date = ?, effective_date = ?, quantity = ?, price = ?, amount = ?, fees_comm = ?,
                acctg_rule_cd = ?, normalized_category = ?, normalized_type = ?, normalized_subtype = ?,
                status = ?, economic_fingerprint = ?, duplicate_of_transaction_id = ?,
                asset_match_review_id = ?, asset_alert_id = ?, raw_payload = ?, updated_at = datetime('now')
            WHERE id = ?
            """,
            (*params, existing["id"]),
        )
        return conn.execute("SELECT * FROM schwab_transactions WHERE id = ?", (existing["id"],)).fetchone(), False

    cur = conn.execute(
        """
        INSERT INTO schwab_transactions (
            import_id, portfolio_id, source_row, account_key, asset_id, ledger_event_id,
            source_action, source_description, source_symbol, source_date_raw,
            event_date, effective_date, quantity, price, amount, fees_comm, acctg_rule_cd,
            normalized_category, normalized_type, normalized_subtype, status, economic_fingerprint,
            duplicate_of_transaction_id, asset_match_review_id, asset_alert_id, raw_payload
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (values["import_id"], values["portfolio_id"], values["source_row"], *params[1:]),
    )
    return conn.execute("SELECT * FROM schwab_transactions WHERE id = ?", (cur.lastrowid,)).fetchone(), True


def _operation_payload(row: dict, portfolio_id: int, asset_class: str) -> dict:
    return {
        "source": SOURCE,
        "source_format": SOURCE_FORMAT,
        "source_row": row["source_row"],
        "source_action": row["source_action"],
        "source_description": row["source_description"],
        "ticker": row.get("ticker"),
        "asset_class": asset_class,
        "market": "US",
        "event_date": row["event_date"],
        "quantity": row.get("quantity"),
        "price": row.get("price"),
        "amount": row.get("amount"),
        "fees_comm": row.get("fees_comm"),
        "portfolio_id": portfolio_id,
    }


def _resolve_asset(conn: sqlite3.Connection, row: dict, portfolio_id: int, *, create_missing: bool) -> tuple[int | None, int | None, list[str]]:
    ticker = row.get("ticker")
    if not ticker:
        return None, None, []
    asset_class = _infer_asset_class(ticker, row.get("source_description"))
    payload = _operation_payload(row, portfolio_id, asset_class)
    match = asset_service.match_asset(
        conn,
        ticker=ticker,
        asset_class=asset_class,
        event_date=row["event_date"],
        market="US",
        source="schwab_import",
        create_review=True,
        operation_payload=payload,
    )
    if match["status"] == "exact":
        return match["asset"]["id"], None, []
    if match["status"] == "none" and create_missing:
        asset = asset_service.create_asset(
            conn,
            asset_class=asset_class,
            ticker=ticker,
            market="US",
            name=row.get("source_description"),
            event_date=row["event_date"],
            source="schwab_import",
        )
        return asset["id"], None, []
    review = match.get("review")
    return None, review["id"] if review else None, [f"{ticker} enviado para revisao de ativo"]


def _ledger_values(row: dict) -> tuple[str, str | None, str | None]:
    action = row.get("source_action")
    amount = Decimal(row["amount"] or "0")
    fees = Decimal(row["fees_comm"] or "0")
    if action == "Buy":
        return str(abs(amount)), None, row["quantity"]
    if action == "Sell":
        gross = amount + abs(fees)
        return str(amount), str(gross), row["quantity"]
    if action == "Cash In Lieu":
        return str(abs(amount)), None, None
    raise ValueError(f"Acao nao lancavel no ledger: {action}")


def _create_ledger_event(conn: sqlite3.Connection, portfolio_id: int, asset_id: int, row: dict) -> int:
    event_type = {
        "Buy": EventType.COMPRA.value,
        "Sell": EventType.VENDA.value,
        "Cash In Lieu": EventType.VENDA_FRACAO.value,
    }[row["source_action"]]
    value, gross_value, quantity = _ledger_values(row)
    event = event_service.create_event(
        conn,
        portfolio_id=portfolio_id,
        asset_id=asset_id,
        event_type=event_type,
        event_date=row["event_date"],
        quantity=quantity,
        event_value=value,
        gross_value=gross_value,
        notes=f"Importado da Schwab/TDA JSON: {row['source_action']} - {row.get('source_description') or ''}".strip(),
    )
    return event["id"]


def _create_spin_off_alert(conn: sqlite3.Connection, portfolio_id: int, import_id: int, transaction_id: int, row: dict, asset_id: int | None) -> int:
    existing = conn.execute(
        """
        SELECT id FROM schwab_asset_alerts
        WHERE portfolio_id = ? AND import_id = ? AND transaction_id = ? AND alert_type = 'spin_off'
        """,
        (portfolio_id, import_id, transaction_id),
    ).fetchone()
    payload = {
        "source": SOURCE,
        "source_format": SOURCE_FORMAT,
        "source_row": row["source_row"],
        "source_action": row["source_action"],
        "source_description": row["source_description"],
        "source_payload": row["raw_payload"],
    }
    if existing:
        conn.execute(
            """
            UPDATE schwab_asset_alerts
            SET asset_id = ?, ticker = ?, event_date = ?, source_action = ?, source_description = ?,
                quantity = ?, raw_payload = ?, resolved_at = CASE WHEN status = 'resolved' THEN resolved_at ELSE NULL END
            WHERE id = ?
            """,
            (asset_id, row.get("ticker"), row["event_date"], row["source_action"], row.get("source_description"), row.get("quantity"), _json_dumps(payload), existing["id"]),
        )
        return existing["id"]
    cur = conn.execute(
        """
        INSERT INTO schwab_asset_alerts (
            portfolio_id, import_id, transaction_id, asset_id, ticker, alert_type,
            event_date, source_action, source_description, quantity, raw_payload
        )
        VALUES (?, ?, ?, ?, ?, 'spin_off', ?, ?, ?, ?, ?)
        """,
        (portfolio_id, import_id, transaction_id, asset_id, row.get("ticker"), row["event_date"], row["source_action"], row.get("source_description"), row.get("quantity"), _json_dumps(payload)),
    )
    return cur.lastrowid


def import_schwab_json_file(conn: sqlite3.Connection, portfolio_id: int, source: SourceFile) -> dict:
    parsed = parse_schwab_json(source)
    import_id = _upsert_import(conn, portfolio_id, parsed)
    result = {
        "filename": parsed["filename"],
        "from_date": parsed["from_date"],
        "to_date": parsed["to_date"],
        "total_rows": len(parsed["rows"]),
        "imported_ledger_events": 0,
        "imported_foreign_events": 0,
        "ignored": 0,
        "duplicates": 0,
        "review_count": 0,
        "warning_count": 0,
        "duplicate_details": [],
        "review_details": [],
        "warnings": [],
        "errors": [],
    }

    for row in sorted(parsed["rows"], key=lambda item: (item["event_date"], item["source_row"])):
        values = {
            **row,
            "import_id": import_id,
            "portfolio_id": portfolio_id,
            "asset_id": None,
            "ledger_event_id": None,
            "status": "imported",
            "duplicate_of_transaction_id": None,
            "asset_match_review_id": None,
            "asset_alert_id": None,
        }
        try:
            existing = _existing_transaction(conn, import_id, row["source_row"])
            if existing and existing["ledger_event_id"]:
                values["asset_id"] = existing["asset_id"]
                values["ledger_event_id"] = existing["ledger_event_id"]
                values["status"] = existing["status"]
                _upsert_transaction(conn, values)
                result["duplicates"] += 1
                result["duplicate_details"].append(f"Linha {row['source_row']}: ja processada neste arquivo")
                continue

            duplicate = _find_prior_duplicate(conn, portfolio_id, parsed["account_key"], row["economic_fingerprint"], import_id)
            if duplicate:
                values["asset_id"] = duplicate["asset_id"]
                values["duplicate_of_transaction_id"] = duplicate["id"]
                values["status"] = "duplicate"
                _upsert_transaction(conn, values)
                result["duplicates"] += 1
                result["duplicate_details"].append(f"Linha {row['source_row']}: duplicidade economica de transacao Schwab/TDA #{duplicate['id']}")
                continue

            category = row["normalized_category"]
            if category == "ledger":
                asset_id, match_review_id, reviews = _resolve_asset(conn, row, portfolio_id, create_missing=True)
                values["asset_id"] = asset_id
                values["asset_match_review_id"] = match_review_id
                if not asset_id:
                    values["status"] = "review"
                    _upsert_transaction(conn, values)
                    result["review_count"] += 1
                    result["review_details"].extend(reviews or [f"Linha {row['source_row']}: ativo nao resolvido"])
                    continue
                values["ledger_event_id"] = _create_ledger_event(conn, portfolio_id, asset_id, row)
                values["status"] = "ledger_event_created"
                _upsert_transaction(conn, values)
                result["imported_ledger_events"] += 1
            elif category in {"dividend", "foreign_tax"}:
                asset_id, match_review_id, reviews = _resolve_asset(conn, row, portfolio_id, create_missing=True)
                values["asset_id"] = asset_id
                values["asset_match_review_id"] = match_review_id
                values["status"] = "review" if not asset_id and row.get("ticker") else "imported"
                _upsert_transaction(conn, values)
                if values["status"] == "review":
                    result["review_count"] += 1
                    result["review_details"].extend(reviews or [f"Linha {row['source_row']}: ativo nao resolvido"])
                else:
                    result["imported_foreign_events"] += 1
            elif category == "interest":
                values["status"] = "imported"
                _upsert_transaction(conn, values)
                result["imported_foreign_events"] += 1
            elif category == "cash_transfer":
                values["status"] = "cash_preserved"
                _upsert_transaction(conn, values)
                result["imported_foreign_events"] += 1
            elif category == "asset_alert":
                asset_id, _match_review_id, _reviews = _resolve_asset(conn, row, portfolio_id, create_missing=False)
                values["asset_id"] = asset_id
                values["status"] = "review"
                tx, _inserted = _upsert_transaction(conn, values)
                alert_id = _create_spin_off_alert(conn, portfolio_id, import_id, tx["id"], row, asset_id)
                values["asset_alert_id"] = alert_id
                _upsert_transaction(conn, values)
                result["review_count"] += 1
                result["review_details"].append(f"Linha {row['source_row']}: Spin-off {row.get('ticker') or ''} enviado para Gestao de Ativos")
            elif category == "ignored":
                values["status"] = "ignored"
                _upsert_transaction(conn, values)
                result["ignored"] += 1
                result["warning_count"] += 1
                result["warnings"].append(f"Linha {row['source_row']}: transferencia/evento tecnico ignorado no ledger")
            else:
                values["status"] = "review"
                _upsert_transaction(conn, values)
                result["review_count"] += 1
                result["review_details"].append(f"Linha {row['source_row']}: acao Schwab/TDA nao classificada: {row.get('source_action')}")
        except Exception as exc:
            values["status"] = "error"
            _upsert_transaction(conn, values)
            result["errors"].append(f"Linha {row['source_row']}: {exc}")

    conn.execute(
        """
        UPDATE schwab_imports
        SET total_rows = ?, imported_ledger_events = ?, imported_foreign_events = ?, ignored = ?,
            duplicates = ?, review_count = ?, warning_count = ?, errors = ?,
            status = ?, updated_at = datetime('now')
        WHERE id = ?
        """,
        (
            result["total_rows"],
            result["imported_ledger_events"],
            result["imported_foreign_events"],
            result["ignored"],
            result["duplicates"],
            result["review_count"],
            result["warning_count"],
            _json_dumps(result["errors"]) if result["errors"] else None,
            "processed_with_errors" if result["errors"] else "processed",
            import_id,
        ),
    )
    return result


def import_schwab_json_batch(conn: sqlite3.Connection, portfolio_id: int, files: list[SourceFile]) -> dict:
    response = {
        "portfolio_id": portfolio_id,
        "files_processed": 0,
        "total_rows": 0,
        "imported_ledger_events": 0,
        "imported_foreign_events": 0,
        "ignored": 0,
        "duplicates": 0,
        "review_count": 0,
        "warning_count": 0,
        "errors": [],
        "files": [],
    }
    for source in files:
        try:
            file_result = import_schwab_json_file(conn, portfolio_id, source)
        except Exception as exc:
            file_result = {
                "filename": source.filename,
                "from_date": None,
                "to_date": None,
                "total_rows": 0,
                "imported_ledger_events": 0,
                "imported_foreign_events": 0,
                "ignored": 0,
                "duplicates": 0,
                "review_count": 0,
                "warning_count": 0,
                "duplicate_details": [],
                "review_details": [],
                "warnings": [],
                "errors": [str(exc)],
            }
        response["files_processed"] += 1
        response["files"].append(file_result)
        for key in ("total_rows", "imported_ledger_events", "imported_foreign_events", "ignored", "duplicates", "review_count", "warning_count"):
            response[key] += file_result[key]
        response["errors"].extend(f"{file_result['filename']}: {err}" for err in file_result.get("errors", []))
    return response


def list_asset_alerts(conn: sqlite3.Connection, portfolio_id: int | None = None, status: str = "pending") -> list[dict]:
    conditions = ["status = ?"]
    params: list[Any] = [status]
    if portfolio_id is not None:
        conditions.append("portfolio_id = ?")
        params.append(portfolio_id)
    rows = conn.execute(
        f"""
        SELECT * FROM schwab_asset_alerts
        WHERE {' AND '.join(conditions)}
        ORDER BY event_date DESC, id DESC
        """,
        params,
    ).fetchall()
    return [dict(row) for row in rows]


def resolve_asset_alert(conn: sqlite3.Connection, alert_id: int) -> dict | None:
    conn.execute(
        "UPDATE schwab_asset_alerts SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?",
        (alert_id,),
    )
    row = conn.execute("SELECT * FROM schwab_asset_alerts WHERE id = ?", (alert_id,)).fetchone()
    return dict(row) if row else None
