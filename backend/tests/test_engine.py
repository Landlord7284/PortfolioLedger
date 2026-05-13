"""
Tests for the patrimonial calculation engine.

Covers:
- The 3 spec test cases (Compra simples, Compra+Compra, Venda parcial c/ lucro)
- Every event type individually
- Storno / correction replay
- Edge cases and validation rules
"""

import pytest
from decimal import Decimal

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

D = Decimal


def _ev(
    id: int,
    event_type: EventType,
    qty: str,
    val: str,
    date: str = "2024-01-01",
    seq: int | None = None,
    is_cancelled: bool = False,
    is_storno: bool = False,
) -> EventRecord:
    return EventRecord(
        id=id,
        event_type=event_type,
        event_date=date,
        quantity=D(qty),
        event_value=D(val),
        sequence_num=seq if seq is not None else id,
        is_cancelled=is_cancelled,
        is_storno=is_storno,
    )


# ═════════════════════════════════════════════════════════════
# Spec test cases
# ═════════════════════════════════════════════════════════════

class TestSpecCases:
    """Exact test cases from the specification document."""

    def test_caso_1_compra_simples(self):
        """Compra 10 cotas por Valor Evento 1000."""
        events = [_ev(1, EventType.COMPRA, "10", "1000")]
        pos = replay_events(events)
        assert pos.quantity == D("10")
        assert pos.total_cost == D("1000")
        assert pos.average_price == D("100")
        assert pos.realized_result == D("0")

    def test_caso_2_compra_compra(self):
        """Compra 10 por 1000 + Compra 10 por 2000."""
        events = [
            _ev(1, EventType.COMPRA, "10", "1000", date="2024-01-01"),
            _ev(2, EventType.COMPRA, "10", "2000", date="2024-01-02"),
        ]
        pos = replay_events(events)
        assert pos.quantity == D("20")
        assert pos.total_cost == D("3000")
        assert pos.average_price == D("150")

    def test_caso_3_venda_parcial_com_lucro(self):
        """Compra 10 por 1000 + Venda 4 por 600."""
        events = [
            _ev(1, EventType.COMPRA, "10", "1000", date="2024-01-01"),
            _ev(2, EventType.VENDA, "4", "600", date="2024-01-02"),
        ]
        pos = replay_events(events)
        assert pos.quantity == D("6")
        assert pos.total_cost == D("600")
        assert pos.average_price == D("100")
        assert pos.realized_result == D("200")


# ═════════════════════════════════════════════════════════════
# Individual event types
# ═════════════════════════════════════════════════════════════

class TestCompra:
    def test_first_buy(self):
        events = [_ev(1, EventType.COMPRA, "100", "5000")]
        pos = replay_events(events)
        assert pos.quantity == D("100")
        assert pos.total_cost == D("5000")
        assert pos.average_price == D("50")

    def test_multiple_buys_avg_price(self):
        events = [
            _ev(1, EventType.COMPRA, "100", "1000", date="2024-01-01"),
            _ev(2, EventType.COMPRA, "200", "4000", date="2024-01-02"),
        ]
        pos = replay_events(events)
        assert pos.quantity == D("300")
        assert pos.total_cost == D("5000")
        # 5000 / 300 = 16.6666...
        assert pos.average_price == D("5000") / D("300")


class TestVenda:
    def test_full_sell_zeroes_position(self):
        events = [
            _ev(1, EventType.COMPRA, "10", "1000", date="2024-01-01"),
            _ev(2, EventType.VENDA, "10", "1500", date="2024-01-02"),
        ]
        pos = replay_events(events)
        assert pos.quantity == D("0")
        assert pos.total_cost == D("0")
        assert pos.average_price == D("0")
        assert pos.realized_result == D("500")

    def test_sell_with_loss(self):
        events = [
            _ev(1, EventType.COMPRA, "10", "1000", date="2024-01-01"),
            _ev(2, EventType.VENDA, "5", "200", date="2024-01-02"),
        ]
        pos = replay_events(events)
        assert pos.quantity == D("5")
        assert pos.total_cost == D("500")
        assert pos.average_price == D("100")
        assert pos.realized_result == D("-300")  # 200 - 500

    def test_sell_exceeding_position_raises(self):
        state = PositionState(quantity=D("5"), total_cost=D("500"), average_price=D("100"))
        ev = _ev(1, EventType.VENDA, "10", "1000")
        with pytest.raises(EngineValidationError, match="excede posição"):
            process_event(ev, state)


class TestDesdobramento:
    def test_split_increases_qty_reduces_avg(self):
        events = [
            _ev(1, EventType.COMPRA, "100", "10000", date="2024-01-01"),
            _ev(2, EventType.DESDOBRAMENTO, "100", "0", date="2024-01-02"),
        ]
        pos = replay_events(events)
        assert pos.quantity == D("200")
        assert pos.total_cost == D("10000")
        assert pos.average_price == D("50")
        assert pos.realized_result == D("0")


class TestGrupamento:
    def test_reverse_split_reduces_qty_increases_avg(self):
        events = [
            _ev(1, EventType.COMPRA, "100", "10000", date="2024-01-01"),
            _ev(2, EventType.GRUPAMENTO, "50", "0", date="2024-01-02"),
        ]
        pos = replay_events(events)
        assert pos.quantity == D("50")
        assert pos.total_cost == D("10000")
        assert pos.average_price == D("200")
        assert pos.realized_result == D("0")


class TestBonificacao:
    def test_bonus_adds_qty_and_cost(self):
        events = [
            _ev(1, EventType.COMPRA, "100", "10000", date="2024-01-01"),
            _ev(2, EventType.BONIFICACAO, "10", "500", date="2024-01-02"),
        ]
        pos = replay_events(events)
        assert pos.quantity == D("110")
        assert pos.total_cost == D("10500")
        assert pos.average_price == D("10500") / D("110")
        assert pos.realized_result == D("0")


class TestAmortizacao:
    def test_amort_reduces_cost_keeps_qty(self):
        events = [
            _ev(1, EventType.COMPRA, "100", "10000", date="2024-01-01"),
            _ev(2, EventType.AMORTIZACAO, "0", "2000", date="2024-01-02"),
        ]
        pos = replay_events(events)
        assert pos.quantity == D("100")
        assert pos.total_cost == D("8000")
        assert pos.average_price == D("80")
        assert pos.realized_result == D("0")

    def test_amort_exceeding_cost_raises(self):
        state = PositionState(quantity=D("10"), total_cost=D("500"), average_price=D("50"))
        ev = _ev(1, EventType.AMORTIZACAO, "0", "600")
        with pytest.raises(EngineValidationError, match="excede custo total"):
            process_event(ev, state)


class TestCisao:
    def test_cisao_reduces_cost_keeps_qty(self):
        events = [
            _ev(1, EventType.COMPRA, "100", "10000", date="2024-01-01"),
            _ev(2, EventType.CISAO, "0", "3000", date="2024-01-02"),
        ]
        pos = replay_events(events)
        assert pos.quantity == D("100")
        assert pos.total_cost == D("7000")
        assert pos.average_price == D("70")
        assert pos.realized_result == D("0")


class TestResgate:
    def test_resgate_antecipado_same_as_venda(self):
        events = [
            _ev(1, EventType.COMPRA, "10", "1000", date="2024-01-01"),
            _ev(2, EventType.RESGATE_ANTECIPADO, "10", "1200", date="2024-01-02"),
        ]
        pos = replay_events(events)
        assert pos.quantity == D("0")
        assert pos.total_cost == D("0")
        assert pos.realized_result == D("200")

    def test_resgate_vencimento_same_as_venda(self):
        events = [
            _ev(1, EventType.COMPRA, "10", "1000", date="2024-01-01"),
            _ev(2, EventType.RESGATE_VENCIMENTO, "10", "1100", date="2024-01-02"),
        ]
        pos = replay_events(events)
        assert pos.quantity == D("0")
        assert pos.realized_result == D("100")


# ═════════════════════════════════════════════════════════════
# Storno and correction
# ═════════════════════════════════════════════════════════════

class TestStornoCorrection:
    def test_cancelled_event_is_skipped(self):
        events = [
            _ev(1, EventType.COMPRA, "10", "1000", date="2024-01-01"),
            _ev(2, EventType.COMPRA, "10", "9999", date="2024-01-02", is_cancelled=True),
            _ev(3, EventType.COMPRA, "5", "500", date="2024-01-03"),
        ]
        pos = replay_events(events)
        # Event 2 is cancelled — should be ignored
        assert pos.quantity == D("15")
        assert pos.total_cost == D("1500")

    def test_storno_event_is_skipped(self):
        events = [
            _ev(1, EventType.COMPRA, "10", "1000", date="2024-01-01"),
            _ev(2, EventType.COMPRA, "10", "1000", date="2024-01-02", is_cancelled=True),
            _ev(3, EventType.COMPRA, "0", "0", date="2024-01-02", is_storno=True),
        ]
        pos = replay_events(events)
        assert pos.quantity == D("10")
        assert pos.total_cost == D("1000")

    def test_correction_replaces_original(self):
        """
        Simulates: Event 10 wrong → Event 11 storno → Event 12 correction.
        Events 10 and 11 are ignored; Event 12 is the valid movement.
        """
        events = [
            _ev(10, EventType.COMPRA, "10", "1000", date="2024-01-01", is_cancelled=True),
            _ev(11, EventType.COMPRA, "0", "0", date="2024-01-01", is_storno=True),
            _ev(12, EventType.COMPRA, "10", "1500", date="2024-01-01", seq=12),
        ]
        pos = replay_events(events)
        assert pos.quantity == D("10")
        assert pos.total_cost == D("1500")
        assert pos.average_price == D("150")


# ═════════════════════════════════════════════════════════════
# Validation edge cases
# ═════════════════════════════════════════════════════════════

class TestValidation:
    def test_requires_positive_position_for_desdobramento(self):
        state = PositionState()
        ev = _ev(1, EventType.DESDOBRAMENTO, "10", "0")
        with pytest.raises(EngineValidationError, match="posição positiva"):
            process_event(ev, state)

    def test_requires_positive_position_for_grupamento(self):
        state = PositionState()
        ev = _ev(1, EventType.GRUPAMENTO, "10", "0")
        with pytest.raises(EngineValidationError, match="posição positiva"):
            process_event(ev, state)

    def test_requires_positive_position_for_bonificacao(self):
        state = PositionState()
        ev = _ev(1, EventType.BONIFICACAO, "10", "500")
        with pytest.raises(EngineValidationError, match="posição positiva"):
            process_event(ev, state)

    def test_requires_positive_position_for_amortizacao(self):
        state = PositionState()
        ev = _ev(1, EventType.AMORTIZACAO, "0", "100")
        with pytest.raises(EngineValidationError, match="posição positiva"):
            process_event(ev, state)

    def test_requires_positive_position_for_cisao(self):
        state = PositionState()
        ev = _ev(1, EventType.CISAO, "0", "100")
        with pytest.raises(EngineValidationError, match="posição positiva"):
            process_event(ev, state)

    def test_missing_date_raises(self):
        state = PositionState()
        ev = _ev(1, EventType.COMPRA, "10", "1000", date="")
        with pytest.raises(EngineValidationError, match="Data"):
            process_event(ev, state)

    def test_cisao_exceeding_cost_raises(self):
        state = PositionState(quantity=D("10"), total_cost=D("100"), average_price=D("10"))
        ev = _ev(1, EventType.CISAO, "0", "200")
        with pytest.raises(EngineValidationError, match="excede custo total"):
            process_event(ev, state)


# ═════════════════════════════════════════════════════════════
# Complex multi-event scenarios
# ═════════════════════════════════════════════════════════════

class TestComplexScenarios:
    def test_buy_sell_buy_sell(self):
        events = [
            _ev(1, EventType.COMPRA, "100", "10000", date="2024-01-01"),
            _ev(2, EventType.VENDA, "50", "6000", date="2024-01-02"),
            _ev(3, EventType.COMPRA, "200", "30000", date="2024-01-03"),
            _ev(4, EventType.VENDA, "100", "20000", date="2024-01-04"),
        ]
        pos = replay_events(events)
        # After event 1: qty=100, cost=10000, avg=100
        # After event 2: qty=50, cost=5000, avg=100, realized=1000
        # After event 3: qty=250, cost=35000, avg=140
        # After event 4: qty=150, cost=21000, avg=140, realized_this=6000, total_realized=7000
        assert pos.quantity == D("150")
        assert pos.total_cost == D("21000")
        assert pos.average_price == D("140")
        assert pos.realized_result == D("7000")

    def test_split_then_sell(self):
        """Desdobramento 1:2 then sell half."""
        events = [
            _ev(1, EventType.COMPRA, "100", "10000", date="2024-01-01"),
            _ev(2, EventType.DESDOBRAMENTO, "100", "0", date="2024-02-01"),
            _ev(3, EventType.VENDA, "100", "7000", date="2024-03-01"),
        ]
        pos = replay_events(events)
        # After split: qty=200, cost=10000, avg=50
        # After sell 100: cost_sold=5000, realized=2000, qty=100, cost=5000
        assert pos.quantity == D("100")
        assert pos.total_cost == D("5000")
        assert pos.average_price == D("50")
        assert pos.realized_result == D("2000")

    def test_crypto_fractional_quantities(self):
        """Crypto with 8 decimal places."""
        events = [
            _ev(1, EventType.COMPRA, "0.00150000", "100", date="2024-01-01"),
            _ev(2, EventType.COMPRA, "0.00350000", "250", date="2024-01-02"),
        ]
        pos = replay_events(events)
        assert pos.quantity == D("0.00500000")
        assert pos.total_cost == D("350")
        assert pos.average_price == D("350") / D("0.005")


class TestReplaySnapshots:
    def test_running_values_and_unit_price_follow_chronological_replay(self):
        events = [
            _ev(1, EventType.COMPRA, "10", "1000", date="2024-01-01"),
            _ev(2, EventType.VENDA, "4", "600", date="2024-01-02"),
            _ev(3, EventType.AMORTIZACAO, "0", "100", date="2024-01-03"),
            _ev(4, EventType.COMPRA, "10", "9999", date="2024-01-04", is_cancelled=True),
        ]

        snapshots = replay_events_with_snapshots(events)

        assert snapshots[1]["unit_price"] == D("100")
        assert snapshots[1]["running_quantity"] == D("10")
        assert snapshots[1]["running_total_cost"] == D("1000")
        assert snapshots[1]["realized_event_result"] is None

        assert snapshots[2]["unit_price"] == D("150")
        assert snapshots[2]["running_quantity"] == D("6")
        assert snapshots[2]["running_total_cost"] == D("600")
        assert snapshots[2]["realized_event_result"] == D("200")

        assert snapshots[3]["unit_price"] is None
        assert snapshots[3]["running_quantity"] == D("6")
        assert snapshots[3]["running_total_cost"] == D("500")

        assert snapshots[4]["unit_price"] == D("999.9")
        assert snapshots[4]["running_quantity"] == D("6")
        assert snapshots[4]["running_total_cost"] == D("500")


# ═════════════════════════════════════════════════════════════
# Decimal conversion helpers
# ═════════════════════════════════════════════════════════════

class TestToDecimal:
    def test_str_dot(self):
        assert to_decimal("1234.56") == D("1234.56")

    def test_str_comma(self):
        assert to_decimal("1234,56") == D("1234.56")

    def test_str_brazilian_format(self):
        assert to_decimal("1.234,56") == D("1234.56")

    def test_str_us_format(self):
        assert to_decimal("1,234.56") == D("1234.56")

    def test_int(self):
        assert to_decimal(42) == D("42")

    def test_float(self):
        assert to_decimal(3.14) == D("3.14")

    def test_decimal_passthrough(self):
        v = D("99.99")
        assert to_decimal(v) is v

    def test_invalid_raises(self):
        with pytest.raises(ValueError):
            to_decimal("abc")
