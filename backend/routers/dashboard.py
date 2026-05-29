"""Patrimonial dashboard API router."""

from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from backend.database import get_db
from backend.models import DashboardResponse
from backend.services import dashboard_service
from backend.services.portfolio_service import get_portfolio


router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


@router.get("", response_model=DashboardResponse)
def get_dashboard(
    portfolio_id: int = Query(...),
    period: str = Query("year", pattern="^(year|12m|24m|36m|all)$"),
    asset_class: Optional[str] = Query(None),
):
    with get_db() as conn:
        if not get_portfolio(conn, portfolio_id):
            raise HTTPException(404, f"Carteira {portfolio_id} não encontrada.")
        try:
            return dashboard_service.get_dashboard(
                conn,
                portfolio_id=portfolio_id,
                period=period,
                asset_class=asset_class,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc))
