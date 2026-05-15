"""
Report service for tax-oriented portfolio views.

Reports are derived from the event ledger by replaying historical cutoffs.
No report values are persisted here.
"""

from __future__ import annotations

from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP
from io import BytesIO
import sqlite3

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

from backend.domain.engine import (
    EngineValidationError,
    EventRecord,
    PositionState,
    process_event,
    replay_events,
)
from backend.domain.enums import AssetClass, EventType

REPORT_ASSET_CLASSES = {
    AssetClass.ACAO.value,
    AssetClass.BDR.value,
    AssetClass.CRIPTOMOEDA.value,
    AssetClass.ETF.value,
    AssetClass.FII.value,
    AssetClass.FI_INFRA.value,
    AssetClass.STOCK.value,
    AssetClass.REIT.value,
}

_ZERO = Decimal("0")


def _money(value: Decimal) -> str:
    return str(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _quantity(value: Decimal) -> str:
    normalized = value.normalize()
    _, _, exponent = normalized.as_tuple()
    if exponent >= 0 or abs(exponent) < 2:
        return str(normalized.quantize(Decimal("0.01")))
    return str(normalized)


def _xlsx_decimal(value: str) -> Decimal:
    return Decimal(value)


def _replay(records: list[EventRecord]) -> PositionState:
    try:
        return replay_events(records)
    except EngineValidationError:
        state = PositionState()
        for event in records:
            process_event(event, state, skip_validation=True)
        return state


def _rows_to_records(rows: list[sqlite3.Row]) -> list[EventRecord]:
    return [
        EventRecord(
            id=row["event_id"],
            event_type=EventType(row["event_type"]),
            event_date=row["event_date"],
            quantity=Decimal(row["quantity"]),
            event_value=Decimal(row["event_value"]),
            sequence_num=row["sequence_num"],
            is_cancelled=bool(row["is_cancelled"]),
            is_storno=bool(row["is_storno"]),
        )
        for row in rows
    ]


def list_assets_and_rights(conn: sqlite3.Connection, portfolio_id: int, year: int) -> dict:
    previous_cutoff = f"{year - 1}-12-31"
    current_cutoff = f"{year}-12-31"
    class_params = sorted(REPORT_ASSET_CLASSES)

    rows = conn.execute(
        f"""
        SELECT
            e.id AS event_id,
            e.asset_id,
            e.event_type,
            e.event_date,
            e.quantity,
            e.event_value,
            e.sequence_num,
            e.is_cancelled,
            e.is_storno,
            a.asset_class,
            a.name,
            a.cnpj,
            (
                SELECT ticker
                FROM asset_tickers
                WHERE asset_id = e.asset_id
                  AND valid_until IS NULL
                ORDER BY valid_from DESC
                LIMIT 1
            ) AS current_ticker
        FROM events e
        JOIN assets a ON a.id = e.asset_id
        WHERE e.portfolio_id = ?
          AND e.event_date <= ?
          AND a.merged_into_asset_id IS NULL
          AND a.asset_class IN ({",".join("?" for _ in class_params)})
        ORDER BY a.asset_class, current_ticker, e.asset_id, e.event_date, e.sequence_num
        """,
        (portfolio_id, current_cutoff, *class_params),
    ).fetchall()

    grouped: dict[int, list[sqlite3.Row]] = defaultdict(list)
    for row in rows:
        grouped[row["asset_id"]].append(row)

    report_rows = []
    for asset_id, asset_rows in grouped.items():
        records = _rows_to_records(asset_rows)
        previous_state = _replay([record for record in records if record.event_date <= previous_cutoff])
        current_state = _replay(records)

        if (
            previous_state.quantity == _ZERO
            and previous_state.total_cost == _ZERO
            and current_state.quantity == _ZERO
            and current_state.total_cost == _ZERO
        ):
            continue

        first = asset_rows[0]
        report_rows.append(
            {
                "asset_id": asset_id,
                "asset_class": first["asset_class"],
                "ticker": first["current_ticker"],
                "quantity": _quantity(current_state.quantity),
                "name": first["name"],
                "cnpj": first["cnpj"],
                "previous_year_cost": _money(previous_state.total_cost),
                "current_year_cost": _money(current_state.total_cost),
            }
        )

    return {
        "portfolio_id": portfolio_id,
        "year": year,
        "previous_cutoff": previous_cutoff,
        "current_cutoff": current_cutoff,
        "rows": report_rows,
    }


def build_assets_and_rights_xlsx(conn: sqlite3.Connection, portfolio_id: int, year: int) -> bytes:
    report = list_assets_and_rights(conn, portfolio_id, year)
    previous_label = f"Situação em {report['previous_cutoff'][8:10]}/{report['previous_cutoff'][5:7]}/{report['previous_cutoff'][0:4]}"
    current_label = f"Situação em {report['current_cutoff'][8:10]}/{report['current_cutoff'][5:7]}/{report['current_cutoff'][0:4]}"

    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = "Bens e Direitos"
    worksheet.append(["CLASSE", "TICKER", "QUANTIDADE", "NOME ATIVO", "CNPJ", previous_label, current_label])

    header_fill = PatternFill("solid", fgColor="D9EAD3")
    for cell in worksheet[1]:
        cell.font = Font(bold=True)
        cell.fill = header_fill

    for row in report["rows"]:
        worksheet.append(
            [
                row["asset_class"] or "",
                row["ticker"] or "",
                _xlsx_decimal(row["quantity"]),
                row["name"] or "",
                row["cnpj"] or "",
                _xlsx_decimal(row["previous_year_cost"]),
                _xlsx_decimal(row["current_year_cost"]),
            ]
        )
        current_row = worksheet.max_row
        worksheet[f"C{current_row}"].number_format = "#,##0.00########"
        worksheet[f"F{current_row}"].number_format = "#,##0.00"
        worksheet[f"G{current_row}"].number_format = "#,##0.00"

    for column_cells in worksheet.columns:
        max_length = max(len(str(cell.value or "")) for cell in column_cells)
        worksheet.column_dimensions[get_column_letter(column_cells[0].column)].width = min(max(max_length + 2, 12), 34)

    output = BytesIO()
    workbook.save(output)
    return output.getvalue()
