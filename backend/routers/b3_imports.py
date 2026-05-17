"""B3 monthly import API router."""

from typing import Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile

from backend.database import get_db
from backend.models import B3IncomeReportResponse, B3MonthlyImportResponse
from backend.services import b3_income_service
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


@router.get("/incomes", response_model=B3IncomeReportResponse)
def list_b3_incomes(
    portfolio_id: int = Query(...),
    period: str = Query("year", pattern="^(year|12m|24m|36m|all)$"),
    asset_id: Optional[int] = Query(None),
    asset_class: Optional[str] = Query(None),
    event_type: Optional[str] = Query(None),
    table_year: Optional[int] = Query(None),
    table_month: Optional[int] = Query(None, ge=1, le=12),
):
    with get_db() as conn:
        if not get_portfolio(conn, portfolio_id):
            raise HTTPException(404, f"Carteira {portfolio_id} nao encontrada.")
        try:
            return b3_income_service.list_b3_incomes(
                conn,
                portfolio_id=portfolio_id,
                period=period,
                asset_id=asset_id,
                asset_class=asset_class,
                event_type=event_type,
                table_year=table_year,
                table_month=table_month,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc))
