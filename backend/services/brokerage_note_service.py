"""
Brokerage note cost allocation.

The service converts operations from a brokerage note into normalized ledger
events. All financial math is done with Decimal and rounded to cents.
"""

from __future__ import annotations

from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP

from backend.domain.engine import to_decimal
from backend.domain.enums import AssetClass, EventType
from backend.services.import_service import import_events_to_ledger

CENTS = Decimal("0.01")


class BrokerageNoteValidationError(ValueError):
    pass


def _money(value) -> Decimal:
    return to_decimal(value).quantize(CENTS, rounding=ROUND_HALF_UP)


def _display_money(value: Decimal) -> Decimal:
    return value.quantize(CENTS, rounding=ROUND_DOWN)


def _normalize_dc(value: str) -> str:
    dc = value.strip().upper()
    if dc in {"D", "DEBITO", "DÉBITO"}:
        return "D"
    if dc in {"C", "CREDITO", "CRÉDITO"}:
        return "C"
    raise BrokerageNoteValidationError("D/C deve ser 'D' para Débito ou 'C' para Crédito.")


def _normalize_operation_type(value: str) -> str:
    op = value.strip().upper()
    if op in {"C", "COMPRA"}:
        return EventType.COMPRA.value
    if op in {"V", "VENDA"}:
        return EventType.VENDA.value
    raise BrokerageNoteValidationError("Operação deve ser Compra ou Venda.")


def _normalize_asset_class(value: str) -> str:
    text = str(value).strip()
    aliases = {
        "AÃ§Ã£o": AssetClass.ACAO.value,
        "A??o": AssetClass.ACAO.value,
        "Acao": AssetClass.ACAO.value,
        "Ação": AssetClass.ACAO.value,
        "DebÃªnture": AssetClass.DEBENTURE.value,
        "Debenture": AssetClass.DEBENTURE.value,
    }
    if text in aliases:
        return aliases[text]
    return AssetClass(text).value


def _signed_note_amount(debit_credit: str, net_amount) -> Decimal:
    amount = _money(net_amount)
    return amount if _normalize_dc(debit_credit) == "D" else -amount


def _allocate_costs(operations: list[dict], total_costs: Decimal) -> list[Decimal]:
    if not operations:
        return []
    weight_total = sum(op["gross_value"] for op in operations)
    if weight_total == 0:
        raise BrokerageNoteValidationError("O total bruto das operações deve ser maior que zero.")
    return [
        _display_money(total_costs * op["gross_value"] / weight_total)
        for op in operations
    ]


def calculate_brokerage_note(payload: dict) -> dict:
    note_date = payload.get("note_date")
    if not note_date:
        raise BrokerageNoteValidationError("Data da nota é obrigatória.")

    raw_operations = payload.get("operations") or []
    if not raw_operations:
        raise BrokerageNoteValidationError("Informe ao menos uma operação.")

    normalized_ops: list[dict] = []
    for idx, raw in enumerate(raw_operations, start=1):
        asset_class = _normalize_asset_class(raw["asset_class"])
        ticker = str(raw["ticker"]).strip().upper()
        if not ticker:
            raise BrokerageNoteValidationError(f"Linha {idx}: ticker é obrigatório.")
        event_type = _normalize_operation_type(raw["operation_type"])
        quantity = to_decimal(raw["quantity"])
        gross_value = _money(raw["gross_value"])
        if quantity <= 0:
            raise BrokerageNoteValidationError(f"Linha {idx}: quantidade deve ser positiva.")
        if gross_value <= 0:
            raise BrokerageNoteValidationError(f"Linha {idx}: valor bruto deve ser positivo.")
        calculated_price = _display_money(gross_value / quantity)
        normalized_ops.append({
            "asset_class": asset_class,
            "ticker": ticker,
            "event_type": event_type,
            "quantity": quantity,
            "calculated_price": calculated_price,
            "gross_value": gross_value,
        })

    signed_note = _signed_note_amount(payload.get("debit_credit", ""), payload.get("net_amount", "0"))
    purchase_total = sum(
        (op["gross_value"] for op in normalized_ops if op["event_type"] == EventType.COMPRA.value),
        Decimal("0.00"),
    ).quantize(CENTS, rounding=ROUND_HALF_UP)
    sale_total = sum(
        (op["gross_value"] for op in normalized_ops if op["event_type"] == EventType.VENDA.value),
        Decimal("0.00"),
    ).quantize(CENTS, rounding=ROUND_HALF_UP)
    operation_total = (purchase_total + sale_total).quantize(CENTS, rounding=ROUND_HALF_UP)
    operation_difference = (purchase_total - sale_total).quantize(CENTS, rounding=ROUND_HALF_UP)
    total_costs = (signed_note - operation_difference).quantize(CENTS, rounding=ROUND_HALF_UP)
    if total_costs < 0:
        raise BrokerageNoteValidationError("Nota não reconciliada: taxas/custos totais ficaram negativos.")
    allocations = _allocate_costs(normalized_ops, total_costs)

    results: list[dict] = []
    calculated_difference = Decimal("0.00")
    for op, allocation in zip(normalized_ops, allocations):
        if op["event_type"] == EventType.COMPRA.value:
            event_value = (op["gross_value"] + allocation).quantize(CENTS, rounding=ROUND_HALF_UP)
            calculated_difference += event_value
        else:
            event_value = (op["gross_value"] - allocation).quantize(CENTS, rounding=ROUND_HALF_UP)
            if event_value <= 0:
                raise BrokerageNoteValidationError("Rateio gerou valor inválido para venda.")
            calculated_difference -= event_value
        results.append({
            "asset_class": op["asset_class"],
            "ticker": op["ticker"],
            "event_type": op["event_type"],
            "event_date": note_date,
            "quantity": str(op["quantity"]),
            "calculated_price": str(op["calculated_price"]),
            "gross_value": str(op["gross_value"]),
            "allocated_fee": str(allocation),
            "event_value": str(event_value),
        })

    reconciliation_difference = (signed_note - calculated_difference).quantize(CENTS, rounding=ROUND_HALF_UP)
    reconciled = abs(reconciliation_difference) <= CENTS
    return {
        "note": {
            "note_date": note_date,
            "debit_credit": _normalize_dc(payload.get("debit_credit", "")),
            "net_amount": str(_money(payload.get("net_amount", "0"))),
            "signed_net_amount": str(signed_note),
        },
        "summary": {
            "purchase_total": str(purchase_total),
            "sale_total": str(sale_total),
            "operation_total": str(operation_total),
            "operation_difference": str(operation_difference),
            "total_costs": str(total_costs),
            "allocated_fee_total": str(sum(allocations).quantize(CENTS, rounding=ROUND_HALF_UP)),
            "calculated_signed_total": str(calculated_difference.quantize(CENTS, rounding=ROUND_HALF_UP)),
            "reconciliation_difference": str(reconciliation_difference),
            "reconciled": reconciled,
            "messages": [] if reconciled else ["O resultado calculado não fecha com o líquido da nota."],
        },
        "events": results,
    }


def save_brokerage_note(conn, payload: dict, portfolio_id: int) -> dict:
    calculated = calculate_brokerage_note(payload)
    if not calculated["summary"]["reconciled"]:
        raise BrokerageNoteValidationError("A nota precisa estar reconciliada antes de salvar.")
    events = [
        {
            "asset_class": ev["asset_class"],
            "ticker": ev["ticker"],
            "event_type": ev["event_type"],
            "event_date": ev["event_date"],
            "quantity": ev["quantity"],
            "event_value": ev["event_value"],
        }
        for ev in calculated["events"]
    ]
    result = import_events_to_ledger(
        conn,
        events,
        portfolio_id,
        source="brokerage_note",
        notes_prefix="Importado de nota de corretagem",
        source_row_offset=6,
    )
    return {"calculation": calculated, "import_result": result}
