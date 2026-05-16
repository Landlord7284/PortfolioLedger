"""
Patrimonial calculation engine.

This is the heart of Portfolio Ledger. It replays ledger events in
chronological order (event_date ASC, sequence_num ASC) and computes
the consolidated position for an asset within a portfolio.

All arithmetic uses ``decimal.Decimal`` with high internal precision.
No intermediate truncation is performed — only display values are rounded.

Key concepts
------------
* **Ledger replay** — the engine processes the *full* ordered list of active
  events for a given (asset_id, portfolio_id) pair and produces the final
  ``PositionState``.
* **Validation** — each event is validated against the running position state
  *at its chronological point* before being accepted.
* **Storno / correction** — events flagged ``is_cancelled`` or ``is_storno``
  are skipped during replay; they exist only for audit trail.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation
from typing import Any, TypedDict

from .enums import EventType

# Internal precision context — we never truncate intermediates.
_ZERO = Decimal("0")
_DISPLAY_PLACES = Decimal("0.01")


# ─────────────────────────────────────────────────────────────
# Position state
# ─────────────────────────────────────────────────────────────

@dataclass
class PositionState:
    """Mutable running state for one (asset_id, portfolio_id) pair."""
    quantity: Decimal = field(default_factory=lambda: _ZERO)
    total_cost: Decimal = field(default_factory=lambda: _ZERO)
    average_price: Decimal = field(default_factory=lambda: _ZERO)
    realized_result: Decimal = field(default_factory=lambda: _ZERO)
    last_event_date: str | None = None

    def _recalc_avg(self) -> None:
        if self.quantity > _ZERO:
            self.average_price = self.total_cost / self.quantity
        else:
            self.average_price = _ZERO

    # ── display helpers ──────────────────────────────────────
    def display_dict(self) -> dict[str, str]:
        """Return values formatted for API / frontend consumption."""
        return {
            "quantity": _format_quantity(self.quantity),
            "total_cost": _format_money(self.total_cost),
            "average_price": _format_money(self.average_price),
            "realized_result": _format_money(self.realized_result),
            "last_event_date": self.last_event_date or "",
        }

    def storage_dict(self) -> dict[str, str]:
        """Return values as canonical TEXT for SQLite persistence."""
        return {
            "quantity": str(self.quantity),
            "total_cost": str(self.total_cost),
            "average_price": str(self.average_price),
            "realized_result": str(self.realized_result),
            "last_event_date": self.last_event_date or "",
        }


# ─────────────────────────────────────────────────────────────
# Event record (lightweight dict-like input)
# ─────────────────────────────────────────────────────────────

@dataclass
class EventRecord:
    """Thin wrapper over a ledger row used by the engine.

    ``quantity`` and values are already Decimal. ``event_value`` is the
    operation currency; ``event_value_brl`` is used for patrimonial replay.
    """
    id: int
    event_type: EventType
    event_date: str
    quantity: Decimal
    event_value: Decimal
    sequence_num: int
    event_value_brl: Decimal | None = None
    is_cancelled: bool = False
    is_storno: bool = False

    @property
    def replay_value(self) -> Decimal:
        return self.event_value_brl if self.event_value_brl is not None else self.event_value


class EventReplaySnapshot(TypedDict):
    realized_event_result: Decimal | None
    running_quantity: Decimal
    running_total_cost: Decimal
    running_total_cost_original: Decimal
    unit_price: Decimal | None
    unit_price_brl: Decimal | None


# ─────────────────────────────────────────────────────────────
# Validation
# ─────────────────────────────────────────────────────────────

class EngineValidationError(Exception):
    """Raised when an event violates a business rule."""


def validate_event(event: EventRecord, state: PositionState) -> None:
    """
    Validate *event* against the current running *state*.

    Raises ``EngineValidationError`` with a descriptive message on failure.
    """
    et = event.event_type
    qty = event.quantity
    val = event.replay_value

    # ── date is mandatory ────────────────────────────────────
    if not event.event_date:
        raise EngineValidationError("Data do evento é obrigatória.")

    # ── quantity must be positive for qty-moving events ──────
    if qty <= _ZERO:
        if et not in (EventType.AMORTIZACAO, EventType.CISAO):
            raise EngineValidationError(
                f"Quantidade deve ser positiva para evento {et.value}."
            )

    # ── value must be positive when it represents financial value ──
    if et not in EventType.value_ignored() and val < _ZERO:
        raise EngineValidationError(
            f"Valor do evento deve ser positivo para {et.value}."
        )

    # ── exit events: cannot leave quantity negative ──────────
    if et in EventType.exit_events():
        if qty > state.quantity:
            raise EngineValidationError(
                f"{et.value}: quantidade vendida/resgatada ({qty}) "
                f"excede posição atual ({state.quantity})."
            )

    # ── events that require existing positive position ───────
    if et in EventType.requires_positive_position():
        if state.quantity <= _ZERO:
            raise EngineValidationError(
                f"{et.value} exige posição positiva. Posição atual: {state.quantity}."
            )

    # ── grupamento: cannot leave quantity negative ───────────
    if et == EventType.GRUPAMENTO:
        if qty > state.quantity:
            raise EngineValidationError(
                f"Grupamento: redução de {qty} excede posição {state.quantity}."
            )

    # ── amortização / cisão: cannot reduce cost below zero ───
    if et in (EventType.AMORTIZACAO, EventType.CISAO):
        if val > state.total_cost:
            raise EngineValidationError(
                f"{et.value}: valor {val} excede custo total {state.total_cost}."
            )


# ─────────────────────────────────────────────────────────────
# Event processors
# ─────────────────────────────────────────────────────────────

def _process_compra(state: PositionState, qty: Decimal, val: Decimal) -> Decimal:
    state.quantity += qty
    state.total_cost += val
    state._recalc_avg()
    return _ZERO


def _process_venda(state: PositionState, qty: Decimal, val: Decimal) -> Decimal:
    avg_before = state.average_price
    cost_of_sold = avg_before * qty
    realized = val - cost_of_sold

    state.quantity -= qty
    state.total_cost -= cost_of_sold

    if state.quantity <= _ZERO:
        state.quantity = _ZERO
        state.total_cost = _ZERO
        state.average_price = _ZERO
    else:
        state._recalc_avg()

    return realized


def _process_desdobramento(state: PositionState, qty: Decimal, _val: Decimal) -> Decimal:
    state.quantity += qty
    state._recalc_avg()
    return _ZERO


def _process_grupamento(state: PositionState, qty: Decimal, _val: Decimal) -> Decimal:
    state.quantity -= qty
    state._recalc_avg()
    return _ZERO


def _process_bonificacao(state: PositionState, qty: Decimal, val: Decimal) -> Decimal:
    state.quantity += qty
    state.total_cost += val
    state._recalc_avg()
    return _ZERO


def _process_amortizacao(state: PositionState, _qty: Decimal, val: Decimal) -> Decimal:
    state.total_cost -= val
    state._recalc_avg()
    return _ZERO


def _process_cisao(state: PositionState, _qty: Decimal, val: Decimal) -> Decimal:
    state.total_cost -= val
    state._recalc_avg()
    return _ZERO


_PROCESSORS = {
    EventType.COMPRA: _process_compra,
    EventType.VENDA: _process_venda,
    EventType.RESGATE_ANTECIPADO: _process_venda,      # same math as Venda
    EventType.RESGATE_VENCIMENTO: _process_venda,      # same math as Venda
    EventType.DESDOBRAMENTO: _process_desdobramento,
    EventType.GRUPAMENTO: _process_grupamento,
    EventType.BONIFICACAO: _process_bonificacao,
    EventType.AMORTIZACAO: _process_amortizacao,
    EventType.CISAO: _process_cisao,
}


# ─────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────

def process_event(event: EventRecord, state: PositionState, *, skip_validation: bool = False) -> Decimal:
    """
    Apply *event* to *state* in-place and return the realised result
    generated by this single event.

    Parameters
    ----------
    event : EventRecord
    state : PositionState
        Mutated in place.
    skip_validation : bool
        If True, bypass business-rule checks (useful for trusted replays).

    Returns
    -------
    Decimal
        Realised result produced by this event (zero for non-exit events).
    """
    if event.is_cancelled or event.is_storno:
        return _ZERO

    if not skip_validation:
        validate_event(event, state)

    processor = _PROCESSORS[event.event_type]
    realized = processor(state, event.quantity, event.replay_value)

    state.realized_result += realized
    state.last_event_date = event.event_date

    return realized


def replay_events(events: list[EventRecord]) -> PositionState:
    """
    Replay a complete ordered list of events and return the final position.

    Events must already be sorted by (event_date ASC, sequence_num ASC).
    Cancelled and storno events are automatically skipped.

    Parameters
    ----------
    events : list[EventRecord]
        Full ordered ledger for one (asset_id, portfolio_id).

    Returns
    -------
    PositionState
    """
    state = PositionState()
    for ev in events:
        process_event(ev, state, skip_validation=False)
    return state


def replay_events_with_results(events: list[EventRecord]) -> dict[int, Decimal]:
    """
    Replay events and return a mapping of event_id → realized result
    for each exit event (Venda, Resgate Antecipado, Resgate Vencimento).

    Non-exit events and cancelled/storno events are not included in the map.
    """
    state = PositionState()
    results: dict[int, Decimal] = {}
    for ev in events:
        realized = process_event(ev, state, skip_validation=False)
        if realized != _ZERO and not ev.is_cancelled and not ev.is_storno:
            results[ev.id] = realized
    return results


def replay_events_with_snapshots(events: list[EventRecord]) -> dict[int, EventReplaySnapshot]:
    """
    Replay events and return per-event derived values for ledger display.

    The running values represent the state after each event is processed in
    chronological order. Cancelled and storno events are represented, but do
    not mutate the running state.
    """
    state = PositionState()
    original_state = PositionState()
    snapshots: dict[int, EventReplaySnapshot] = {}
    for ev in events:
        unit_price = ev.event_value / ev.quantity if ev.quantity > _ZERO else None
        unit_price_brl = ev.replay_value / ev.quantity if ev.quantity > _ZERO else None
        realized = process_event(ev, state, skip_validation=False)
        original_ev = EventRecord(
            id=ev.id,
            event_type=ev.event_type,
            event_date=ev.event_date,
            quantity=ev.quantity,
            event_value=ev.event_value,
            sequence_num=ev.sequence_num,
            event_value_brl=None,
            is_cancelled=ev.is_cancelled,
            is_storno=ev.is_storno,
        )
        process_event(original_ev, original_state, skip_validation=True)
        snapshots[ev.id] = {
            "realized_event_result": realized
            if realized != _ZERO and not ev.is_cancelled and not ev.is_storno
            else None,
            "running_quantity": state.quantity,
            "running_total_cost": state.total_cost,
            "running_total_cost_original": original_state.total_cost,
            "unit_price": unit_price,
            "unit_price_brl": unit_price_brl,
        }
    return snapshots


def validate_event_standalone(event: EventRecord, prior_events: list[EventRecord]) -> None:
    """
    Validate a *new* event by replaying all prior events up to the event's
    chronological position and then checking the new event against the
    resulting state.

    This is used when inserting a historical event that falls between
    existing events.
    """
    state = PositionState()
    for ev in prior_events:
        if ev.is_cancelled or ev.is_storno:
            continue
        # Only process events that are chronologically before or equal
        if (ev.event_date, ev.sequence_num) < (event.event_date, event.sequence_num):
            process_event(ev, state, skip_validation=True)
    validate_event(event, state)


# ─────────────────────────────────────────────────────────────
# Decimal helpers
# ─────────────────────────────────────────────────────────────

def to_decimal(value: Any) -> Decimal:
    """
    Convert a raw value to Decimal.

    Accepts str, int, float. Strings may use comma as decimal separator
    (Brazilian locale) — they are normalised to '.' before conversion.
    """
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if isinstance(value, str):
        # strip thousands separators and convert comma decimal
        s = value.strip()
        # If the string has both '.' and ',' — determine which is the
        # decimal separator by position (last one wins).
        if "," in s and "." in s:
            if s.rfind(",") > s.rfind("."):
                # 1.000,50 → 1000.50
                s = s.replace(".", "").replace(",", ".")
            else:
                # 1,000.50 → 1000.50
                s = s.replace(",", "")
        elif "," in s:
            s = s.replace(",", ".")
        try:
            return Decimal(s)
        except InvalidOperation:
            raise ValueError(f"Cannot convert '{value}' to Decimal")
    raise TypeError(f"Unsupported type for Decimal conversion: {type(value)}")


def _format_money(d: Decimal) -> str:
    """Truncate to 2 decimal places for display."""
    return str(d.quantize(_DISPLAY_PLACES, rounding=ROUND_HALF_UP))


def _format_quantity(d: Decimal) -> str:
    """Preserve meaningful precision for quantities."""
    # Normalise to remove trailing zeros, but ensure at least 2 places
    normed = d.normalize()
    # If the normalised form has fewer than 2 decimal digits, quantize to 2
    sign, digits, exponent = normed.as_tuple()
    if exponent >= 0 or abs(exponent) < 2:
        return str(normed.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
    return str(normed)
