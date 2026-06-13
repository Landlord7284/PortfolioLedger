"""Portfolio performance API router."""

from fastapi import APIRouter, HTTPException, Query

from backend.database import get_db
from backend.models import TwrResponse
from backend.services import performance_service
from backend.services.portfolio_service import get_portfolio


router = APIRouter(prefix="/api/performance", tags=["performance"])


@router.get("/twr", response_model=TwrResponse)
def get_twr(
    portfolio_id: int = Query(...),
    period: str = Query("year", pattern="^(year|12m|24m|36m|all)$"),
):
    with get_db() as conn:
        if not get_portfolio(conn, portfolio_id):
            raise HTTPException(404, f"Carteira {portfolio_id} nao encontrada.")
        try:
            return performance_service.get_twr(conn, portfolio_id=portfolio_id, period=period)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
