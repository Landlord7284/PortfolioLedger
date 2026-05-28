"""
Event, import and position API router.
"""

from io import BytesIO
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, UploadFile, File
from fastapi.responses import StreamingResponse

from backend.database import get_db
from backend.domain.engine import EngineValidationError
from backend.models import (
    EventCreate,
    EventBulkCreate,
    EventStorno,
    EventCorrection,
    EventResponse,
    EventBulkDeleteRequest,
    PositionResponse,
    ImportResult,
)
from backend.services import event_service
from backend.services.import_service import (
    IMPORT_TEMPLATE_MEDIA_TYPE,
    build_import_template_xlsx,
    import_to_ledger,
)

router = APIRouter(tags=["events"])


# ── Events ───────────────────────────────────────────────────

@router.post("/api/events", response_model=EventResponse)
def create_event(body: EventCreate):
    with get_db() as conn:
        try:
            ev = event_service.create_event(
                conn,
                portfolio_id=body.portfolio_id,
                asset_id=body.asset_id,
                event_type=body.event_type,
                event_date=body.event_date,
                quantity=body.quantity,
                event_value=body.event_value,
                gross_value=body.gross_value,
                origin_usd=body.origin_usd,
                notes=body.notes,
            )
        except EngineValidationError as e:
            raise HTTPException(422, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))
    return ev


@router.post("/api/events/bulk", response_model=list[EventResponse])
def create_events_bulk(body: EventBulkCreate):
    """Create multiple events in a single transaction."""
    with get_db() as conn:
        try:
            events_data = [
                {
                    "portfolio_id": ev.portfolio_id,
                    "asset_id": ev.asset_id,
                    "event_type": ev.event_type,
                    "event_date": ev.event_date,
                    "quantity": ev.quantity,
                    "event_value": ev.event_value,
                    "gross_value": ev.gross_value,
                    "origin_usd": ev.origin_usd,
                    "notes": ev.notes,
                }
                for ev in body.events
            ]
            results = event_service.create_events_bulk(conn, events_data)
        except EngineValidationError as e:
            raise HTTPException(422, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))
    return results


@router.get("/api/events", response_model=list[EventResponse])
def list_events(
    asset_id: Optional[int] = Query(None),
    portfolio_id: Optional[int] = Query(None),
):
    with get_db() as conn:
        return event_service.list_events(conn, asset_id, portfolio_id)


@router.get("/api/events/{event_id}", response_model=EventResponse)
def get_event(event_id: int):
    with get_db() as conn:
        ev = event_service.get_event(conn, event_id)
    if not ev:
        raise HTTPException(404, "Evento não encontrado.")
    return ev


@router.post("/api/events/{event_id}/storno", response_model=EventResponse)
def storno(event_id: int, body: EventStorno):
    with get_db() as conn:
        try:
            ev = event_service.storno_event(conn, event_id, body.notes)
        except ValueError as e:
            raise HTTPException(400, str(e))
        except EngineValidationError as e:
            raise HTTPException(422, str(e))
    return ev


@router.post("/api/events/{event_id}/correct", response_model=EventResponse)
def correct(event_id: int, body: EventCorrection):
    with get_db() as conn:
        try:
            ev = event_service.correct_event(
                conn,
                event_id,
                event_type=body.event_type,
                event_date=body.event_date,
                quantity=body.quantity,
                event_value=body.event_value,
                gross_value=body.gross_value,
                origin_usd=body.origin_usd,
                notes=body.notes,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        except EngineValidationError as e:
            raise HTTPException(422, str(e))
    return ev


@router.delete("/api/events/{event_id}", response_model=EventResponse)
def delete_event(event_id: int):
    """Soft-delete an event (mark as cancelled) and recalculate position."""
    with get_db() as conn:
        try:
            ev = event_service.delete_event(conn, event_id)
        except ValueError as e:
            raise HTTPException(400, str(e))
        except EngineValidationError as e:
            raise HTTPException(422, str(e))
    return ev


@router.post("/api/events/bulk-delete", response_model=list[EventResponse])
def delete_events_bulk(body: EventBulkDeleteRequest):
    """Soft-delete multiple events and recalculate positions."""
    with get_db() as conn:
        try:
            results = event_service.delete_events_bulk(conn, body.event_ids)
        except ValueError as e:
            raise HTTPException(400, str(e))
        except EngineValidationError as e:
            raise HTTPException(422, str(e))
    return results

@router.post("/api/events/{event_id}/resolve-duplicate")
def resolve_duplicate(event_id: int):
    with get_db() as conn:
        ev = conn.execute("SELECT asset_id FROM events WHERE id = ?", (event_id,)).fetchone()
        if not ev:
            raise HTTPException(404, "Evento não encontrado")
        
        conn.execute("UPDATE events SET duplicate_flag = 0 WHERE id = ?", (event_id,))
        
        # Check if asset has other duplicates
        asset_id = ev["asset_id"]
        other_dup = conn.execute(
            "SELECT 1 FROM events WHERE asset_id = ? AND duplicate_flag = 1 AND is_cancelled = 0 LIMIT 1",
            (asset_id,)
        ).fetchone()
        if not other_dup:
            conn.execute("UPDATE assets SET duplicate_flag = 0 WHERE id = ?", (asset_id,))
            
        return {"ok": True}


# ── Import ───────────────────────────────────────────────────

@router.get("/api/import/template.xlsx")
def import_template_xlsx(template: str = Query(...)):
    """Download an XLSX template compatible with the import parser."""
    try:
        content = build_import_template_xlsx(template)
    except ValueError as e:
        raise HTTPException(400, str(e))

    filename = f"modelo-importacao-posicoes-{template.lower().strip()}.xlsx"
    return StreamingResponse(
        BytesIO(content),
        media_type=IMPORT_TEMPLATE_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

@router.post("/api/import/xlsx", response_model=ImportResult)
async def import_xlsx(
    portfolio_id: int = Query(...),
    file: UploadFile = File(...),
):
    """Import an XLSX file with events into a portfolio."""
    if not file.filename.endswith(".xlsx"):
        raise HTTPException(400, "O arquivo deve ter extensão .xlsx")

    content = await file.read()
    source = BytesIO(content)

    with get_db() as conn:
        # Verify portfolio exists
        from backend.services.portfolio_service import get_portfolio
        if not get_portfolio(conn, portfolio_id):
            raise HTTPException(404, f"Carteira {portfolio_id} não encontrada.")
        try:
            result = import_to_ledger(conn, source, portfolio_id)
        except ImportError as e:
            raise HTTPException(422, str(e))
        except Exception as e:
            raise HTTPException(500, f"Erro na importação: {e}")
    return result


# ── Positions ────────────────────────────────────────────────

@router.get("/api/positions", response_model=list[PositionResponse])
def list_positions(portfolio_id: Optional[int] = Query(None)):
    with get_db() as conn:
        return event_service.list_positions(conn, portfolio_id)


@router.get("/api/positions/{portfolio_id}/{asset_id}", response_model=PositionResponse)
def get_position(portfolio_id: int, asset_id: int):
    with get_db() as conn:
        pos = event_service.get_position(conn, portfolio_id, asset_id)
    if not pos:
        raise HTTPException(404, "Posição não encontrada.")
    return pos
