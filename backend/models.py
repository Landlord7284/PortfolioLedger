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
    fiscal_regime_override: Optional[str] = None
    fiscal_tax_treatment: Optional[str] = None
    portfolio_id: Optional[int] = None
    event_type: Optional[str] = None
    quantity: Optional[str] = None
    event_value: Optional[str] = None
    gross_value: Optional[str] = None
    origin_usd: Optional[str] = None
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
    fiscal_regime_override: Optional[str] = None
    fiscal_tax_treatment: Optional[str] = None

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
    fiscal_regime_override: Optional[str] = None
    fiscal_tax_treatment: Optional[str] = None
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
    origin_usd: Optional[str] = None  # Decimal as string, only for PRE_2024 USD Compra
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
    origin_usd: Optional[str] = None
    notes: Optional[str] = None


class EventResponse(BaseModel):
    id: int
    portfolio_id: int
    asset_id: int
    event_type: str
    event_date: str
    quantity: str
    event_value: str
    event_value_brl: Optional[str] = None
    gross_value: Optional[str] = None
    gross_value_brl: Optional[str] = None
    ptax_compra: Optional[str] = None
    ptax_venda: Optional[str] = None
    sequence_num: int
    storno_of: Optional[int] = None
    correction_of: Optional[int] = None
    is_storno: bool
    is_cancelled: bool
    duplicate_flag: bool = False
    realized_event_result: Optional[str] = None
    unit_price: Optional[str] = None
    unit_price_brl: Optional[str] = None
    running_quantity: Optional[str] = None
    running_total_cost: Optional[str] = None
    running_total_cost_original: Optional[str] = None
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
    total_cost_original: Optional[str] = None
    average_price_original: Optional[str] = None
    realized_result_original: Optional[str] = None
    last_event_date: Optional[str] = None
    updated_at: str


# ── Reports ─────────────────────────────────────────────────

class AssetsAndRightsRow(BaseModel):
    asset_id: int
    asset_class: str
    ticker: Optional[str] = None
    quantity: str
    name: Optional[str] = None
    cnpj: Optional[str] = None
    previous_year_cost: str
    current_year_cost: str


class AssetsAndRightsReportResponse(BaseModel):
    portfolio_id: int
    year: int
    previous_cutoff: str
    current_cutoff: str
    rows: list[AssetsAndRightsRow]


class IncomeReportRow(BaseModel):
    id: str
    ticker: Optional[str] = None
    payer_cnpj: Optional[str] = None
    payer_name: Optional[str] = None
    income_type: str
    value: str


class IncomeReportTable(BaseModel):
    key: str
    title: str
    rows: list[IncomeReportRow]
    total: str


class IncomeReportResponse(BaseModel):
    portfolio_id: int
    year: int
    tables: list[IncomeReportTable]


class CapitalGainAssetRow(BaseModel):
    asset_id: int
    manual_event_id: Optional[int] = None
    is_manual: bool = False
    ticker: Optional[str] = None
    asset_class: str
    fiscal_regime: str
    gross_sale: str
    net_sale: str
    costs: str
    cost_basis: str
    realized_result: str
    exempt_gain: str
    taxable_result_before_compensation: str
    theoretical_irrf: str
    effective_irrf: str


class CapitalGainRegimeRow(BaseModel):
    regime: str
    bucket: Optional[str] = None
    darf_code: Optional[str] = None
    gross_sale: str
    net_sale: str
    costs: str
    cost_basis: str
    realized_result: str
    exempt_gain: str
    taxable_result_before_compensation: str
    initial_loss_carryforward: str
    used_loss: str
    taxable_base: str
    tax_rate: str
    tax_due: str
    theoretical_irrf: str
    irrf_override: Optional[str] = None
    effective_irrf: str
    calculated_net_tax_payable: str
    manual_tax_paid: Optional[str] = None
    minimum_darf_amount: str
    initial_darf_carryforward: str
    darf_before_minimum: str
    darf_estimated: str
    final_darf_carryforward: str
    initial_irrf_carryforward: str
    used_irrf: str
    net_tax_payable: str
    final_irrf_carryforward: str
    final_loss_carryforward: str
    assets: list[CapitalGainAssetRow]


class CapitalGainDarfSuggestion(BaseModel):
    darf_code: str
    regime: str
    included_regimes: list[str]
    initial_darf_carryforward: str
    current_month_net_tax: str
    darf_before_minimum: str
    minimum_darf_amount: str
    darf_estimated: str
    final_darf_carryforward: str


class CapitalGainMonthRow(BaseModel):
    year_month: str
    month: int
    regimes: list[CapitalGainRegimeRow]
    darf_suggestions: list[CapitalGainDarfSuggestion] = Field(default_factory=list)


class CapitalGainReportResponse(BaseModel):
    portfolio_id: int
    year: int
    months: list[CapitalGainMonthRow]


class TaxExemptIncomeSourceEvent(BaseModel):
    event_id: int
    event_date: str
    source_event_type: str
    amount: str
    year_month: str


class TaxExemptIncomeAssetRow(BaseModel):
    asset_id: int
    ticker: Optional[str] = None
    asset_class: str
    fiscal_regime: str
    amount: str
    source_event_type: Optional[str] = None
    year_month: str
    source_events: list[TaxExemptIncomeSourceEvent] = Field(default_factory=list)


class TaxExemptIncomeMonthRow(BaseModel):
    year_month: str
    month: int
    total: str
    assets: list[TaxExemptIncomeAssetRow]


class TaxExemptIncomeGroup(BaseModel):
    source: str
    label: str
    total: str
    months: list[TaxExemptIncomeMonthRow]


class TaxExemptIncomeReportResponse(BaseModel):
    portfolio_id: int
    year: int
    total: str
    groups: list[TaxExemptIncomeGroup]


# ── Tax ──────────────────────────────────────────────────────

class TaxEventResponse(BaseModel):
    id: int
    tax_event_type: str
    portfolio_id: Optional[int] = None
    asset_id: Optional[int] = None
    sale_event_id: Optional[int] = None
    lot_id: Optional[int] = None
    qty_sold: Optional[str] = None
    ganho_brl: Optional[str] = None
    regime: str
    ptax_used: str
    income_type: Optional[str] = None
    credit_date: Optional[str] = None
    amount_usd: Optional[str] = None
    amount_brl: Optional[str] = None
    calculated_at: str


class TaxSaleApuracaoResponse(BaseModel):
    sale_event_id: int
    total_ganho_brl: str
    events: list[TaxEventResponse]


class TaxIncomeCreate(BaseModel):
    portfolio_id: int
    asset_id: int
    amount_usd: str
    credit_date: str
    income_type: Optional[str] = None


class TaxAnnualSummaryRow(BaseModel):
    year: Optional[int] = None
    tax_event_type: str
    regime: str
    income_type: Optional[str] = None
    total_ganho_brl: str
    total_amount_brl: str
    event_count: int


class IrrfOverrideUpsert(BaseModel):
    portfolio_id: int
    year_month: str
    regime: str
    effective_irrf: str
    notes: Optional[str] = None


class IrrfOverrideResponse(BaseModel):
    id: int
    portfolio_id: int
    year_month: str
    regime: str
    effective_irrf: str
    notes: Optional[str] = None
    created_at: str
    updated_at: str


class CapitalGainTaxPaidOverrideUpsert(BaseModel):
    portfolio_id: int
    year_month: str
    regime: str
    manual_tax_paid: str


class CapitalGainTaxPaidOverrideResponse(BaseModel):
    id: int
    portfolio_id: int
    year_month: str
    regime: str
    manual_tax_paid: str
    created_at: str
    updated_at: str


class CapitalGainManualEventCreate(BaseModel):
    portfolio_id: int
    year_month: str
    regime: str
    ticker: str = Field(..., min_length=1, max_length=60)
    gross_sale: str
    realized_result: str

    @field_validator("ticker")
    @classmethod
    def manual_event_ticker_upper(cls, v: str) -> str:
        return v.strip().upper()


class CapitalGainManualEventUpdate(BaseModel):
    ticker: Optional[str] = Field(None, min_length=1, max_length=60)
    gross_sale: Optional[str] = None
    realized_result: Optional[str] = None

    @field_validator("ticker")
    @classmethod
    def manual_event_ticker_update_upper(cls, v: str | None) -> str | None:
        return v.strip().upper() if v is not None else None


class CapitalGainManualEventResponse(BaseModel):
    id: int
    portfolio_id: int
    year_month: str
    regime: str
    ticker: str
    gross_sale: str
    realized_result: str
    created_at: str
    updated_at: str


class FiscalTaxParameterCreate(BaseModel):
    regime: str = Field(..., min_length=1, max_length=80)
    valid_from: str
    valid_until: Optional[str] = None
    tax_rate: str = "0"
    withholding_rate: str = "0"
    exemption_limit: Optional[str] = None
    darf_code: Optional[str] = None
    minimum_darf_amount: str = "10.00"
    loss_bucket: Optional[str] = None
    active: bool = True
    monthly_darf_enabled: bool = True

    @field_validator("regime", "darf_code", "loss_bucket")
    @classmethod
    def strip_text(cls, v: Optional[str]) -> Optional[str]:
        return v.strip() if v else v


class FiscalTaxParameterUpdate(BaseModel):
    regime: Optional[str] = Field(None, min_length=1, max_length=80)
    valid_from: Optional[str] = None
    valid_until: Optional[str] = None
    tax_rate: Optional[str] = None
    withholding_rate: Optional[str] = None
    exemption_limit: Optional[str] = None
    darf_code: Optional[str] = None
    minimum_darf_amount: Optional[str] = None
    loss_bucket: Optional[str] = None
    active: Optional[bool] = None
    monthly_darf_enabled: Optional[bool] = None

    @field_validator("regime", "darf_code", "loss_bucket")
    @classmethod
    def strip_update_text(cls, v: Optional[str]) -> Optional[str]:
        return v.strip() if v else v


class FiscalTaxParameterResponse(BaseModel):
    id: int
    regime: str
    valid_from: str
    valid_until: Optional[str] = None
    tax_rate: str
    withholding_rate: str
    exemption_limit: Optional[str] = None
    darf_code: Optional[str] = None
    minimum_darf_amount: str
    loss_bucket: Optional[str] = None
    active: bool
    monthly_darf_enabled: bool
    created_at: str
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


class B3MonthlyFileResult(BaseModel):
    filename: str
    reference_month: str
    reference_date: str
    total_rows: int
    imported_prices: int
    imported_incomes: int
    auto_events_created: int
    duplicates: int = 0
    duplicate_details: list[str] = []
    review_count: int = 0
    review_details: list[str] = []
    errors: list[str] = []


class B3MonthlyImportResponse(BaseModel):
    portfolio_id: int
    files_processed: int
    total_rows: int
    imported_prices: int
    imported_incomes: int
    auto_events_created: int
    duplicates: int = 0
    review_count: int = 0
    errors: list[str] = []
    files: list[B3MonthlyFileResult]


class B3MonthlySanitizeResponse(BaseModel):
    portfolio_id: int
    reference_month: str
    imports_removed: int
    market_prices_removed: int
    income_events_removed: int
    ledger_events_cancelled: int


class B3IncomeSummary(BaseModel):
    total_net_value: str
    monthly_average: str
    period_start: str
    period_end: str
    month_count: int


class B3IncomeAssetFilter(BaseModel):
    asset_id: int
    ticker: Optional[str] = None
    name: Optional[str] = None
    asset_class: Optional[str] = None


class B3IncomeYearFilter(BaseModel):
    year: int
    months: list[int]


class B3IncomeFilters(BaseModel):
    assets: list[B3IncomeAssetFilter]
    asset_classes: list[str]
    event_types: list[str]
    years: list[B3IncomeYearFilter]
    default_year: Optional[int] = None
    default_month: Optional[int] = None


class B3IncomeChartSegment(BaseModel):
    key: str
    value: str


class B3IncomeChartTopEvent(BaseModel):
    label: str
    name: Optional[str] = None
    event_type: str
    value: str
    share: str


class B3IncomeChartMonth(BaseModel):
    month: str
    total_net_value: str
    segments: list[B3IncomeChartSegment]
    top_events: list[B3IncomeChartTopEvent]


class B3IncomeChart(BaseModel):
    segment_keys: list[str]
    months: list[B3IncomeChartMonth]


class B3IncomeTableRow(BaseModel):
    id: int
    asset_id: Optional[int] = None
    ticker: Optional[str] = None
    name: Optional[str] = None
    asset_class: Optional[str] = None
    payment_date: str
    event_type: str
    quantity: str
    net_value: str
    status: str


class B3IncomeTable(BaseModel):
    year: Optional[int] = None
    month: Optional[int] = None
    total_net_value: str
    rows: list[B3IncomeTableRow]


class B3IncomeReportResponse(BaseModel):
    portfolio_id: int
    period: str
    summary: B3IncomeSummary
    filters: B3IncomeFilters
    chart: B3IncomeChart
    table: B3IncomeTable


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
