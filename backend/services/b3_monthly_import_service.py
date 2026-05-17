"""B3 monthly XLSX importer.

The B3 spreadsheet is an external source. Market values and incomes are
persisted separately from the ledger; only B3 amortization income may create a
ledger event automatically when the asset/date/type key is not already present.
"""

from __future__ import annotations

import calendar
import json
import re
import sqlite3
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from io import BytesIO
from pathlib import Path
from typing import Iterable

import openpyxl

from backend.domain.engine import to_decimal
from backend.domain.enums import AssetClass, EventType
from backend.services import asset_service, event_service


_FILENAME_RE = re.compile(r"^(?P<year>\d{4})-(?P<month>\d{2})\.xlsx$", re.IGNORECASE)
_TICKER_PREFIX_RE = re.compile(r"^\s*([A-Z]{4}\d{1,2}[A-Z]?)\s+-\s+(.+)$")
_FIXED_INCOME_CLASSES = {
    "DEB": AssetClass.DEBENTURE,
    "CRI": AssetClass.CRI,
    "CRA": AssetClass.CRA,
}


@dataclass
class SourceFile:
    filename: str
    content: bytes


def _norm_text(value) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    text = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in text if not unicodedata.combining(ch)).upper()


def _header_key(value) -> str:
    return re.sub(r"[^A-Z0-9]+", " ", _norm_text(value)).strip()


def _clean_str(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text if text and text != "-" else None


def _digits(value) -> str | None:
    text = _clean_str(value)
    if not text:
        return None
    digits = re.sub(r"\D", "", text)
    return digits or None


def _decimal_str(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, str) and value.strip() in {"", "-"}:
        return None
    return str(to_decimal(value))


def _json_dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _date_str(value) -> str | None:
    if value is None or value == "-":
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value).strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def _month_from_filename(filename: str) -> tuple[str, str]:
    name = Path(filename).name
    match = _FILENAME_RE.match(name)
    if not match:
        raise ValueError(f"Arquivo B3 deve seguir o formato YYYY-MM.xlsx: {filename}")
    year = int(match.group("year"))
    month = int(match.group("month"))
    if month < 1 or month > 12:
        raise ValueError(f"Mes invalido no arquivo B3: {filename}")
    last_day = calendar.monthrange(year, month)[1]
    reference_month = f"{year:04d}-{month:02d}"
    reference_date = f"{reference_month}-{last_day:02d}"
    return reference_month, reference_date


def _worksheet_by_title(wb, wanted: str):
    wanted_key = _header_key(wanted)
    for name in wb.sheetnames:
        if _header_key(name) == wanted_key:
            return wb[name]
    return None


def _row_dicts(ws) -> Iterable[tuple[int, dict[str, object]]]:
    header_row = next(ws.iter_rows(min_row=1, max_row=1, values_only=True), None)
    if not header_row:
        return
    headers = [_header_key(cell) for cell in header_row]
    for row_idx, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        data = {headers[i]: row[i] if i < len(row) else None for i in range(len(headers)) if headers[i]}
        if any(value not in (None, "") for value in data.values()):
            yield row_idx, data


def _extract_ticker_product(product: str | None) -> tuple[str | None, str | None]:
    if not product:
        return None, None
    match = _TICKER_PREFIX_RE.match(product.strip())
    if match:
        return match.group(1).upper(), match.group(2).strip()
    return None, product.strip()


def _get_current_ticker(conn: sqlite3.Connection, asset_id: int) -> str | None:
    row = conn.execute(
        """
        SELECT ticker FROM asset_tickers
        WHERE asset_id = ? AND valid_until IS NULL
        ORDER BY valid_from DESC NULLS FIRST, id DESC LIMIT 1
        """,
        (asset_id,),
    ).fetchone()
    return row["ticker"] if row else None


def _single_asset(rows: list[sqlite3.Row]) -> dict | None:
    ids = []
    seen = set()
    for row in rows:
        asset_id = row["id"]
        if asset_id not in seen:
            ids.append(asset_id)
            seen.add(asset_id)
    return {"id": ids[0]} if len(ids) == 1 else None


def _find_by_ticker(conn: sqlite3.Connection, ticker: str | None, event_date: str | None) -> tuple[int | None, list[int]]:
    if not ticker:
        return None, []
    date_clause = ""
    params: list[object] = [ticker.upper()]
    if event_date:
        date_clause = "AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_until IS NULL OR t.valid_until > ?)"
        params.extend([event_date, event_date])
    rows = conn.execute(
        f"""
        SELECT DISTINCT a.id
        FROM asset_tickers t
        JOIN assets a ON a.id = t.asset_id
        WHERE UPPER(t.ticker) = ?
          AND a.merged_into_asset_id IS NULL
          {date_clause}
        ORDER BY a.id
        """,
        params,
    ).fetchall()
    asset = _single_asset(rows)
    return (asset["id"], []) if asset else (None, [row["id"] for row in rows])


def _find_by_cnpj(conn: sqlite3.Connection, cnpj: str | None) -> tuple[int | None, list[int]]:
    if not cnpj:
        return None, []
    rows = conn.execute(
        """
        SELECT id FROM assets
        WHERE REPLACE(REPLACE(REPLACE(COALESCE(cnpj, ''), '.', ''), '/', ''), '-', '') = ?
          AND merged_into_asset_id IS NULL
        ORDER BY id
        """,
        (cnpj,),
    ).fetchall()
    asset = _single_asset(rows)
    return (asset["id"], []) if asset else (None, [row["id"] for row in rows])


def _find_by_name(conn: sqlite3.Connection, name: str | None, asset_class: str | None = None) -> tuple[int | None, list[int]]:
    if not name:
        return None, []
    normalized = _norm_text(name)
    rows = conn.execute(
        """
        SELECT a.*, t.name AS ticker_name
        FROM assets a
        LEFT JOIN asset_tickers t ON t.asset_id = a.id AND t.valid_until IS NULL
        WHERE a.merged_into_asset_id IS NULL
        ORDER BY a.id
        """
    ).fetchall()
    matches = []
    for row in rows:
        if asset_class and row["asset_class"] != asset_class:
            continue
        candidates = [row["name"], row["ticker_name"]]
        if any(candidate and (_norm_text(candidate) == normalized or normalized in _norm_text(candidate) or _norm_text(candidate) in normalized) for candidate in candidates):
            matches.append(row)
    asset = _single_asset(matches)
    return (asset["id"], []) if asset else (None, [row["id"] for row in matches])


def _find_tesouro(conn: sqlite3.Connection, product: str | None, maturity_date: str | None) -> tuple[int | None, list[int]]:
    asset_id, candidates = _find_by_name(conn, product, AssetClass.TESOURO_DIRETO.value)
    if asset_id or candidates:
        return asset_id, candidates
    if not maturity_date:
        return None, []
    rows = conn.execute(
        """
        SELECT id FROM assets
        WHERE asset_class = ? AND maturity_date = ? AND merged_into_asset_id IS NULL
        ORDER BY id
        """,
        (AssetClass.TESOURO_DIRETO.value, maturity_date),
    ).fetchall()
    asset = _single_asset(rows)
    return (asset["id"], []) if asset else (None, [row["id"] for row in rows])


def _create_review(
    conn: sqlite3.Connection,
    ticker: str | None,
    asset_class: str,
    event_date: str | None,
    candidates: list[int],
    reason: str,
    payload: dict,
) -> int:
    review = asset_service.create_match_review(
        conn,
        source="b3_monthly_import",
        ticker=ticker or payload.get("product") or "B3",
        asset_class=asset_class,
        market="BR",
        event_date=event_date,
        candidate_asset_ids=candidates,
        reason=reason,
        operation_payload=payload,
    )
    return review["id"]


def _resolve_asset(
    conn: sqlite3.Connection,
    *,
    ticker: str | None,
    product: str | None,
    cnpj: str | None,
    maturity_date: str | None,
    asset_class: AssetClass,
    event_date: str | None,
) -> tuple[int | None, list[int], str | None]:
    asset_id, candidates = _find_by_ticker(conn, ticker, event_date)
    if asset_id or candidates:
        return asset_id, candidates, "ticker"
    asset_id, candidates = _find_by_cnpj(conn, cnpj)
    if asset_id or candidates:
        return asset_id, candidates, "cnpj"
    if asset_class == AssetClass.TESOURO_DIRETO:
        asset_id, candidates = _find_tesouro(conn, product, maturity_date)
        return asset_id, candidates, "tesouro"
    asset_id, candidates = _find_by_name(conn, product, asset_class.value)
    return asset_id, candidates, "name"


def _upsert_import(conn: sqlite3.Connection, portfolio_id: int, filename: str, reference_month: str, reference_date: str) -> int:
    conn.execute(
        """
        INSERT INTO b3_monthly_imports (portfolio_id, filename, reference_month, reference_date)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(portfolio_id, filename) DO UPDATE SET
            reference_month = excluded.reference_month,
            reference_date = excluded.reference_date,
            status = 'processed',
            total_rows = 0,
            imported_prices = 0,
            imported_incomes = 0,
            auto_events_created = 0,
            duplicates = 0,
            review_count = 0,
            errors = NULL,
            updated_at = datetime('now')
        """,
        (portfolio_id, filename, reference_month, reference_date),
    )
    row = conn.execute(
        "SELECT id FROM b3_monthly_imports WHERE portfolio_id = ? AND filename = ?",
        (portfolio_id, filename),
    ).fetchone()
    return row["id"]


def _upsert_market_price(conn: sqlite3.Connection, values: dict) -> str:
    existing = conn.execute(
        """
        SELECT * FROM b3_market_prices
        WHERE import_id = ? AND source_sheet = ? AND source_row = ?
        """,
        (values["import_id"], values["source_sheet"], values["source_row"]),
    ).fetchone()
    if existing:
        if not values["is_unit_price"]:
            try:
                existing_payload = json.loads(existing["raw_payload"] or "{}")
            except json.JSONDecodeError:
                existing_payload = {}
            if len(existing_payload.get("consolidated_source_rows") or []) > 1:
                return "updated"
        conn.execute(
            """
            UPDATE b3_market_prices
            SET asset_id = ?,
                reference_month = ?,
                reference_date = ?,
                ticker = ?,
                product = ?,
                cnpj = ?,
                maturity_date = ?,
                value = ?,
                is_unit_price = ?,
                status = ?,
                review_id = ?,
                raw_payload = ?,
                updated_at = datetime('now')
            WHERE id = ?
            """,
            (
                values["asset_id"],
                values["reference_month"],
                values["reference_date"],
                values.get("ticker"),
                values.get("product"),
                values.get("cnpj"),
                values.get("maturity_date"),
                values.get("value"),
                1 if values["is_unit_price"] else 0,
                values["status"],
                values.get("review_id"),
                _json_dumps(values["raw_payload"]),
                existing["id"],
            ),
        )
        return "updated"

    if not values["is_unit_price"] and values.get("asset_id") is not None:
        asset_existing = conn.execute(
            """
            SELECT * FROM b3_market_prices
            WHERE asset_id = ?
              AND reference_month = ?
              AND source_sheet = ?
            ORDER BY id
            LIMIT 1
            """,
            (values["asset_id"], values["reference_month"], values["source_sheet"]),
        ).fetchone()
        if asset_existing:
            try:
                existing_payload = json.loads(asset_existing["raw_payload"] or "{}")
            except json.JSONDecodeError:
                existing_payload = {}
            source_rows = existing_payload.get("consolidated_source_rows") or [asset_existing["source_row"]]
            if values["source_row"] in source_rows:
                return "updated"
            current_value = to_decimal(asset_existing["value"]) if asset_existing["value"] is not None else Decimal("0")
            added_value = to_decimal(values["value"]) if values.get("value") is not None else Decimal("0")
            source_rows.append(values["source_row"])
            conn.execute(
                """
                UPDATE b3_market_prices
                SET value = ?,
                    ticker = ?,
                    product = ?,
                    cnpj = ?,
                    maturity_date = ?,
                    status = ?,
                    review_id = ?,
                    raw_payload = ?,
                    updated_at = datetime('now')
                WHERE id = ?
                """,
                (
                    str(current_value + added_value),
                    values.get("ticker"),
                    values.get("product"),
                    values.get("cnpj"),
                    values.get("maturity_date"),
                    values["status"],
                    values.get("review_id"),
                    _json_dumps(
                        {
                            "consolidated_source_rows": source_rows,
                            "latest_row": values["raw_payload"],
                        }
                    ),
                    asset_existing["id"],
                ),
            )
            return "consolidated"

    conn.execute(
        """
        INSERT INTO b3_market_prices (
            import_id, asset_id, reference_month, reference_date, source_sheet,
            source_row, ticker, product, cnpj, maturity_date, value,
            is_unit_price, status, review_id, raw_payload
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            values["import_id"],
            values["asset_id"],
            values["reference_month"],
            values["reference_date"],
            values["source_sheet"],
            values["source_row"],
            values.get("ticker"),
            values.get("product"),
            values.get("cnpj"),
            values.get("maturity_date"),
            values.get("value"),
            1 if values["is_unit_price"] else 0,
            values["status"],
            values.get("review_id"),
            _json_dumps(values["raw_payload"]),
        ),
    )
    return "inserted"


def _upsert_income(conn: sqlite3.Connection, values: dict) -> bool:
    existing = conn.execute(
        """
        SELECT id FROM b3_income_events
        WHERE import_id = ? AND source_row = ?
        """,
        (values["import_id"], values["source_row"]),
    ).fetchone()
    if existing:
        conn.execute(
            """
            UPDATE b3_income_events
            SET asset_id = ?,
                payment_date = ?,
                event_type = ?,
                product = ?,
                ticker = ?,
                quantity = ?,
                unit_price = ?,
                net_value = ?,
                status = ?,
                ledger_event_id = COALESCE(ledger_event_id, ?),
                review_id = ?,
                raw_payload = ?,
                updated_at = datetime('now')
            WHERE id = ?
            """,
            (
                values["asset_id"],
                values["payment_date"],
                values["event_type"],
                values["product"],
                values.get("ticker"),
                values.get("quantity"),
                values.get("unit_price"),
                values.get("net_value"),
                values["status"],
                values.get("ledger_event_id"),
                values.get("review_id"),
                _json_dumps(values["raw_payload"]),
                existing["id"],
            ),
        )
        return False
    conn.execute(
        """
        INSERT INTO b3_income_events (
            import_id, portfolio_id, asset_id, source_row, payment_date, event_type,
            product, ticker, quantity, unit_price, net_value, status,
            ledger_event_id, review_id, raw_payload
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            values["import_id"],
            values["portfolio_id"],
            values["asset_id"],
            values["source_row"],
            values["payment_date"],
            values["event_type"],
            values["product"],
            values.get("ticker"),
            values.get("quantity"),
            values.get("unit_price"),
            values.get("net_value"),
            values["status"],
            values.get("ledger_event_id"),
            values.get("review_id"),
            _json_dumps(values["raw_payload"]),
        ),
    )
    return True


def _ledger_amortization_exists(conn: sqlite3.Connection, portfolio_id: int, asset_id: int, payment_date: str) -> bool:
    row = conn.execute(
        """
        SELECT 1 FROM events
        WHERE portfolio_id = ?
          AND asset_id = ?
          AND event_type = ?
          AND event_date = ?
          AND is_cancelled = 0
          AND is_storno = 0
        LIMIT 1
        """,
        (portfolio_id, asset_id, EventType.AMORTIZACAO.value, payment_date),
    ).fetchone()
    return row is not None


def _is_amortization(label: str) -> bool:
    return _norm_text(label) == _norm_text(EventType.AMORTIZACAO.value)


def _auto_create_amortization(conn: sqlite3.Connection, portfolio_id: int, asset_id: int, payment_date: str, net_value: str) -> tuple[int | None, str | None]:
    if _ledger_amortization_exists(conn, portfolio_id, asset_id, payment_date):
        return None, "duplicate"
    event = event_service.create_event(
        conn,
        portfolio_id=portfolio_id,
        asset_id=asset_id,
        event_type=EventType.AMORTIZACAO.value,
        event_date=payment_date,
        quantity="0",
        event_value=net_value,
        notes="Importado automaticamente de Proventos Recebidos B3",
    )
    return event["id"], None


def _process_market_sheet(
    conn: sqlite3.Connection,
    ws,
    *,
    import_id: int,
    reference_month: str,
    reference_date: str,
    sheet_name: str,
    asset_class: AssetClass,
    value_header: str,
    is_unit_price: bool,
    product_header: str = "PRODUTO",
    ticker_header: str | None = None,
    cnpj_header: str | None = None,
    maturity_header: str | None = None,
    fixed_income_only: bool = False,
) -> dict:
    result = {"total_rows": 0, "imported_prices": 0, "duplicates": 0, "review_count": 0, "review_details": [], "errors": []}
    for row_idx, row in _row_dicts(ws):
        product = _clean_str(row.get(product_header))
        if _norm_text(product).startswith("TOTAL"):
            continue
        if fixed_income_only:
            prefix = _norm_text(product).split(" - ")[0].strip()
            if prefix not in _FIXED_INCOME_CLASSES:
                continue
            asset_class = _FIXED_INCOME_CLASSES[prefix]
        result["total_rows"] += 1
        ticker = _clean_str(row.get(ticker_header)) if ticker_header else None
        cnpj = _digits(row.get(cnpj_header)) if cnpj_header else None
        maturity_date = _date_str(row.get(maturity_header)) if maturity_header else None
        try:
            value = _decimal_str(row.get(value_header))
        except (TypeError, ValueError) as exc:
            result["errors"].append(f"{sheet_name} linha {row_idx}: valor de mercado invalido: {exc}")
            continue
        if value is None:
            result["errors"].append(f"{sheet_name} linha {row_idx}: valor de mercado ausente ou invalido")
            continue
        asset_id, candidates, _source = _resolve_asset(
            conn,
            ticker=ticker,
            product=product,
            cnpj=cnpj,
            maturity_date=maturity_date,
            asset_class=asset_class,
            event_date=reference_date,
        )
        review_id = None
        status = "imported"
        if not asset_id:
            payload = {
                "sheet": sheet_name,
                "source_row": row_idx,
                "ticker": ticker,
                "product": product,
                "cnpj": cnpj,
                "maturity_date": maturity_date,
                "reference_date": reference_date,
            }
            review_id = _create_review(conn, ticker, asset_class.value, reference_date, candidates, "Ativo B3 nao resolvido com seguranca.", payload)
            result["review_count"] += 1
            result["review_details"].append(f"{sheet_name} linha {row_idx}: {ticker or product} enviado para revisao")
            status = "review"
        upsert_status = _upsert_market_price(
            conn,
            {
                "import_id": import_id,
                "asset_id": asset_id,
                "reference_month": reference_month,
                "reference_date": reference_date,
                "source_sheet": sheet_name,
                "source_row": row_idx,
                "ticker": ticker,
                "product": product,
                "cnpj": cnpj,
                "maturity_date": maturity_date,
                "value": value,
                "is_unit_price": is_unit_price,
                "status": status,
                "review_id": review_id,
                "raw_payload": row,
            },
        )
        if upsert_status in {"inserted", "consolidated"}:
            result["imported_prices"] += 1
        else:
            result["duplicates"] += 1
    return result


def _infer_income_class(ticker: str | None, product: str | None) -> AssetClass:
    if not ticker and _norm_text(product).startswith("TESOURO "):
        return AssetClass.TESOURO_DIRETO
    if ticker and ticker.endswith("11"):
        return AssetClass.FII
    return AssetClass.ACAO


def _process_income_sheet(
    conn: sqlite3.Connection,
    ws,
    *,
    import_id: int,
    portfolio_id: int,
) -> dict:
    result = {"total_rows": 0, "imported_incomes": 0, "auto_events_created": 0, "duplicates": 0, "review_count": 0, "review_details": [], "errors": []}
    for row_idx, row in _row_dicts(ws):
        result["total_rows"] += 1
        product = _clean_str(row.get("PRODUTO"))
        if _norm_text(product).startswith("TOTAL"):
            continue
        ticker, extracted_name = _extract_ticker_product(product)
        payment_date = _date_str(row.get("PAGAMENTO"))
        event_type = _clean_str(row.get("TIPO DE EVENTO"))
        try:
            quantity = _decimal_str(row.get("QUANTIDADE"))
            unit_price = _decimal_str(row.get("PRECO UNITARIO"))
            net_value = _decimal_str(row.get("VALOR LIQUIDO"))
        except (TypeError, ValueError) as exc:
            result["errors"].append(f"Proventos Recebidos linha {row_idx}: valor invalido: {exc}")
            continue
        if not product or not payment_date or not event_type or net_value is None:
            result["errors"].append(f"Proventos Recebidos linha {row_idx}: campos obrigatorios ausentes")
            continue
        inferred_class = _infer_income_class(ticker, product)
        asset_id, candidates, _source = _resolve_asset(
            conn,
            ticker=ticker,
            product=extracted_name or product,
            cnpj=None,
            maturity_date=None,
            asset_class=inferred_class,
            event_date=payment_date,
        )
        review_id = None
        status = "imported"
        ledger_event_id = None
        if not asset_id:
            payload = {
                "sheet": "Proventos Recebidos",
                "source_row": row_idx,
                "ticker": ticker,
                "product": product,
                "payment_date": payment_date,
                "event_type": event_type,
                "quantity": quantity,
                "unit_price": unit_price,
                "net_value": net_value,
            }
            review_id = _create_review(conn, ticker, inferred_class.value, payment_date, candidates, "Provento B3 nao resolvido com seguranca.", payload)
            result["review_count"] += 1
            result["review_details"].append(f"Proventos Recebidos linha {row_idx}: {ticker or product} enviado para revisao")
            status = "review"
        elif _is_amortization(event_type):
            try:
                ledger_event_id, duplicate_reason = _auto_create_amortization(conn, portfolio_id, asset_id, payment_date, net_value)
                if ledger_event_id:
                    result["auto_events_created"] += 1
                    status = "ledger_event_created"
                elif duplicate_reason == "duplicate":
                    result["duplicates"] += 1
                    status = "ledger_duplicate"
            except Exception as exc:
                status = "ledger_error"
                result["errors"].append(f"Proventos Recebidos linha {row_idx}: amortizacao nao lancada no ledger: {exc}")
        inserted = _upsert_income(
            conn,
            {
                "import_id": import_id,
                "portfolio_id": portfolio_id,
                "asset_id": asset_id,
                "source_row": row_idx,
                "payment_date": payment_date,
                "event_type": event_type,
                "product": product,
                "ticker": ticker,
                "quantity": quantity,
                "unit_price": unit_price,
                "net_value": net_value,
                "status": status,
                "ledger_event_id": ledger_event_id,
                "review_id": review_id,
                "raw_payload": row,
            },
        )
        if inserted:
            result["imported_incomes"] += 1
        else:
            result["duplicates"] += 1
    return result


def _merge_counts(target: dict, source: dict) -> None:
    for key in ("total_rows", "imported_prices", "imported_incomes", "auto_events_created", "duplicates", "review_count"):
        target[key] = target.get(key, 0) + source.get(key, 0)
    target.setdefault("errors", []).extend(source.get("errors", []))
    target.setdefault("review_details", []).extend(source.get("review_details", []))


def import_b3_monthly_file(conn: sqlite3.Connection, portfolio_id: int, source: SourceFile) -> dict:
    reference_month, reference_date = _month_from_filename(source.filename)
    import_id = _upsert_import(conn, portfolio_id, source.filename, reference_month, reference_date)
    # Some B3 workbooks report a stale read-only dimension (A1:A1). Loading
    # normally lets openpyxl discover the real used range.
    workbook = openpyxl.load_workbook(BytesIO(source.content), read_only=False, data_only=True)
    result = {
        "filename": source.filename,
        "reference_month": reference_month,
        "reference_date": reference_date,
        "total_rows": 0,
        "imported_prices": 0,
        "imported_incomes": 0,
        "auto_events_created": 0,
        "duplicates": 0,
        "review_count": 0,
        "review_details": [],
        "errors": [],
    }

    sheet_specs = [
        ("Posição - Ações", AssetClass.ACAO, "PRECO DE FECHAMENTO", True, "CODIGO DE NEGOCIACAO", "CNPJ DA EMPRESA", None, False),
        ("Posição - Fundos", AssetClass.FII, "PRECO DE FECHAMENTO", True, "CODIGO DE NEGOCIACAO", "CNPJ DO FUNDO", None, False),
        ("Posição - Renda Fixa", AssetClass.DEBENTURE, "VALOR ATUALIZADO MTM", False, "CODIGO", None, "VENCIMENTO", True),
        ("Posição - Tesouro Direto", AssetClass.TESOURO_DIRETO, "VALOR ATUALIZADO", False, None, None, "VENCIMENTO", False),
    ]
    for sheet_name, asset_class, value_header, is_unit, ticker_header, cnpj_header, maturity_header, fixed_only in sheet_specs:
        ws = _worksheet_by_title(workbook, sheet_name)
        if ws is None:
            result["errors"].append(f"Aba ausente: {sheet_name}")
            continue
        partial = _process_market_sheet(
            conn,
            ws,
            import_id=import_id,
            reference_month=reference_month,
            reference_date=reference_date,
            sheet_name=sheet_name,
            asset_class=asset_class,
            value_header=value_header,
            is_unit_price=is_unit,
            ticker_header=ticker_header,
            cnpj_header=cnpj_header,
            maturity_header=maturity_header,
            fixed_income_only=fixed_only,
        )
        _merge_counts(result, partial)

    ws = _worksheet_by_title(workbook, "Proventos Recebidos")
    if ws is None:
        result["errors"].append("Aba ausente: Proventos Recebidos")
    else:
        _merge_counts(result, _process_income_sheet(conn, ws, import_id=import_id, portfolio_id=portfolio_id))

    conn.execute(
        """
        UPDATE b3_monthly_imports
        SET total_rows = ?,
            imported_prices = ?,
            imported_incomes = ?,
            auto_events_created = ?,
            duplicates = ?,
            review_count = ?,
            errors = ?,
            status = ?,
            updated_at = datetime('now')
        WHERE id = ?
        """,
        (
            result["total_rows"],
            result["imported_prices"],
            result["imported_incomes"],
            result["auto_events_created"],
            result["duplicates"],
            result["review_count"],
            _json_dumps(result["errors"]) if result["errors"] else None,
            "processed_with_errors" if result["errors"] else "processed",
            import_id,
        ),
    )
    return result


def import_b3_monthly_batch(conn: sqlite3.Connection, portfolio_id: int, files: list[SourceFile]) -> dict:
    ordered = sorted(files, key=lambda item: _month_from_filename(item.filename)[0])
    response = {
        "portfolio_id": portfolio_id,
        "files_processed": 0,
        "total_rows": 0,
        "imported_prices": 0,
        "imported_incomes": 0,
        "auto_events_created": 0,
        "duplicates": 0,
        "review_count": 0,
        "errors": [],
        "files": [],
    }
    for source in ordered:
        try:
            file_result = import_b3_monthly_file(conn, portfolio_id, source)
        except Exception as exc:
            reference_month, reference_date = _month_from_filename(source.filename)
            file_result = {
                "filename": source.filename,
                "reference_month": reference_month,
                "reference_date": reference_date,
                "total_rows": 0,
                "imported_prices": 0,
                "imported_incomes": 0,
                "auto_events_created": 0,
                "duplicates": 0,
                "review_count": 0,
                "review_details": [],
                "errors": [str(exc)],
            }
        response["files_processed"] += 1
        response["files"].append(file_result)
        for key in ("total_rows", "imported_prices", "imported_incomes", "auto_events_created", "duplicates", "review_count"):
            response[key] += file_result[key]
        response["errors"].extend(f"{file_result['filename']}: {err}" for err in file_result.get("errors", []))
    return response
