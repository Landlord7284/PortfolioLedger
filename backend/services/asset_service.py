"""
Asset service - CRUD operations, central matching, ticker history and merging.

Each asset has an immutable internal id. Tickers are temporal identifiers, so
matching must resolve ticker + class + market to an existing id before creating
anything new.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Optional

from backend.domain.enums import AssetClass, Currency, Market, default_market_for_class, currency_for_market


def _normalize_ticker(ticker: str) -> str:
    return ticker.strip().upper()


def _resolve_market(asset_class: str, market: Optional[str], ticker: Optional[str] = None, source: str = "manual") -> str | None:
    forced = default_market_for_class(asset_class)
    if forced:
        return forced.value
    if market:
        return Market(market).value
    if AssetClass(asset_class) == AssetClass.ETF and source == "import_xlsx" and ticker:
        return Market.BR.value if _normalize_ticker(ticker).endswith("11") else None
    if AssetClass(asset_class) == AssetClass.ETF:
        return None
    return Market.BR.value


def _attach_ticker_and_metadata(conn: sqlite3.Connection, d: dict) -> dict:
    ticker_row = conn.execute(
        """
        SELECT ticker, name FROM asset_tickers
        WHERE asset_id = ? AND valid_until IS NULL
        ORDER BY valid_from DESC NULLS FIRST, id DESC LIMIT 1
        """,
        (d["id"],),
    ).fetchone()
    d["current_ticker"] = ticker_row["ticker"] if ticker_row else None
    d["current_name"] = ticker_row["name"] if ticker_row else None
    return d


def _ticker_date_clause(event_date: Optional[str]) -> tuple[str, list]:
    if not event_date:
        return "", []
    return "AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_until IS NULL OR t.valid_until > ?)", [event_date, event_date]


def _candidate_dicts(conn: sqlite3.Connection, rows: list[sqlite3.Row]) -> list[dict]:
    result: list[dict] = []
    seen: set[int] = set()
    for row in rows:
        asset_id = row["id"] if "id" in row.keys() else row["asset_id"]
        if asset_id in seen:
            continue
        seen.add(asset_id)
        asset = get_asset(conn, asset_id)
        if asset:
            result.append(asset)
    return result


def build_operation_payload(
    ticker: str,
    asset_class: str,
    market: Optional[str],
    event_date: Optional[str],
    portfolio_id: Optional[int] = None,
    event_type: Optional[str] = None,
    quantity: Optional[str] = None,
    event_value: Optional[str] = None,
    gross_value: Optional[str] = None,
    origin_usd: Optional[str] = None,
    notes: Optional[str] = None,
    source_row: Optional[int] = None,
) -> dict | None:
    if not any([portfolio_id, event_type, quantity, event_value, gross_value, origin_usd, notes, source_row]):
        return None
    payload = {
        "ticker": _normalize_ticker(ticker),
        "asset_class": AssetClass(asset_class).value,
        "market": market,
        "event_date": event_date,
        "portfolio_id": portfolio_id,
        "event_type": event_type,
        "quantity": quantity,
        "event_value": event_value,
        "gross_value": gross_value,
        "origin_usd": origin_usd,
        "notes": notes,
    }
    if source_row is not None:
        payload["source_row"] = source_row
    return payload


def create_match_review(
    conn: sqlite3.Connection,
    source: str,
    ticker: str,
    asset_class: str,
    market: Optional[str] = None,
    event_date: Optional[str] = None,
    candidate_asset_ids: Optional[list[int]] = None,
    reason: Optional[str] = None,
    operation_payload: Optional[dict] = None,
) -> dict:
    normalized = _normalize_ticker(ticker)
    ac = AssetClass(asset_class).value
    existing = conn.execute(
        """
        SELECT * FROM asset_match_reviews
        WHERE status = 'pending'
          AND source = ?
          AND ticker = ?
          AND asset_class = ?
          AND COALESCE(market, '') = COALESCE(?, '')
          AND COALESCE(event_date, '') = COALESCE(?, '')
        ORDER BY id DESC LIMIT 1
        """,
        (source, normalized, ac, market, event_date),
    ).fetchone()
    if existing:
        return dict(existing)

    cur = conn.execute(
        """
        INSERT INTO asset_match_reviews (source, ticker, asset_class, market, event_date,
                                         candidate_asset_ids, reason, operation_payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            source,
            normalized,
            ac,
            market,
            event_date,
            json.dumps(candidate_asset_ids or []),
            reason,
            json.dumps(operation_payload) if operation_payload else None,
        ),
    )
    return dict(conn.execute("SELECT * FROM asset_match_reviews WHERE id = ?", (cur.lastrowid,)).fetchone())


def match_asset(
    conn: sqlite3.Connection,
    ticker: str,
    asset_class: str,
    event_date: Optional[str] = None,
    market: Optional[str] = None,
    source: str = "manual",
    create_review: bool = False,
    operation_payload: Optional[dict] = None,
) -> dict:
    ac = AssetClass(asset_class).value
    normalized = _normalize_ticker(ticker)
    resolved_market = _resolve_market(ac, market, normalized, source)
    review_payload = {**operation_payload, "market": resolved_market} if operation_payload else None
    if resolved_market is None:
        reason = "Mercado do ETF não pôde ser inferido com segurança."
        review = create_match_review(conn, source, normalized, ac, None, event_date, [], reason, review_payload) if create_review else None
        return {"status": "probable", "asset": None, "candidates": [], "review": review, "reason": reason, "market": None}

    date_clause, date_params = _ticker_date_clause(event_date)
    exact_rows = conn.execute(
        f"""
        SELECT DISTINCT a.* FROM assets a
        JOIN asset_tickers t ON t.asset_id = a.id
        WHERE UPPER(t.ticker) = ?
          AND a.asset_class = ?
          AND a.market = ?
          AND a.merged_into_asset_id IS NULL
          {date_clause}
        ORDER BY a.id
        """,
        [normalized, ac, resolved_market, *date_params],
    ).fetchall()
    if len(exact_rows) == 1:
        return {"status": "exact", "asset": get_asset(conn, exact_rows[0]["id"]), "candidates": [], "review": None, "market": resolved_market}
    if len(exact_rows) > 1:
        candidates = _candidate_dicts(conn, exact_rows)
        reason = "Mais de um ativo ativo possui o mesmo ticker, classe e mercado no período."
        review = create_match_review(conn, source, normalized, ac, resolved_market, event_date, [c["id"] for c in candidates], reason, review_payload) if create_review else None
        return {"status": "probable", "asset": None, "candidates": candidates, "review": review, "reason": reason, "market": resolved_market}

    probable_rows = conn.execute(
        """
        SELECT DISTINCT a.* FROM assets a
        JOIN asset_tickers t ON t.asset_id = a.id
        WHERE UPPER(t.ticker) = ?
          AND a.merged_into_asset_id IS NULL
        ORDER BY a.asset_class, a.market, a.id
        """,
        (normalized,),
    ).fetchall()
    if probable_rows:
        candidates = _candidate_dicts(conn, probable_rows)
        reason = "Ticker já existe, mas classe, mercado ou período não permitem match exato."
        review = create_match_review(conn, source, normalized, ac, resolved_market, event_date, [c["id"] for c in candidates], reason, review_payload) if create_review else None
        return {"status": "probable", "asset": None, "candidates": candidates, "review": review, "reason": reason, "market": resolved_market}

    merged_row = conn.execute(
        """
        SELECT a.merged_into_asset_id FROM assets a
        JOIN asset_tickers t ON t.asset_id = a.id
        WHERE UPPER(t.ticker) = ? AND a.asset_class = ? AND a.market = ?
          AND a.merged_into_asset_id IS NOT NULL
        ORDER BY a.id LIMIT 1
        """,
        (normalized, ac, resolved_market),
    ).fetchone()
    if merged_row:
        target = get_asset(conn, merged_row["merged_into_asset_id"])
        if target:
            return {"status": "exact", "asset": target, "candidates": [], "review": None, "market": resolved_market}

    return {"status": "none", "asset": None, "candidates": [], "review": None, "market": resolved_market}


def create_asset(
    conn: sqlite3.Connection,
    asset_class: str,
    ticker: str,
    currency: Optional[str] = None,
    market: Optional[str] = None,
    name: Optional[str] = None,
    maturity_date: Optional[str] = None,
    aux_id: Optional[str] = None,
    valid_from: Optional[str] = None,
    cnpj: Optional[str] = None,
    isin: Optional[str] = None,
    sector: Optional[str] = None,
    subsector: Optional[str] = None,
    segment: Optional[str] = None,
    fiscal_regime_override: Optional[str] = None,
    fiscal_tax_treatment: Optional[str] = None,
    event_date: Optional[str] = None,
    portfolio_id: Optional[int] = None,
    event_type: Optional[str] = None,
    quantity: Optional[str] = None,
    event_value: Optional[str] = None,
    gross_value: Optional[str] = None,
    origin_usd: Optional[str] = None,
    notes: Optional[str] = None,
    source_row: Optional[int] = None,
    source: str = "manual",
    allow_existing: bool = True,
    allow_probable: bool = False,
) -> dict:
    ac = AssetClass(asset_class)
    if currency:
        Currency(currency)
    resolved_market = _resolve_market(ac.value, market, ticker, source)
    if resolved_market is None:
        operation_payload = build_operation_payload(
            ticker=ticker,
            asset_class=ac.value,
            market=None,
            event_date=event_date,
            portfolio_id=portfolio_id,
            event_type=event_type,
            quantity=quantity,
            event_value=event_value,
            gross_value=gross_value,
            origin_usd=origin_usd,
            notes=notes,
            source_row=source_row,
        )
        create_match_review(conn, source, ticker, ac.value, None, event_date, [], "Mercado do ETF deve ser confirmado.", operation_payload)
        raise ValueError("Mercado do ETF deve ser confirmado antes do cadastro.")
    resolved_currency = currency_for_market(resolved_market).value
    operation_payload = build_operation_payload(
        ticker=ticker,
        asset_class=ac.value,
        market=resolved_market,
        event_date=event_date,
        portfolio_id=portfolio_id,
        event_type=event_type,
        quantity=quantity,
        event_value=event_value,
        gross_value=gross_value,
        origin_usd=origin_usd,
        notes=notes,
        source_row=source_row,
    )

    match = match_asset(conn, ticker, ac.value, event_date, resolved_market, source, create_review=not allow_probable, operation_payload=operation_payload)
    if match["status"] == "exact" and allow_existing:
        return match["asset"]
    if match["status"] == "probable" and not allow_probable:
        raise ValueError("Ativo enviado para revisão por possível duplicidade.")

    cur = conn.execute(
        """
        INSERT INTO assets (asset_class, market, currency, maturity_date, aux_id,
                            name, cnpj, isin, sector, subsector, segment,
                            fiscal_regime_override, fiscal_tax_treatment)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (ac.value, resolved_market, resolved_currency, maturity_date, aux_id,
         name, cnpj, isin, sector, subsector, segment,
         fiscal_regime_override, fiscal_tax_treatment),
    )
    asset_id = cur.lastrowid
    conn.execute(
        """
        INSERT INTO asset_tickers (asset_id, ticker, name, valid_from)
        VALUES (?, ?, ?, ?)
        """,
        (asset_id, _normalize_ticker(ticker), name, valid_from),
    )
    return get_asset(conn, asset_id)


def create_asset_from_review(conn: sqlite3.Connection, review_id: int) -> dict:
    review = conn.execute(
        "SELECT * FROM asset_match_reviews WHERE id = ?",
        (review_id,),
    ).fetchone()
    if not review:
        raise ValueError("Revisão não encontrada.")
    if review["status"] != "pending":
        raise ValueError("Revisão já foi resolvida.")
    if not review["market"]:
        raise ValueError("Informe o mercado antes de criar este ativo.")

    asset = create_asset(
        conn,
        asset_class=review["asset_class"],
        ticker=review["ticker"],
        market=review["market"],
        event_date=review["event_date"],
        source="review",
        allow_existing=True,
        allow_probable=True,
    )
    conn.execute(
        "UPDATE asset_match_reviews SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?",
        (review_id,),
    )
    return asset


def get_asset(conn: sqlite3.Connection, asset_id: int) -> dict | None:
    row = conn.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
    if not row:
        return None
    return _attach_ticker_and_metadata(conn, dict(row))


def list_assets(conn: sqlite3.Connection, asset_class: Optional[str] = None, include_merged: bool = False) -> list[dict]:
    merged_clause = "" if include_merged else " AND merged_into_asset_id IS NULL"
    if asset_class:
        rows = conn.execute(f"SELECT * FROM assets WHERE asset_class = ?{merged_clause} ORDER BY id", (asset_class,)).fetchall()
    else:
        where = "" if include_merged else "WHERE merged_into_asset_id IS NULL"
        rows = conn.execute(f"SELECT * FROM assets {where} ORDER BY id").fetchall()
    return [_attach_ticker_and_metadata(conn, dict(r)) for r in rows]


def search_assets(conn: sqlite3.Connection, query: str) -> list[dict]:
    q = f"%{query.strip().upper()}%"
    ticker_ids = conn.execute(
        """
        SELECT DISTINCT asset_id FROM asset_tickers
        WHERE UPPER(ticker) LIKE ? OR UPPER(COALESCE(name, '')) LIKE ?
        """,
        (q, q),
    ).fetchall()
    ids = set(r["asset_id"] for r in ticker_ids)
    meta_ids = conn.execute(
        """
        SELECT id FROM assets
        WHERE UPPER(COALESCE(name, '')) LIKE ?
           OR UPPER(COALESCE(cnpj, '')) LIKE ?
           OR UPPER(COALESCE(isin, '')) LIKE ?
        """,
        (q, q, q),
    ).fetchall()
    ids.update(r["id"] for r in meta_ids)
    if not ids:
        return []
    ids_list = list(ids)
    placeholders = ",".join("?" * len(ids_list))
    rows = conn.execute(
        f"SELECT * FROM assets WHERE id IN ({placeholders}) AND merged_into_asset_id IS NULL",
        ids_list,
    ).fetchall()
    return [_attach_ticker_and_metadata(conn, dict(r)) for r in rows]


def update_asset_metadata(
    conn: sqlite3.Connection,
    asset_id: int,
    asset_class: Optional[str] = None,
    ticker: Optional[str] = None,
    name: Optional[str] = None,
    maturity_date: Optional[str] = None,
    cnpj: Optional[str] = None,
    isin: Optional[str] = None,
    sector: Optional[str] = None,
    subsector: Optional[str] = None,
    segment: Optional[str] = None,
    market: Optional[str] = None,
    fiscal_regime_override: Optional[str] = None,
    fiscal_tax_treatment: Optional[str] = None,
) -> dict | None:
    current = get_asset(conn, asset_id)
    if not current:
        return None

    next_class = AssetClass(asset_class).value if asset_class is not None else current["asset_class"]
    next_market = _resolve_market(next_class, market if market is not None else current["market"], ticker or current.get("current_ticker"), "manual")
    if next_market is None:
        raise ValueError("Mercado do ETF deve ser informado.")
    next_ticker = _normalize_ticker(ticker or current.get("current_ticker") or "")
    if next_ticker:
        conflict = match_asset(conn, next_ticker, next_class, None, next_market, "metadata_update")
        if conflict["status"] == "exact" and conflict["asset"]["id"] != asset_id:
            raise ValueError("Já existe ativo com este ticker, classe e mercado. Use mesclagem manual para preservar o id correto.")

    fields: list[str] = []
    values: list = []
    for col, val in [
        ("asset_class", next_class if asset_class is not None else None),
        ("name", name),
        ("maturity_date", maturity_date),
        ("cnpj", cnpj),
        ("isin", isin),
        ("sector", sector),
        ("subsector", subsector),
        ("segment", segment),
        ("fiscal_regime_override", fiscal_regime_override),
        ("fiscal_tax_treatment", fiscal_tax_treatment),
        ("market", next_market if market is not None or asset_class is not None else None),
        ("currency", currency_for_market(next_market).value if market is not None or asset_class is not None else None),
    ]:
        if val is not None:
            fields.append(f"{col} = ?")
            values.append(val)
    if fields:
        values.append(asset_id)
        conn.execute(f"UPDATE assets SET {', '.join(fields)} WHERE id = ?", values)
    if ticker is not None:
        conn.execute(
            """
            UPDATE asset_tickers
            SET ticker = ?
            WHERE asset_id = ? AND valid_until IS NULL
            """,
            (_normalize_ticker(ticker), asset_id),
        )
    return get_asset(conn, asset_id)


def update_ticker(conn: sqlite3.Connection, asset_id: int, new_ticker: str, valid_from: str, name: Optional[str] = None) -> dict:
    asset = get_asset(conn, asset_id)
    if not asset:
        raise ValueError("Ativo não encontrado.")
    normalized = _normalize_ticker(new_ticker)
    conflict = match_asset(conn, normalized, asset["asset_class"], valid_from, asset["market"], "ticker_change")
    if conflict["status"] == "exact" and conflict["asset"]["id"] != asset_id:
        raise ValueError("Ticker já pertence a outro ativo no período informado.")
    conn.execute(
        """
        UPDATE asset_tickers
        SET valid_until = ?
        WHERE asset_id = ? AND valid_until IS NULL
        """,
        (valid_from, asset_id),
    )
    conn.execute(
        """
        INSERT INTO asset_tickers (asset_id, ticker, name, valid_from)
        VALUES (?, ?, ?, ?)
        """,
        (asset_id, normalized, name, valid_from),
    )
    return get_asset(conn, asset_id)


def list_asset_tickers(conn: sqlite3.Connection, asset_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM asset_tickers WHERE asset_id = ? ORDER BY COALESCE(valid_from, ''), id",
        (asset_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def list_match_reviews(conn: sqlite3.Connection, status: str = "pending") -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM asset_match_reviews WHERE status = ? ORDER BY created_at DESC, id DESC",
        (status,),
    ).fetchall()
    return [dict(r) for r in rows]


def resolve_match_review(conn: sqlite3.Connection, review_id: int) -> dict | None:
    conn.execute(
        "UPDATE asset_match_reviews SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?",
        (review_id,),
    )
    row = conn.execute("SELECT * FROM asset_match_reviews WHERE id = ?", (review_id,)).fetchone()
    return dict(row) if row else None


def merge_assets(conn: sqlite3.Connection, source_asset_id: int, target_asset_id: int) -> dict:
    if source_asset_id == target_asset_id:
        raise ValueError("Ativo origem e destino devem ser diferentes.")
    source = get_asset(conn, source_asset_id)
    target = get_asset(conn, target_asset_id)
    if not source or not target:
        raise ValueError("Ativo origem ou destino não encontrado.")
    if source.get("merged_into_asset_id") or target.get("merged_into_asset_id"):
        raise ValueError("Ativos mesclados não podem ser usados como origem/destino operacional.")
    source_tickers = [
        row["ticker"] for row in conn.execute(
            "SELECT DISTINCT ticker FROM asset_tickers WHERE asset_id = ?",
            (source_asset_id,),
        ).fetchall()
    ]
    affected = conn.execute(
        "SELECT DISTINCT portfolio_id FROM events WHERE asset_id IN (?, ?)",
        (source_asset_id, target_asset_id),
    ).fetchall()
    conn.execute("UPDATE events SET asset_id = ? WHERE asset_id = ?", (target_asset_id, source_asset_id))
    conn.execute("UPDATE fiscal_lots SET asset_id = ? WHERE asset_id = ?", (target_asset_id, source_asset_id))
    for t in conn.execute("SELECT * FROM asset_tickers WHERE asset_id = ?", (source_asset_id,)).fetchall():
        exists = conn.execute(
            """
            SELECT 1 FROM asset_tickers
            WHERE asset_id = ? AND ticker = ?
              AND COALESCE(valid_from, '') = COALESCE(?, '')
              AND COALESCE(valid_until, '') = COALESCE(?, '')
            LIMIT 1
            """,
            (target_asset_id, t["ticker"], t["valid_from"], t["valid_until"]),
        ).fetchone()
        if not exists:
            conn.execute(
                "INSERT INTO asset_tickers (asset_id, ticker, name, valid_from, valid_until) VALUES (?, ?, ?, ?, ?)",
                (target_asset_id, t["ticker"], t["name"], t["valid_from"], t["valid_until"]),
            )
    conn.execute(
        "UPDATE assets SET merged_into_asset_id = ?, merged_at = datetime('now'), duplicate_flag = 0 WHERE id = ?",
        (target_asset_id, source_asset_id),
    )
    for ticker in source_tickers:
        conn.execute(
            """
            UPDATE asset_match_reviews
            SET status = 'resolved', resolved_at = datetime('now')
            WHERE status = 'pending'
              AND ticker = ?
              AND (candidate_asset_ids LIKE ? OR candidate_asset_ids LIKE ?)
            """,
            (ticker, f"%{source_asset_id}%", f"%{target_asset_id}%"),
        )
    conn.execute("DELETE FROM positions WHERE asset_id = ?", (source_asset_id,))

    from backend.services.event_service import recalculate_position
    for row in affected:
        recalculate_position(conn, target_asset_id, row["portfolio_id"])
    return get_asset(conn, target_asset_id)


def delete_asset(conn: sqlite3.Connection, asset_id: int) -> bool:
    asset = get_asset(conn, asset_id)
    if not asset:
        return False

    conn.execute("DELETE FROM positions WHERE asset_id = ?", (asset_id,))
    conn.execute("DELETE FROM asset_tickers WHERE asset_id = ?", (asset_id,))
    conn.execute("DELETE FROM events WHERE asset_id = ?", (asset_id,))
    conn.execute(
        "UPDATE assets SET merged_into_asset_id = NULL, merged_at = NULL WHERE merged_into_asset_id = ?",
        (asset_id,),
    )
    conn.execute("DELETE FROM assets WHERE id = ?", (asset_id,))
    return True


def resolve_ticker_to_asset_id(conn: sqlite3.Connection, ticker: str, event_date: str) -> int | None:
    row = conn.execute(
        """
        SELECT t.asset_id FROM asset_tickers t
        JOIN assets a ON a.id = t.asset_id
        WHERE t.ticker = ?
          AND (t.valid_from IS NULL OR t.valid_from <= ?)
          AND (t.valid_until IS NULL OR t.valid_until > ?)
          AND a.merged_into_asset_id IS NULL
        ORDER BY t.valid_from DESC NULLS FIRST, t.id DESC
        LIMIT 1
        """,
        (_normalize_ticker(ticker), event_date, event_date),
    ).fetchone()
    return row["asset_id"] if row else None


def find_asset_by_ticker(conn: sqlite3.Connection, ticker: str) -> int | None:
    row = conn.execute(
        """
        SELECT t.asset_id FROM asset_tickers t
        JOIN assets a ON a.id = t.asset_id
        WHERE t.ticker = ? AND a.merged_into_asset_id IS NULL
        ORDER BY t.valid_from DESC NULLS FIRST, t.id DESC
        LIMIT 1
        """,
        (_normalize_ticker(ticker),),
    ).fetchone()
    return row["asset_id"] if row else None
