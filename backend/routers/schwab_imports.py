"""Schwab/TDA JSON import API router."""

from fastapi import APIRouter, File, HTTPException, Query, UploadFile

from backend.database import get_db
from backend.models import SchwabImportResponse
from backend.services.portfolio_service import get_portfolio
from backend.services.schwab_import_service import SourceFile, import_schwab_json_batch


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
