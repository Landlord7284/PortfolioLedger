"""
Tax report API router.
"""

from datetime import datetime
from io import BytesIO

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from backend.database import get_db
from backend.models import (
    AssetsAndRightsReportResponse,
    CapitalGainReportResponse,
    ForeignReportResponse,
    IncomeReportResponse,
    ReportYearOptionsResponse,
    TaxExemptIncomeReportResponse,
)
from backend.services import capital_gain_report_service, foreign_report_service, report_service, tax_exempt_income_report_service
from backend.services.portfolio_service import get_portfolio

router = APIRouter(prefix="/api/reports", tags=["reports"])


def _validate_year(year: int) -> int:
    current_year = datetime.now().year
    if year < 1900 or year > current_year + 1:
        raise HTTPException(400, "Ano calendário inválido.")
    return year


@router.get("/year-options", response_model=ReportYearOptionsResponse)
def report_year_options(portfolio_id: int = Query(...)):
    with get_db() as conn:
        if not get_portfolio(conn, portfolio_id):
            raise HTTPException(404, f"Carteira {portfolio_id} não encontrada.")
        return report_service.get_report_year_options(conn, portfolio_id)


@router.get("/assets-and-rights", response_model=AssetsAndRightsReportResponse)
def assets_and_rights(
    portfolio_id: int = Query(...),
    year: int = Query(...),
):
    _validate_year(year)
    with get_db() as conn:
        if not get_portfolio(conn, portfolio_id):
            raise HTTPException(404, f"Carteira {portfolio_id} não encontrada.")
        return report_service.list_assets_and_rights(conn, portfolio_id, year)


@router.get("/income", response_model=IncomeReportResponse)
def income_report(
    portfolio_id: int = Query(...),
    year: int = Query(...),
):
    _validate_year(year)
    with get_db() as conn:
        if not get_portfolio(conn, portfolio_id):
            raise HTTPException(404, f"Carteira {portfolio_id} não encontrada.")
        return report_service.list_income_report(conn, portfolio_id, year)


@router.get("/foreign", response_model=ForeignReportResponse)
def foreign_report(
    portfolio_id: int = Query(...),
    year: int = Query(...),
):
    _validate_year(year)
    with get_db() as conn:
        if not get_portfolio(conn, portfolio_id):
            raise HTTPException(404, f"Carteira {portfolio_id} não encontrada.")
        return foreign_report_service.list_foreign_report(conn, portfolio_id, year)


@router.get("/capital-gains", response_model=CapitalGainReportResponse)
def capital_gains_report(
    portfolio_id: int = Query(...),
    year: int = Query(...),
):
    _validate_year(year)
    with get_db() as conn:
        if not get_portfolio(conn, portfolio_id):
            raise HTTPException(404, f"Carteira {portfolio_id} nÃ£o encontrada.")
        try:
            return capital_gain_report_service.list_capital_gains(conn, portfolio_id, year)
        except ValueError as e:
            raise HTTPException(400, str(e))


@router.get("/tax-exempt-income", response_model=TaxExemptIncomeReportResponse)
def tax_exempt_income_report(
    portfolio_id: int = Query(...),
    year: int = Query(...),
):
    _validate_year(year)
    with get_db() as conn:
        if not get_portfolio(conn, portfolio_id):
            raise HTTPException(404, f"Carteira {portfolio_id} nÃƒÂ£o encontrada.")
        try:
            return tax_exempt_income_report_service.list_tax_exempt_income(conn, portfolio_id, year)
        except ValueError as e:
            raise HTTPException(400, str(e))


@router.get("/assets-and-rights.xlsx")
def assets_and_rights_xlsx(
    portfolio_id: int = Query(...),
    year: int = Query(...),
):
    _validate_year(year)
    with get_db() as conn:
        if not get_portfolio(conn, portfolio_id):
            raise HTTPException(404, f"Carteira {portfolio_id} não encontrada.")
        content = report_service.build_assets_and_rights_xlsx(conn, portfolio_id, year)

    filename = f"bens-e-direitos-{portfolio_id}-{year}.xlsx"
    return StreamingResponse(
        BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/fiscal/export.xlsx")
def fiscal_export_xlsx(
    portfolio_id: int = Query(...),
    year: int = Query(...),
):
    _validate_year(year)
    with get_db() as conn:
        portfolio = get_portfolio(conn, portfolio_id)
        if not portfolio:
            raise HTTPException(404, f"Carteira {portfolio_id} nÃ£o encontrada.")
        content = report_service.build_fiscal_report_xlsx(conn, portfolio_id, year)

    filename = report_service.fiscal_report_filename(year, portfolio["name"])
    return StreamingResponse(
        BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
