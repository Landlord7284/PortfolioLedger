"""
Asset API router.
"""

from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from backend.database import get_db
from backend.models import AssetCreate, AssetTickerUpdate, AssetMetadataUpdate, AssetResponse
from backend.services import asset_service

router = APIRouter(prefix="/api/assets", tags=["assets"])


@router.post("", response_model=AssetResponse)
def create(body: AssetCreate):
    with get_db() as conn:
        try:
            a = asset_service.create_asset(
                conn,
                asset_class=body.asset_class,
                ticker=body.ticker,
                currency=body.currency,
                name=body.name,
                maturity_date=body.maturity_date,
                aux_id=body.aux_id,
                cnpj=body.cnpj,
                isin=body.isin,
                sector=body.sector,
                subsector=body.subsector,
                segment=body.segment,
            )
        except Exception as e:
            raise HTTPException(400, str(e))
    return a


@router.get("", response_model=list[AssetResponse])
def list_all(asset_class: Optional[str] = Query(None)):
    with get_db() as conn:
        return asset_service.list_assets(conn, asset_class)


@router.get("/search", response_model=list[AssetResponse])
def search(q: str = Query(..., min_length=1)):
    with get_db() as conn:
        return asset_service.search_assets(conn, q)


@router.get("/{asset_id}", response_model=AssetResponse)
def get(asset_id: int):
    with get_db() as conn:
        a = asset_service.get_asset(conn, asset_id)
    if not a:
        raise HTTPException(404, "Ativo não encontrado.")
    return a


@router.patch("/{asset_id}", response_model=AssetResponse)
def update_metadata(asset_id: int, body: AssetMetadataUpdate):
    """Update asset metadata fields (name, cnpj, isin, sector, etc.)."""
    with get_db() as conn:
        a = asset_service.get_asset(conn, asset_id)
        if not a:
            raise HTTPException(404, "Ativo não encontrado.")
        try:
            result = asset_service.update_asset_metadata(
                conn, asset_id,
                name=body.name,
                maturity_date=body.maturity_date,
                cnpj=body.cnpj,
                isin=body.isin,
                sector=body.sector,
                subsector=body.subsector,
                segment=body.segment,
            )
        except Exception as e:
            raise HTTPException(400, str(e))
    return result


@router.post("/{asset_id}/tickers", response_model=AssetResponse)
def change_ticker(asset_id: int, body: AssetTickerUpdate):
    with get_db() as conn:
        a = asset_service.get_asset(conn, asset_id)
        if not a:
            raise HTTPException(404, "Ativo não encontrado.")
        try:
            result = asset_service.update_ticker(
                conn, asset_id, body.ticker, body.valid_from, body.name
            )
        except Exception as e:
            raise HTTPException(400, str(e))
    return result
