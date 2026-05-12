"""
Brokerage note calculation and save API router.
"""

from fastapi import APIRouter, HTTPException

from backend.database import get_db
from backend.models import (
    BrokerageNoteCalculateRequest,
    BrokerageNoteCalculationResponse,
    BrokerageNoteSaveRequest,
    BrokerageNoteSaveResponse,
)
from backend.services.brokerage_note_service import (
    BrokerageNoteValidationError,
    calculate_brokerage_note,
    save_brokerage_note,
)

router = APIRouter(prefix="/api/brokerage-notes", tags=["brokerage-notes"])


@router.post("/calculate", response_model=BrokerageNoteCalculationResponse)
def calculate(body: BrokerageNoteCalculateRequest):
    try:
        return calculate_brokerage_note(body.model_dump())
    except BrokerageNoteValidationError as e:
        raise HTTPException(422, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/save", response_model=BrokerageNoteSaveResponse)
def save(body: BrokerageNoteSaveRequest):
    with get_db() as conn:
        from backend.services.portfolio_service import get_portfolio

        if not get_portfolio(conn, body.portfolio_id):
            raise HTTPException(404, f"Carteira {body.portfolio_id} não encontrada.")
        try:
            return save_brokerage_note(conn, body.model_dump(), body.portfolio_id)
        except BrokerageNoteValidationError as e:
            raise HTTPException(422, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))
