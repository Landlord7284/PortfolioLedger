"""
Event service — ledger operations, storno, correction and position recalculation.

The ledger is the **source of truth**.  ``positions`` is a materialised cache
rebuilt from the ledger whenever events change.
"""

from __future__ import annotations

import sqlite3
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional

from backend.database import next_sequence
from backend.domain.engine import (
    EventRecord,
    PositionState,
    EngineValidationError,
    process_event,
    replay_events,
    replay_events_with_snapshots,
    to_decimal,
)
from backend.domain.enums import EventType
from backend.domain.normalization import normalize_event_type_strict


CENTS = Decimal("0.01")


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

def _rows_to_event_records(rows: list) -> list[EventRecord]:
    """Convert SQLite rows to EventRecord objects."""
    result = []
    for r in rows:
        result.append(EventRecord(
            id=r["id"],
            event_type=EventType(r["event_type"]),
            event_date=r["event_date"],
            quantity=Decimal(r["quantity"]),
            event_value=Decimal(r["event_value"]),
            sequence_num=r["sequence_num"],
            event_value_brl=Decimal(r["event_value_brl"]) if r["event_value_brl"] is not None else None,
            is_cancelled=bool(r["is_cancelled"]),
            is_storno=bool(r["is_storno"]),
        ))
    return result


def _rows_to_original_event_records(rows: list) -> list[EventRecord]:
    result = []
    for r in rows:
        result.append(EventRecord(
            id=r["id"],
            event_type=EventType(r["event_type"]),
            event_date=r["event_date"],
            quantity=Decimal(r["quantity"]),
            event_value=Decimal(r["event_value"]),
            sequence_num=r["sequence_num"],
            is_cancelled=bool(r["is_cancelled"]),
            is_storno=bool(r["is_storno"]),
        ))
    return result


def _money_brl(value: Decimal) -> str:
    return str(value.quantize(CENTS, rounding=ROUND_HALF_UP))


def _is_us_asset(conn: sqlite3.Connection, asset_id: int) -> bool:
    asset = conn.execute(
        "SELECT market, currency FROM assets WHERE id = ?",
        (asset_id,),
    ).fetchone()
    return bool(asset and (asset["market"] == "US" or asset["currency"] == "USD"))


def build_brl_conversion(
    conn: sqlite3.Connection,
    asset_id: int,
    event_date: str,
    event_value: Decimal,
    gross_value: Decimal | None,
) -> dict[str, str | None]:
    if not _is_us_asset(conn, asset_id):
        return {
            "event_value_brl": str(event_value),
            "gross_value_brl": str(gross_value) if gross_value is not None else None,
            "ptax_compra": None,
            "ptax_venda": None,
        }

    from backend.services.ptax_service import get_ptax

    ptax = get_ptax(event_date, conn=conn)
    venda = Decimal(str(ptax["venda"]))
    compra = Decimal(str(ptax["compra"]))
    return {
        "event_value_brl": _money_brl(event_value * venda),
        "gross_value_brl": _money_brl(gross_value * venda) if gross_value is not None else None,
        "ptax_compra": str(compra),
        "ptax_venda": str(venda),
    }


def _fetch_all_events(
    conn: sqlite3.Connection,
    asset_id: int,
    portfolio_id: int,
) -> list[EventRecord]:
    """Fetch all events for an asset+portfolio, ordered for replay."""
    rows = conn.execute(
        """
        SELECT * FROM events
        WHERE asset_id = ? AND portfolio_id = ?
        ORDER BY event_date ASC, sequence_num ASC
        """,
        (asset_id, portfolio_id),
    ).fetchall()
    return _rows_to_event_records(rows)


def _fetch_all_events_original(
    conn: sqlite3.Connection,
    asset_id: int,
    portfolio_id: int,
) -> list[EventRecord]:
    rows = conn.execute(
        """
        SELECT * FROM events
        WHERE asset_id = ? AND portfolio_id = ?
        ORDER BY event_date ASC, sequence_num ASC
        """,
        (asset_id, portfolio_id),
    ).fetchall()
    return _rows_to_original_event_records(rows)


def _save_position(
    conn: sqlite3.Connection,
    portfolio_id: int,
    asset_id: int,
    state: PositionState,
) -> None:
    """Upsert the materialised position cache."""
    sd = state.storage_dict()
    conn.execute(
        """
        INSERT INTO positions (portfolio_id, asset_id, quantity, total_cost,
                               average_price, realized_result, last_event_date,
                               updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(portfolio_id, asset_id) DO UPDATE SET
            quantity        = excluded.quantity,
            total_cost      = excluded.total_cost,
            average_price   = excluded.average_price,
            realized_result = excluded.realized_result,
            last_event_date = excluded.last_event_date,
            updated_at      = datetime('now')
        """,
        (
            portfolio_id,
            asset_id,
            sd["quantity"],
            sd["total_cost"],
            sd["average_price"],
            sd["realized_result"],
            sd["last_event_date"] or None,
        ),
    )


# ─────────────────────────────────────────────────────────────
# Recalculation
# ─────────────────────────────────────────────────────────────

def recalculate_position(
    conn: sqlite3.Connection,
    asset_id: int,
    portfolio_id: int,
) -> PositionState:
    """
    Full ledger replay for one (asset_id, portfolio_id).

    Rebuilds the materialised position from scratch.
    """
    events = _fetch_all_events(conn, asset_id, portfolio_id)
    try:
        state = replay_events(events)
    except EngineValidationError:
        state = PositionState()
        for ev in events:
            process_event(ev, state, skip_validation=True)
    _save_position(conn, portfolio_id, asset_id, state)
    return state


def backfill_event_brl_conversions(conn: sqlite3.Connection) -> dict:
    """
    Populate BRL replay values for existing events.

    Events that cannot be converted because PTAX is unavailable are left
    unchanged; their positions are not recalculated in this pass.
    """
    rows = conn.execute(
        """
        SELECT e.*, a.market, a.currency
        FROM events e
        JOIN assets a ON a.id = e.asset_id
        WHERE e.event_value_brl IS NULL
        ORDER BY e.event_date, e.sequence_num
        """
    ).fetchall()
    converted = 0
    errors: list[str] = []
    touched: set[tuple[int, int]] = set()

    for row in rows:
        try:
            gross = to_decimal(row["gross_value"]) if row["gross_value"] is not None else None
            conversion = build_brl_conversion(
                conn,
                row["asset_id"],
                row["event_date"],
                to_decimal(row["event_value"]),
                gross,
            )
            conn.execute(
                """
                UPDATE events
                SET event_value_brl = ?,
                    gross_value_brl = ?,
                    ptax_compra = ?,
                    ptax_venda = ?
                WHERE id = ?
                """,
                (
                    conversion["event_value_brl"],
                    conversion["gross_value_brl"],
                    conversion["ptax_compra"],
                    conversion["ptax_venda"],
                    row["id"],
                ),
            )
            touched.add((row["asset_id"], row["portfolio_id"]))
            converted += 1
        except Exception as exc:
            errors.append(f"Evento {row['id']}: {exc}")

    for asset_id, portfolio_id in touched:
        missing = conn.execute(
            """
            SELECT 1
            FROM events
            WHERE asset_id = ? AND portfolio_id = ? AND event_value_brl IS NULL
            LIMIT 1
            """,
            (asset_id, portfolio_id),
        ).fetchone()
        if not missing:
            recalculate_position(conn, asset_id, portfolio_id)

    return {"converted": converted, "errors": errors}


# ─────────────────────────────────────────────────────────────
# Create event
# ─────────────────────────────────────────────────────────────

def create_event(
    conn: sqlite3.Connection,
    portfolio_id: int,
    asset_id: int,
    event_type: str,
    event_date: str,
    quantity: str,
    event_value: str,
    gross_value: Optional[str] = None,
    origin_usd: Optional[str] = None,
    notes: Optional[str] = None,
) -> dict:
    """
    Validate and insert a new event, then recalculate the position.

    Returns the created event row as dict.
    """
    # Parse and validate enum
    et = EventType(normalize_event_type_strict(event_type))

    qty = to_decimal(quantity)
    val = to_decimal(event_value)
    gross = to_decimal(gross_value) if gross_value and et == EventType.VENDA else None

    # For value-ignored events, force value to zero
    if et in EventType.value_ignored():
        val = Decimal("0")
        gross = None

    # Build a temporary EventRecord for validation
    seq = next_sequence(conn)
    conversion = build_brl_conversion(conn, asset_id, event_date, val, gross)
    temp_event = EventRecord(
        id=0,
        event_type=et,
        event_date=event_date,
        quantity=qty,
        event_value=val,
        sequence_num=seq,
        event_value_brl=Decimal(conversion["event_value_brl"]) if conversion["event_value_brl"] is not None else None,
    )

    # Replay existing events to get state at insertion point
    existing = _fetch_all_events(conn, asset_id, portfolio_id)

    # Find the state just before this event's chronological position
    state = PositionState()
    for ev in existing:
        if ev.is_cancelled or ev.is_storno:
            continue
        if (ev.event_date, ev.sequence_num) < (event_date, seq):
            from backend.domain.engine import process_event
            process_event(ev, state, skip_validation=True)

    # Validate against current state at that point
    from backend.domain.engine import validate_event
    validate_event(temp_event, state)

    # Insert into ledger
    cur = conn.execute(
        """
        INSERT INTO events (portfolio_id, asset_id, event_type, event_date,
                            quantity, event_value, event_value_brl, gross_value,
                            gross_value_brl, ptax_compra, ptax_venda,
                            sequence_num, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (portfolio_id, asset_id, et.value, event_date,
         str(qty), str(val), conversion["event_value_brl"],
         str(gross) if gross is not None else None, conversion["gross_value_brl"],
         conversion["ptax_compra"], conversion["ptax_venda"], seq, notes),
    )
    event_id = cur.lastrowid

    row = conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
    if et == EventType.COMPRA:
        from backend.services.fiscal_lot_service import create_lot_for_purchase
        create_lot_for_purchase(conn, row, origin_usd)

    # Recalculate position (full replay)
    recalculate_position(conn, asset_id, portfolio_id)

    # Return the created event
    return dict(row)


def create_events_bulk(
    conn: sqlite3.Connection,
    events_data: list[dict],
) -> list[dict]:
    """
    Create multiple events in a single transaction.

    Each dict must contain: portfolio_id, asset_id, event_type,
    event_date, quantity, event_value, notes (optional).

    Returns the list of created event dicts.
    """
    created = []
    for ev_data in events_data:
        ev = create_event(
            conn,
            portfolio_id=ev_data["portfolio_id"],
            asset_id=ev_data["asset_id"],
            event_type=ev_data["event_type"],
            event_date=ev_data["event_date"],
            quantity=ev_data["quantity"],
            event_value=ev_data["event_value"],
            gross_value=ev_data.get("gross_value"),
            origin_usd=ev_data.get("origin_usd"),
            notes=ev_data.get("notes"),
        )
        created.append(ev)
    return created


# ─────────────────────────────────────────────────────────────
# Storno
# ─────────────────────────────────────────────────────────────

def storno_event(
    conn: sqlite3.Connection,
    event_id: int,
    notes: Optional[str] = None,
) -> dict:
    """
    Logically reverse an event.

    1. Mark the original as ``is_cancelled``.
    2. Create a storno event linked to the original.
    3. Recalculate position.
    """
    original = conn.execute(
        "SELECT * FROM events WHERE id = ?", (event_id,)
    ).fetchone()
    if not original:
        raise ValueError(f"Evento {event_id} não encontrado.")
    if original["is_cancelled"]:
        raise ValueError(f"Evento {event_id} já está cancelado.")
    if original["is_storno"]:
        raise ValueError(f"Evento {event_id} é um estorno e não pode ser estornado.")

    seq = next_sequence(conn)

    # Mark original as cancelled
    conn.execute(
        "UPDATE events SET is_cancelled = 1 WHERE id = ?", (event_id,)
    )

    # Create storno event
    cur = conn.execute(
        """
        INSERT INTO events (portfolio_id, asset_id, event_type, event_date,
                            quantity, event_value, event_value_brl, gross_value,
                            gross_value_brl, ptax_compra, ptax_venda, sequence_num,
                            storno_of, is_storno, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        """,
        (
            original["portfolio_id"],
            original["asset_id"],
            original["event_type"],
            original["event_date"],
            original["quantity"],
            original["event_value"],
            original["event_value_brl"],
            original["gross_value"],
            original["gross_value_brl"],
            original["ptax_compra"],
            original["ptax_venda"],
            seq,
            event_id,
            notes or f"Estorno do evento #{event_id}",
        ),
    )
    storno_id = cur.lastrowid

    # Recalculate
    recalculate_position(conn, original["asset_id"], original["portfolio_id"])

    row = conn.execute("SELECT * FROM events WHERE id = ?", (storno_id,)).fetchone()
    return dict(row)


# ─────────────────────────────────────────────────────────────
# Correction
# ─────────────────────────────────────────────────────────────

def correct_event(
    conn: sqlite3.Connection,
    event_id: int,
    event_type: str,
    event_date: str,
    quantity: str,
    event_value: str,
    gross_value: Optional[str] = None,
    origin_usd: Optional[str] = None,
    notes: Optional[str] = None,
) -> dict:
    """
    Correct an event: storno the original and create a replacement.

    The correction event is linked to the original via ``correction_of``.
    """
    et = EventType(normalize_event_type_strict(event_type))

    # First, storno the original
    storno_event(conn, event_id, notes=f"Estorno para correção do evento #{event_id}")

    original = conn.execute(
        "SELECT * FROM events WHERE id = ?", (event_id,)
    ).fetchone()

    qty = to_decimal(quantity)
    val = to_decimal(event_value)
    gross = to_decimal(gross_value) if gross_value and et == EventType.VENDA else None

    if et in EventType.value_ignored():
        val = Decimal("0")
        gross = None

    seq = next_sequence(conn)
    conversion = build_brl_conversion(conn, original["asset_id"], event_date, val, gross)

    # Create correction event
    cur = conn.execute(
        """
        INSERT INTO events (portfolio_id, asset_id, event_type, event_date,
                            quantity, event_value, event_value_brl, gross_value,
                            gross_value_brl, ptax_compra, ptax_venda, sequence_num,
                            correction_of, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            original["portfolio_id"],
            original["asset_id"],
            et.value,
            event_date,
            str(qty),
            str(val),
            conversion["event_value_brl"],
            str(gross) if gross is not None else None,
            conversion["gross_value_brl"],
            conversion["ptax_compra"],
            conversion["ptax_venda"],
            seq,
            event_id,
            notes or f"Correção do evento #{event_id}",
        ),
    )
    correction_id = cur.lastrowid

    row = conn.execute("SELECT * FROM events WHERE id = ?", (correction_id,)).fetchone()
    if et == EventType.COMPRA:
        from backend.services.fiscal_lot_service import create_lot_for_purchase
        create_lot_for_purchase(conn, row, origin_usd)

    # Recalculate
    recalculate_position(conn, original["asset_id"], original["portfolio_id"])

    return dict(row)


# ─────────────────────────────────────────────────────────────
# Delete (soft-delete)
# ─────────────────────────────────────────────────────────────

def delete_event(
    conn: sqlite3.Connection,
    event_id: int,
) -> dict:
    """
    Soft-delete an event by marking it as cancelled, then recalculate position.

    Returns the cancelled event.
    """
    original = conn.execute(
        "SELECT * FROM events WHERE id = ?", (event_id,)
    ).fetchone()
    if not original:
        raise ValueError(f"Evento {event_id} não encontrado.")
    if original["is_cancelled"]:
        raise ValueError(f"Evento {event_id} já está cancelado.")

    conn.execute(
        "UPDATE events SET is_cancelled = 1, duplicate_flag = 0 WHERE id = ?", (event_id,)
    )

    # Check if we should clear the asset's duplicate_flag
    other_dup = conn.execute(
        "SELECT 1 FROM events WHERE asset_id = ? AND duplicate_flag = 1 AND is_cancelled = 0 LIMIT 1",
        (original["asset_id"],)
    ).fetchone()
    if not other_dup:
        conn.execute("UPDATE assets SET duplicate_flag = 0 WHERE id = ?", (original["asset_id"],))


    # Recalculate position
    recalculate_position(conn, original["asset_id"], original["portfolio_id"])

    row = conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
    return dict(row)


def delete_events_bulk(
    conn: sqlite3.Connection,
    event_ids: list[int],
) -> list[dict]:
    """
    Soft-delete multiple events and recalculate affected positions.

    Returns the list of cancelled event dicts.
    """
    results = []
    # Track which (asset_id, portfolio_id) pairs need recalculation
    affected: set[tuple[int, int]] = set()

    for event_id in event_ids:
        original = conn.execute(
            "SELECT * FROM events WHERE id = ?", (event_id,)
        ).fetchone()
        if not original:
            continue
        if original["is_cancelled"]:
            continue

        conn.execute(
            "UPDATE events SET is_cancelled = 1, duplicate_flag = 0 WHERE id = ?", (event_id,)
        )
        affected.add((original["asset_id"], original["portfolio_id"]))

        row = conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
        results.append(dict(row))

    # Recalculate all affected positions
    for asset_id, portfolio_id in affected:
        recalculate_position(conn, asset_id, portfolio_id)
        
        # Check if we should clear the asset's duplicate_flag
        other_dup = conn.execute(
            "SELECT 1 FROM events WHERE asset_id = ? AND duplicate_flag = 1 AND is_cancelled = 0 LIMIT 1",
            (asset_id,)
        ).fetchone()
        if not other_dup:
            conn.execute("UPDATE assets SET duplicate_flag = 0 WHERE id = ?", (asset_id,))

    return results


# ─────────────────────────────────────────────────────────────
# Query helpers
# ─────────────────────────────────────────────────────────────

def list_events(
    conn: sqlite3.Connection,
    asset_id: Optional[int] = None,
    portfolio_id: Optional[int] = None,
) -> list[dict]:
    """List events with optional filters, ordered chronologically.

    When filtering by both asset_id and portfolio_id, the response
    includes computed per-event ledger display fields.
    """
    conditions = []
    params = []
    if asset_id is not None:
        conditions.append("asset_id = ?")
        params.append(asset_id)
    if portfolio_id is not None:
        conditions.append("portfolio_id = ?")
        params.append(portfolio_id)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    rows = conn.execute(
        f"SELECT * FROM events {where} ORDER BY event_date ASC, sequence_num ASC",
        params,
    ).fetchall()
    events_list = [dict(r) for r in rows]

    # If filtering by a specific asset+portfolio, compute per-event results
    if asset_id is not None and portfolio_id is not None:
        records = _rows_to_event_records(rows)
        try:
            per_event_snapshots = replay_events_with_snapshots(records)
        except EngineValidationError:
            per_event_snapshots = {}

        for ev_dict in events_list:
            snapshot = per_event_snapshots.get(ev_dict["id"])
            if snapshot is not None:
                ev_dict["realized_event_result"] = (
                    str(snapshot["realized_event_result"])
                    if snapshot["realized_event_result"] is not None
                    else None
                )
                ev_dict["unit_price"] = (
                    str(snapshot["unit_price"])
                    if snapshot["unit_price"] is not None
                    else None
                )
                ev_dict["unit_price_brl"] = (
                    str(snapshot["unit_price_brl"])
                    if snapshot["unit_price_brl"] is not None
                    else None
                )
                ev_dict["running_quantity"] = str(snapshot["running_quantity"])
                ev_dict["running_total_cost"] = str(snapshot["running_total_cost"])
                ev_dict["running_total_cost_original"] = str(snapshot["running_total_cost_original"])
                ev_dict["net_operation_value"] = None
            else:
                ev_dict["realized_event_result"] = None
                ev_dict["unit_price"] = None
                ev_dict["unit_price_brl"] = None
                ev_dict["running_quantity"] = None
                ev_dict["running_total_cost"] = None
                ev_dict["running_total_cost_original"] = None
                ev_dict["net_operation_value"] = None
    else:
        for ev_dict in events_list:
            ev_dict["realized_event_result"] = None
            ev_dict["unit_price"] = None
            ev_dict["unit_price_brl"] = None
            ev_dict["running_quantity"] = None
            ev_dict["running_total_cost"] = None
            ev_dict["running_total_cost_original"] = None
            ev_dict["net_operation_value"] = None

    return events_list


def get_event(conn: sqlite3.Connection, event_id: int) -> dict | None:
    row = conn.execute(
        "SELECT * FROM events WHERE id = ?", (event_id,)
    ).fetchone()
    if not row:
        return None
    d = dict(row)
    d["realized_event_result"] = None
    d["unit_price"] = None
    d["unit_price_brl"] = None
    d["running_quantity"] = None
    d["running_total_cost"] = None
    d["running_total_cost_original"] = None
    d["net_operation_value"] = None
    return d


def get_position(
    conn: sqlite3.Connection,
    portfolio_id: int,
    asset_id: int,
) -> dict | None:
    row = conn.execute(
        """
        SELECT p.*, a.asset_class, a.market, a.currency, a.duplicate_flag,
               (SELECT ticker FROM asset_tickers
                WHERE asset_id = p.asset_id AND valid_until IS NULL
                ORDER BY valid_from DESC LIMIT 1) as current_ticker
        FROM positions p
        JOIN assets a ON a.id = p.asset_id
        WHERE p.portfolio_id = ? AND p.asset_id = ?
          AND a.merged_into_asset_id IS NULL
        """,
        (portfolio_id, asset_id),
    ).fetchone()
    return _attach_original_position(conn, dict(row)) if row else None


def _attach_original_position(conn: sqlite3.Connection, position: dict) -> dict:
    if position.get("market") != "US" and position.get("currency") != "USD":
        position["total_cost_original"] = None
        position["average_price_original"] = None
        position["realized_result_original"] = None
        return position

    events = _fetch_all_events_original(conn, position["asset_id"], position["portfolio_id"])
    try:
        state = replay_events(events)
    except EngineValidationError:
        state = PositionState()
        for ev in events:
            process_event(ev, state, skip_validation=True)
    position["total_cost_original"] = str(state.total_cost)
    position["average_price_original"] = str(state.average_price)
    position["realized_result_original"] = str(state.realized_result)
    return position


def list_positions(
    conn: sqlite3.Connection,
    portfolio_id: Optional[int] = None,
) -> list[dict]:
    """List all positions, optionally filtered by portfolio."""
    if portfolio_id is not None:
        rows = conn.execute(
            """
            SELECT p.*, a.asset_class, a.market, a.currency, a.duplicate_flag,
                   (SELECT ticker FROM asset_tickers
                    WHERE asset_id = p.asset_id AND valid_until IS NULL
                    ORDER BY valid_from DESC LIMIT 1) as current_ticker
            FROM positions p
            JOIN assets a ON a.id = p.asset_id
            WHERE p.portfolio_id = ? AND a.merged_into_asset_id IS NULL
            ORDER BY a.asset_class, current_ticker
            """,
            (portfolio_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT p.*, a.asset_class, a.market, a.currency, a.duplicate_flag,
                   (SELECT ticker FROM asset_tickers
                    WHERE asset_id = p.asset_id AND valid_until IS NULL
                    ORDER BY valid_from DESC LIMIT 1) as current_ticker
            FROM positions p
            JOIN assets a ON a.id = p.asset_id
            WHERE a.merged_into_asset_id IS NULL
            ORDER BY a.asset_class, current_ticker
            """
        ).fetchall()
    return [_attach_original_position(conn, dict(r)) for r in rows]
