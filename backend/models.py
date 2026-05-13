"""
Pydantic models for API request / response schemas.

Financial values are exchanged as strings so the frontend can display them
without floating-point surprises. The domain layer converts to Decimal.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Optional, Any

from pydantic import BaseModel, Field, field_validator


# ── Portfolios ───────────────────────────────────────────────

class PortfolioCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    consolidated: bool = True


class PortfolioUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    consolidated: Optional[bool] = None


class PortfolioResponse(BaseModel):
    id: int
    name: str
    consolidated: bool
    created_at: str
    updated_at: str


# ── Assets ───────────────────────────────────────────────────

class AssetCreate(BaseModel):
    asset_class: str
    market: Optional[str] = None
    currency: Optional[str] = None
    ticker: str = Field(..., min_length=1, max_length=30)
    event_date: Optional[str] = None
    source: Optional[str] = "manual"
    name: Optional[str] = None
    maturity_date: Optional[str] = None
    aux_id: Optional[str] = None
    # v1.0.1 metadata
    cnpj: Optional[str] = None
    isin: Optional[str] = None
    sector: Optional[str] = None
    subsector: Optional[str] = None
    segment: Optional[str] = None
    portfolio_id: Optional[int] = None
    event_type: Optional[str] = None
    quantity: Optional[str] = None
    event_value: Optional[str] = None
    gross_value: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("ticker")
    @classmethod
    def ticker_upper(cls, v: str) -> str:
        return v.strip().upper()


class AssetTickerUpdate(BaseModel):
    ticker: str = Field(..., min_length=1, max_length=30)
    name: Optional[str] = None
    valid_from: str  # ISO date

    @field_validator("ticker")
    @classmethod
    def ticker_upper(cls, v: str) -> str:
        return v.strip().upper()


class AssetMetadataUpdate(BaseModel):
    """PATCH body for updating asset metadata fields."""
    asset_class: Optional[str] = None
    ticker: Optional[str] = None
    name: Optional[str] = None
    maturity_date: Optional[str] = None
    cnpj: Optional[str] = None
    isin: Optional[str] = None
    sector: Optional[str] = None
    subsector: Optional[str] = None
    segment: Optional[str] = None
    market: Optional[str] = None

    @field_validator("ticker")
    @classmethod
    def metadata_ticker_upper(cls, v: Optional[str]) -> Optional[str]:
        return v.strip().upper() if v else v


class AssetResponse(BaseModel):
    id: int
    asset_class: str
    market: str
    currency: str
    maturity_date: Optional[str] = None
    aux_id: Optional[str] = None
    current_ticker: Optional[str] = None
    current_name: Optional[str] = None
    # v1.0.1 metadata
    name: Optional[str] = None
    cnpj: Optional[str] = None
    isin: Optional[str] = None
    sector: Optional[str] = None
    subsector: Optional[str] = None
    segment: Optional[str] = None
    duplicate_flag: bool = False
    merged_into_asset_id: Optional[int] = None
    merged_at: Optional[str] = None
    created_at: str


class AssetTickerResponse(BaseModel):
    id: int
    asset_id: int
    ticker: str
    name: Optional[str] = None
    valid_from: Optional[str] = None
    valid_until: Optional[str] = None
    created_at: str


class AssetMatchReviewResponse(BaseModel):
    id: int
    source: str
    ticker: str
    asset_class: str
    market: Optional[str] = None
    event_date: Optional[str] = None
    candidate_asset_ids: Optional[str] = None
    reason: Optional[str] = None
    operation_payload: Optional[str] = None
    status: str
    created_at: str
    resolved_at: Optional[str] = None


class AssetMergeRequest(BaseModel):
    source_asset_id: int
    target_asset_id: int


class AssetMatchResponse(BaseModel):
    status: str
    asset: Optional[AssetResponse] = None
    review: Optional[AssetMatchReviewResponse] = None
    candidates: list[dict[str, Any]] = []


# ── Events ───────────────────────────────────────────────────

class EventCreate(BaseModel):
    portfolio_id: int
    asset_id: int
    event_type: str
    event_date: str            # ISO date  YYYY-MM-DD
    quantity: str              # Decimal as string
    event_value: str           # Decimal as string
    gross_value: Optional[str] = None  # Decimal as string, only for Venda
    notes: Optional[str] = None


class EventBulkCreate(BaseModel):
    """Body for creating multiple events at once."""
    events: list[EventCreate]


class EventStorno(BaseModel):
    notes: Optional[str] = None


class EventCorrection(BaseModel):
    """Body for correcting an existing event.

    The correction creates a storno of the original and a new replacement
    event with the fields provided here.
    """
    event_type: str
    event_date: str
    quantity: str
    event_value: str
    gross_value: Optional[str] = None
    notes: Optional[str] = None


class EventResponse(BaseModel):
    id: int
    portfolio_id: int
    asset_id: int
    event_type: str
    event_date: str
    quantity: str
    event_value: str
    gross_value: Optional[str] = None
    sequence_num: int
    storno_of: Optional[int] = None
    correction_of: Optional[int] = None
    is_storno: bool
    is_cancelled: bool
    duplicate_flag: bool = False
    realized_event_result: Optional[str] = None
    unit_price: Optional[str] = None
    running_quantity: Optional[str] = None
    running_total_cost: Optional[str] = None
    net_operation_value: Optional[str] = None
    notes: Optional[str] = None
    created_at: str


class EventBulkDeleteRequest(BaseModel):
    """Body for deleting multiple events at once."""
    event_ids: list[int]


# ── Positions ────────────────────────────────────────────────

class PositionResponse(BaseModel):
    portfolio_id: int
    asset_id: int
    asset_class: Optional[str] = None
    market: Optional[str] = None
    currency: Optional[str] = None
    current_ticker: Optional[str] = None
    duplicate_flag: bool = False
    quantity: str
    total_cost: str
    average_price: str
    realized_result: str
    last_event_date: Optional[str] = None
    updated_at: str


# ── Import ───────────────────────────────────────────────────

class ImportResult(BaseModel):
    total_rows: int
    imported: int
    skipped: int
    duplicates: int = 0
    duplicate_details: list[str] = []
    review_count: int = 0
    review_details: list[str] = []
    errors: list[str]


# â”€â”€ Brokerage notes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class BrokerageNoteOperation(BaseModel):
    asset_class: str
    ticker: str = Field(..., min_length=1, max_length=30)
    operation_type: str
    quantity: str
    gross_value: str

    @field_validator("ticker")
    @classmethod
    def brokerage_ticker_upper(cls, v: str) -> str:
        return v.strip().upper()


class BrokerageNoteCalculateRequest(BaseModel):
    note_date: str
    debit_credit: str
    net_amount: str
    operations: list[BrokerageNoteOperation]


class BrokerageNoteSaveRequest(BrokerageNoteCalculateRequest):
    portfolio_id: int


class BrokerageNoteEventPreview(BaseModel):
    asset_class: str
    ticker: str
    event_type: str
    event_date: str
    quantity: str
    calculated_price: str
    gross_value: str
    allocated_fee: str
    event_value: str


class BrokerageNoteSummary(BaseModel):
    purchase_total: str
    sale_total: str
    operation_total: str
    operation_difference: str
    total_costs: str
    allocated_fee_total: str
    calculated_signed_total: str
    reconciliation_difference: str
    reconciled: bool
    messages: list[str] = []


class BrokerageNoteCalculationResponse(BaseModel):
    note: dict[str, Any]
    summary: BrokerageNoteSummary
    events: list[BrokerageNoteEventPreview]


class BrokerageNoteSaveResponse(BaseModel):
    calculation: BrokerageNoteCalculationResponse
    import_result: ImportResult
