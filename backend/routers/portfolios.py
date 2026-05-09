"""
Portfolio API router.
"""

from fastapi import APIRouter, HTTPException

from backend.database import get_db
from backend.models import PortfolioCreate, PortfolioUpdate, PortfolioResponse
from backend.services import portfolio_service

router = APIRouter(prefix="/api/portfolios", tags=["portfolios"])


@router.post("", response_model=PortfolioResponse)
def create(body: PortfolioCreate):
    with get_db() as conn:
        try:
            p = portfolio_service.create_portfolio(conn, body.name, body.consolidated)
        except Exception as e:
            raise HTTPException(400, str(e))
    return p


@router.get("", response_model=list[PortfolioResponse])
def list_all():
    with get_db() as conn:
        return portfolio_service.list_portfolios(conn)


@router.get("/{portfolio_id}", response_model=PortfolioResponse)
def get(portfolio_id: int):
    with get_db() as conn:
        p = portfolio_service.get_portfolio(conn, portfolio_id)
    if not p:
        raise HTTPException(404, "Carteira não encontrada.")
    return p


@router.patch("/{portfolio_id}", response_model=PortfolioResponse)
def update(portfolio_id: int, body: PortfolioUpdate):
    with get_db() as conn:
        p = portfolio_service.update_portfolio(
            conn, portfolio_id, body.name, body.consolidated
        )
    if not p:
        raise HTTPException(404, "Carteira não encontrada.")
    return p


@router.delete("/{portfolio_id}")
def delete(portfolio_id: int):
    with get_db() as conn:
        try:
            ok = portfolio_service.delete_portfolio(conn, portfolio_id)
        except ValueError as e:
            raise HTTPException(400, str(e))
    if not ok:
        raise HTTPException(404, "Carteira não encontrada.")
    return {"ok": True}
