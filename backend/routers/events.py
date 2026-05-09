"""
Event and position API router.
"""

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from backend.database import get_db
from backend.domain.engine import EngineValidationError
from backend.models import (
    EventCreate,
    EventStorno,
    EventCorrection,
    EventResponse,
    PositionResponse,
    ImportResult,
)
from backend.services import event_service
from backend.services.import_service import import_to_ledger

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
                notes=body.notes,
            )
        except EngineValidationError as e:
            raise HTTPException(422, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))
    return ev


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
                notes=body.notes,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        except EngineValidationError as e:
            raise HTTPException(422, str(e))
    return ev


# ── Import ───────────────────────────────────────────────────

@router.post("/api/import/xlsx", response_model=ImportResult)
def import_xlsx(portfolio_id: int = Query(...)):
    """Import the legacy Dados.xlsx file into a portfolio."""
    xlsx_path = Path(__file__).resolve().parent.parent.parent / "Dados.xlsx"
    if not xlsx_path.exists():
        raise HTTPException(404, f"Arquivo Dados.xlsx não encontrado em {xlsx_path}")

    with get_db() as conn:
        # Verify portfolio exists
        from backend.services.portfolio_service import get_portfolio
        if not get_portfolio(conn, portfolio_id):
            raise HTTPException(404, f"Carteira {portfolio_id} não encontrada.")
        try:
            result = import_to_ledger(conn, xlsx_path, portfolio_id)
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
