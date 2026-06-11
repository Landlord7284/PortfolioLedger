"""B3 monthly import API router."""

from typing import Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile

from backend.database import get_db
from backend.models import (
    B3IncomePendingResolveRequest,
    B3IncomePendingResponse,
    B3IncomeReportResponse,
    B3MonthlyImportResponse,
    B3MonthlySanitizeResponse,
)
from backend.services import b3_income_service, b3_monthly_import_service
from backend.services.b3_monthly_import_service import SourceFile, import_b3_monthly_batch, sanitize_b3_monthly_import
from backend.services.portfolio_service import get_portfolio

router = APIRouter(prefix="/api/b3", tags=["b3"])


def _parse_optional_int_filter(value: Optional[str], field: str) -> int | None:
    if value in (None, "", "all"):
        return None
    try:
        return int(value)
    except ValueError as exc:
        raise HTTPException(422, f"{field} invalido.") from exc


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
    chart_group_by: str = Query("asset_class", pattern="^(asset|asset_class|event_type)$"),
    table_year: Optional[str] = Query(None),
    table_month: Optional[str] = Query(None),
    table_asset_class: Optional[str] = Query(None),
    table_asset_id: Optional[str] = Query(None),
    table_event_type: Optional[str] = Query(None),
):
    parsed_table_year = _parse_optional_int_filter(table_year, "table_year")
    parsed_table_month = _parse_optional_int_filter(table_month, "table_month")
    parsed_table_asset_id = _parse_optional_int_filter(table_asset_id, "table_asset_id")
    if parsed_table_month is not None and not 1 <= parsed_table_month <= 12:
        raise HTTPException(422, "table_month invalido.")

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
                chart_group_by=chart_group_by,
                table_year=parsed_table_year,
                table_month=parsed_table_month,
                table_asset_class=table_asset_class,
                table_asset_id=parsed_table_asset_id,
                table_event_type=None if table_event_type in (None, "", "all") else table_event_type,
                use_default_table_period=table_year is None and table_month is None,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc))


@router.get("/income-pendings", response_model=list[B3IncomePendingResponse])
def list_b3_income_pendings(
    portfolio_id: int = Query(...),
    status: str = Query("pending", pattern="^(pending|resolved|discarded|all)$"),
):
    with get_db() as conn:
        if not get_portfolio(conn, portfolio_id):
            raise HTTPException(404, f"Carteira {portfolio_id} nao encontrada.")
        try:
            return b3_monthly_import_service.list_income_pendings(conn, portfolio_id, status)
        except ValueError as exc:
            raise HTTPException(400, str(exc))


@router.post("/income-pendings/{income_id}/resolve", response_model=B3IncomePendingResponse)
def resolve_b3_income_pending(income_id: int, body: B3IncomePendingResolveRequest):
    with get_db() as conn:
        try:
            return b3_monthly_import_service.resolve_income_pending(conn, income_id, body.asset_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))


@router.post("/income-pendings/{income_id}/discard", response_model=B3IncomePendingResponse)
def discard_b3_income_pending(income_id: int):
    with get_db() as conn:
        try:
            return b3_monthly_import_service.discard_income_pending(conn, income_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))


@router.delete("/monthly-import", response_model=B3MonthlySanitizeResponse)
def sanitize_b3_monthly(
    portfolio_id: int = Query(...),
    reference_month: str = Query(..., pattern=r"^\d{4}-\d{2}$"),
    remove_manual_resolutions: bool = Query(False),
):
    with get_db() as conn:
        if not get_portfolio(conn, portfolio_id):
            raise HTTPException(404, f"Carteira {portfolio_id} nao encontrada.")
        try:
            return sanitize_b3_monthly_import(conn, portfolio_id, reference_month, remove_manual_resolutions)
        except ValueError as exc:
            raise HTTPException(422, str(exc))
