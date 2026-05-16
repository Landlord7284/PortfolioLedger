"""B3 monthly import API router."""

from fastapi import APIRouter, File, HTTPException, Query, UploadFile

from backend.database import get_db
from backend.models import B3MonthlyImportResponse
from backend.services.b3_monthly_import_service import SourceFile, import_b3_monthly_batch
from backend.services.portfolio_service import get_portfolio

router = APIRouter(prefix="/api/b3", tags=["b3"])


@router.post("/monthly-import", response_model=B3MonthlyImportResponse)
async def import_b3_monthly(
    portfolio_id: int = Query(...),
    files: list[UploadFile] = File(...),
):
    if not files:
        raise HTTPException(400, "Envie ao menos um arquivo .xlsx.")

    sources: list[SourceFile] = []
    for file in files:
        filename = file.filename or ""
        if not filename.lower().endswith(".xlsx"):
            raise HTTPException(400, f"O arquivo {filename or '<sem nome>'} deve ter extensao .xlsx.")
        sources.append(SourceFile(filename=filename, content=await file.read()))

    with get_db() as conn:
        if not get_portfolio(conn, portfolio_id):
            raise HTTPException(404, f"Carteira {portfolio_id} nao encontrada.")
        try:
            return import_b3_monthly_batch(conn, portfolio_id, sources)
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        except Exception as exc:
            raise HTTPException(500, f"Erro na importacao B3: {exc}")
