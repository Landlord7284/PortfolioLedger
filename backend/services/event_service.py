"""
Event service — ledger operations, storno, correction and position recalculation.

The ledger is the **source of truth**.  ``positions`` is a materialised cache
rebuilt from the ledger whenever events change.
"""

from __future__ import annotations

import sqlite3
from decimal import Decimal
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
            is_cancelled=bool(r["is_cancelled"]),
            is_storno=bool(r["is_storno"]),
        ))
    return result


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
    notes: Optional[str] = None,
) -> dict:
    """
    Validate and insert a new event, then recalculate the position.

    Returns the created event row as dict.
    """
    # Parse and validate enum
    et = EventType(event_type)

    qty = to_decimal(quantity)
    val = to_decimal(event_value)

    # For value-ignored events, force value to zero
    if et in EventType.value_ignored():
        val = Decimal("0")

    # Build a temporary EventRecord for validation
    seq = next_sequence(conn)
    temp_event = EventRecord(
        id=0,
        event_type=et,
        event_date=event_date,
        quantity=qty,
        event_value=val,
        sequence_num=seq,
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
                            quantity, event_value, sequence_num, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (portfolio_id, asset_id, et.value, event_date,
         str(qty), str(val), seq, notes),
    )
    event_id = cur.lastrowid

    # Recalculate position (full replay)
    recalculate_position(conn, asset_id, portfolio_id)

    # Return the created event
    row = conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
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
                            quantity, event_value, sequence_num,
                            storno_of, is_storno, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        """,
        (
            original["portfolio_id"],
            original["asset_id"],
            original["event_type"],
            original["event_date"],
            original["quantity"],
            original["event_value"],
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
    notes: Optional[str] = None,
) -> dict:
    """
    Correct an event: storno the original and create a replacement.

    The correction event is linked to the original via ``correction_of``.
    """
    # First, storno the original
    storno_event(conn, event_id, notes=f"Estorno para correção do evento #{event_id}")

    original = conn.execute(
        "SELECT * FROM events WHERE id = ?", (event_id,)
    ).fetchone()

    et = EventType(event_type)
    qty = to_decimal(quantity)
    val = to_decimal(event_value)

    if et in EventType.value_ignored():
        val = Decimal("0")

    seq = next_sequence(conn)

    # Create correction event
    cur = conn.execute(
        """
        INSERT INTO events (portfolio_id, asset_id, event_type, event_date,
                            quantity, event_value, sequence_num,
                            correction_of, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            original["portfolio_id"],
            original["asset_id"],
            et.value,
            event_date,
            str(qty),
            str(val),
            seq,
            event_id,
            notes or f"Correção do evento #{event_id}",
        ),
    )
    correction_id = cur.lastrowid

    # Recalculate
    recalculate_position(conn, original["asset_id"], original["portfolio_id"])

    row = conn.execute("SELECT * FROM events WHERE id = ?", (correction_id,)).fetchone()
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
                ev_dict["running_quantity"] = str(snapshot["running_quantity"])
                ev_dict["running_total_cost"] = str(snapshot["running_total_cost"])
                ev_dict["net_operation_value"] = None
            else:
                ev_dict["realized_event_result"] = None
                ev_dict["unit_price"] = None
                ev_dict["running_quantity"] = None
                ev_dict["running_total_cost"] = None
                ev_dict["net_operation_value"] = None
    else:
        for ev_dict in events_list:
            ev_dict["realized_event_result"] = None
            ev_dict["unit_price"] = None
            ev_dict["running_quantity"] = None
            ev_dict["running_total_cost"] = None
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
    d["running_quantity"] = None
    d["running_total_cost"] = None
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
    return dict(row) if row else None


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
    return [dict(r) for r in rows]
