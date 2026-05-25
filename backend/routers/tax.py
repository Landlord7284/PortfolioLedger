"""
Fiscal calculation API router.
"""

from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from backend.database import get_db
from backend.models import (
    TaxAnnualSummaryRow,
    TaxEventResponse,
    TaxIncomeCreate,
    TaxSaleApuracaoResponse,
    FiscalTaxParameterCreate,
    FiscalTaxParameterResponse,
    FiscalTaxParameterUpdate,
    IrrfOverrideResponse,
    IrrfOverrideUpsert,
)
from backend.services import ptax_service, tax_service

router = APIRouter(prefix="/api/tax", tags=["tax"])


@router.get("/ptax")
def ptax(date: str = Query(...)):
    with get_db() as conn:
        try:
            rates = ptax_service.get_ptax(date, conn=conn)
            return {
                "date": date,
                "compra": str(rates["compra"]),
                "venda": str(rates["venda"]),
            }
        except ValueError as e:
            raise HTTPException(404, str(e))


@router.post("/sales/{event_id}/apurar", response_model=TaxSaleApuracaoResponse)
def apurar_sale(event_id: int):
    with get_db() as conn:
        try:
            return tax_service.apurar_ganhos_por_evento_id(conn, event_id)
        except ValueError as e:
            raise HTTPException(400, str(e))


@router.post("/income", response_model=TaxEventResponse)
def apurar_income(body: TaxIncomeCreate):
    with get_db() as conn:
        try:
            return tax_service.apurar_rendimento(
                conn,
                portfolio_id=body.portfolio_id,
                asset_id=body.asset_id,
                amount_usd=body.amount_usd,
                credit_date=body.credit_date,
                income_type=body.income_type,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))


@router.get("/events", response_model=list[TaxEventResponse])
def list_events(
    portfolio_id: Optional[int] = Query(None),
    asset_id: Optional[int] = Query(None),
    year: Optional[int] = Query(None),
    tax_event_type: Optional[str] = Query(None),
):
    with get_db() as conn:
        return tax_service.list_tax_events(
            conn,
            portfolio_id=portfolio_id,
            asset_id=asset_id,
            year=year,
            tax_event_type=tax_event_type,
        )


@router.get("/annual", response_model=list[TaxAnnualSummaryRow])
def annual(
    portfolio_id: Optional[int] = Query(None),
    year: Optional[int] = Query(None),
):
    with get_db() as conn:
        return tax_service.annual_summary(conn, portfolio_id=portfolio_id, year=year)


@router.get("/parameters", response_model=list[FiscalTaxParameterResponse])
def list_tax_parameters():
    with get_db() as conn:
        return tax_service.list_tax_parameters(conn)


@router.post("/parameters", response_model=FiscalTaxParameterResponse)
def create_tax_parameter(body: FiscalTaxParameterCreate):
    with get_db() as conn:
        try:
            return tax_service.create_tax_parameter(conn, body.model_dump())
        except ValueError as e:
            raise HTTPException(400, str(e))


@router.patch("/parameters/{parameter_id}", response_model=FiscalTaxParameterResponse)
def update_tax_parameter(parameter_id: int, body: FiscalTaxParameterUpdate):
    with get_db() as conn:
        try:
            return tax_service.update_tax_parameter(
                conn,
                parameter_id,
                body.model_dump(exclude_unset=True),
            )
        except ValueError as e:
            message = str(e)
            status = 404 if "nao encontrado" in message else 400
            raise HTTPException(status, message)


@router.get("/irrf-overrides", response_model=list[IrrfOverrideResponse])
def list_irrf_overrides(
    portfolio_id: int = Query(...),
    year: Optional[int] = Query(None),
):
    with get_db() as conn:
        return tax_service.list_irrf_overrides(conn, portfolio_id=portfolio_id, year=year)


@router.put("/irrf-overrides", response_model=IrrfOverrideResponse)
def upsert_irrf_override(body: IrrfOverrideUpsert):
    with get_db() as conn:
        try:
            return tax_service.upsert_irrf_override(
                conn,
                portfolio_id=body.portfolio_id,
                year_month=body.year_month,
                regime=body.regime,
                effective_irrf=body.effective_irrf,
                notes=body.notes,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))


@router.delete("/irrf-overrides/{override_id}")
def delete_irrf_override(override_id: int):
    with get_db() as conn:
        if not tax_service.delete_irrf_override(conn, override_id):
            raise HTTPException(404, "Override de IRRF nao encontrado.")
    return {"ok": True}
