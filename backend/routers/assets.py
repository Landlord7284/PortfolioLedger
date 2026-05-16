"""
Asset API router.
"""

from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from backend.database import get_db
from backend.models import (
    AssetCreate,
    AssetTickerUpdate,
    AssetMetadataUpdate,
    AssetResponse,
    AssetTickerResponse,
    AssetMatchReviewResponse,
    AssetMergeRequest,
)
from backend.services import asset_service

router = APIRouter(prefix="/api/assets", tags=["assets"])


@router.post("", response_model=AssetResponse)
def create(body: AssetCreate):
    error: Exception | None = None
    asset = None
    with get_db() as conn:
        try:
            asset = asset_service.create_asset(
                conn,
                asset_class=body.asset_class,
                ticker=body.ticker,
                currency=body.currency,
                market=body.market,
                name=body.name,
                maturity_date=body.maturity_date,
                aux_id=body.aux_id,
                cnpj=body.cnpj,
                isin=body.isin,
                sector=body.sector,
                subsector=body.subsector,
                segment=body.segment,
                event_date=body.event_date,
                portfolio_id=body.portfolio_id,
                event_type=body.event_type,
                quantity=body.quantity,
                event_value=body.event_value,
                gross_value=body.gross_value,
                origin_usd=body.origin_usd,
                notes=body.notes,
                source=body.source or "manual",
            )
        except Exception as e:
            # Keep match-review records created by the service, then return the
            # controlled error after the transaction context commits.
            error = e
    if error:
        raise HTTPException(400, str(error))
    return asset


@router.get("", response_model=list[AssetResponse])
def list_all(asset_class: Optional[str] = Query(None), include_merged: bool = Query(False)):
    with get_db() as conn:
        return asset_service.list_assets(conn, asset_class, include_merged)


@router.get("/reviews", response_model=list[AssetMatchReviewResponse])
def list_reviews(status: str = Query("pending")):
    with get_db() as conn:
        return asset_service.list_match_reviews(conn, status)


@router.post("/reviews/{review_id}/resolve", response_model=AssetMatchReviewResponse)
def resolve_review(review_id: int):
    with get_db() as conn:
        review = asset_service.resolve_match_review(conn, review_id)
    if not review:
        raise HTTPException(404, "Revisão não encontrada.")
    return review


@router.post("/reviews/{review_id}/create-asset", response_model=AssetResponse)
def create_asset_from_review(review_id: int):
    with get_db() as conn:
        try:
            return asset_service.create_asset_from_review(conn, review_id)
        except Exception as e:
            raise HTTPException(400, str(e))


@router.post("/merge", response_model=AssetResponse)
def merge_assets(body: AssetMergeRequest):
    with get_db() as conn:
        try:
            return asset_service.merge_assets(conn, body.source_asset_id, body.target_asset_id)
        except Exception as e:
            raise HTTPException(400, str(e))


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
                asset_class=body.asset_class,
                ticker=body.ticker,
                name=body.name,
                maturity_date=body.maturity_date,
                cnpj=body.cnpj,
                isin=body.isin,
                sector=body.sector,
                subsector=body.subsector,
                segment=body.segment,
                market=body.market,
            )
        except Exception as e:
            raise HTTPException(400, str(e))
    return result


@router.get("/{asset_id}/tickers", response_model=list[AssetTickerResponse])
def list_tickers(asset_id: int):
    with get_db() as conn:
        if not asset_service.get_asset(conn, asset_id):
            raise HTTPException(404, "Ativo não encontrado.")
        return asset_service.list_asset_tickers(conn, asset_id)


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

@router.delete("/{asset_id}")
def delete_asset(asset_id: int):
    with get_db() as conn:
        if not asset_service.get_asset(conn, asset_id):
            raise HTTPException(404, "Ativo não encontrado.")
        try:
            asset_service.delete_asset(conn, asset_id)
        except Exception as e:
            raise HTTPException(400, str(e))
    return {"ok": True}
