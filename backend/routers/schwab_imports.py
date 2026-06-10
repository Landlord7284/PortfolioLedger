"""Schwab/TDA JSON import API router."""

from fastapi import APIRouter, File, HTTPException, Query, UploadFile

from backend.database import get_db
from backend.models import SchwabImportResponse, SchwabTransactionReviewDecision, SchwabTransactionReviewResponse
from backend.services.portfolio_service import get_portfolio
from backend.services.schwab_import_service import (
    SourceFile,
    accept_transaction_review,
    confirm_transaction_duplicate,
    ignore_transaction_review,
    import_schwab_json_batch,
    list_transaction_reviews,
)


router = APIRouter(prefix="/api/schwab", tags=["schwab"])


@router.post("/import", response_model=SchwabImportResponse)
async def import_schwab_json(
    portfolio_id: int = Query(...),
    files: list[UploadFile] = File(...),
    account_key: str | None = Query(None),
):
    if not files:
        raise HTTPException(400, "Envie ao menos um arquivo .json.")

    sources: list[SourceFile] = []
    for file in files:
        filename = file.filename or ""
        if not filename.lower().endswith(".json"):
            raise HTTPException(400, f"O arquivo {filename or '<sem nome>'} deve ter extensao .json.")
        sources.append(SourceFile(filename=filename, content=await file.read(), account_key=account_key))

    with get_db() as conn:
        if not get_portfolio(conn, portfolio_id):
            raise HTTPException(404, f"Carteira {portfolio_id} nao encontrada.")
        try:
            return import_schwab_json_batch(conn, portfolio_id, sources)
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        except Exception as exc:
            raise HTTPException(500, f"Erro na importacao Schwab/TDA: {exc}")


@router.get("/reviews", response_model=list[SchwabTransactionReviewResponse])
def list_schwab_reviews(
    portfolio_id: int | None = Query(None),
    status: str = Query("review"),
):
    with get_db() as conn:
        return list_transaction_reviews(conn, portfolio_id, status)


@router.post("/reviews/{transaction_id}/ignore", response_model=SchwabTransactionReviewResponse)
def ignore_schwab_review(transaction_id: int):
    with get_db() as conn:
        try:
            return ignore_transaction_review(conn, transaction_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))


@router.post("/reviews/{transaction_id}/confirm-duplicate", response_model=SchwabTransactionReviewResponse)
def confirm_schwab_duplicate(transaction_id: int, body: SchwabTransactionReviewDecision | None = None):
    with get_db() as conn:
        try:
            return confirm_transaction_duplicate(conn, transaction_id, body.ledger_event_id if body else None)
        except ValueError as exc:
            raise HTTPException(400, str(exc))


@router.post("/reviews/{transaction_id}/accept", response_model=SchwabTransactionReviewResponse)
def accept_schwab_review(transaction_id: int, body: SchwabTransactionReviewDecision | None = None):
    with get_db() as conn:
        try:
            return accept_transaction_review(conn, transaction_id, body.model_dump(exclude_none=True) if body else {})
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        except Exception as exc:
            raise HTTPException(422, str(exc))
