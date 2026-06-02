"""Explicit input normalization helpers for persisted domain values."""

from __future__ import annotations

from enum import Enum
from typing import TypeVar

from backend.domain.enums import (
    AssetClass,
    AssetMatchReviewStatus,
    B3IncomeEventStatus,
    B3MarketPriceStatus,
    B3MonthlyImportStatus,
    Currency,
    EventType,
    Market,
    ReitType,
    TreasuryIndexer,
)


E = TypeVar("E", bound=Enum)


_IMPORTED_ASSET_CLASS_ALIASES = {
    "A\u00e7\u00e3o": AssetClass.ACAO,
    "Acao": AssetClass.ACAO,
    "BDR": AssetClass.BDR,
    "Criptomoeda": AssetClass.CRIPTOMOEDA,
    "Deb\u00eanture": AssetClass.DEBENTURE,
    "Debenture": AssetClass.DEBENTURE,
    "CRI": AssetClass.CRI,
    "CRA": AssetClass.CRA,
    "ETF": AssetClass.ETF,
    "FII": AssetClass.FII,
    "FI-INFRA": AssetClass.FI_INFRA,
    "Tesouro Direto": AssetClass.TESOURO_DIRETO,
    "TD": AssetClass.TESOURO_DIRETO,
    "Stock": AssetClass.STOCK,
    "REIT": AssetClass.REIT,
}

_IMPORTED_EVENT_TYPE_ALIASES = {
    "Compra": EventType.COMPRA,
    "Venda": EventType.VENDA,
    "Desdobramento": EventType.DESDOBRAMENTO,
    "Grupamento": EventType.GRUPAMENTO,
    "Amortiza\u00e7\u00e3o": EventType.AMORTIZACAO,
    "Amortizacao": EventType.AMORTIZACAO,
    "Bonifica\u00e7\u00e3o": EventType.BONIFICACAO,
    "Bonificacao": EventType.BONIFICACAO,
    "Cis\u00e3o": EventType.CISAO,
    "Cisao": EventType.CISAO,
    "Resgate Antecipado": EventType.RESGATE_ANTECIPADO,
    "Resgate Vencimento": EventType.RESGATE_VENCIMENTO,
}


def _strip_required(value: str, field_name: str) -> str:
    text = str(value).strip()
    if not text:
        raise ValueError(f"{field_name} e obrigatorio.")
    return text


def _enum_exact(enum_cls: type[E], value: str, field_name: str) -> str:
    text = _strip_required(value, field_name)
    try:
        return enum_cls(text).value
    except ValueError as exc:
        allowed = ", ".join(item.value for item in enum_cls)
        raise ValueError(f"{field_name} invalido: {text}. Use um dos valores canonicos: {allowed}.") from exc


def normalize_asset_class_strict(value: str) -> str:
    return _enum_exact(AssetClass, value, "Classe do ativo")


def map_imported_asset_class(value: str) -> str:
    text = _strip_required(value, "Classe do ativo importada")
    item = _IMPORTED_ASSET_CLASS_ALIASES.get(text)
    if item is None:
        raise ValueError(f"classe desconhecida '{text}'")
    return item.value


def normalize_event_type_strict(value: str) -> str:
    return _enum_exact(EventType, value, "Tipo de evento")


def map_imported_event_type(value: str) -> str:
    text = _strip_required(value, "Evento importado")
    item = _IMPORTED_EVENT_TYPE_ALIASES.get(text)
    if item is None:
        raise ValueError(f"evento desconhecido '{text}'")
    return item.value


def normalize_ticker(value: str) -> str:
    text = str(value).strip().upper()
    if not text:
        raise ValueError("Ticker e obrigatorio.")
    return text


def normalize_market(value: str | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip().upper()
    if not text:
        return None
    try:
        return Market(text).value
    except ValueError as exc:
        raise ValueError("Mercado deve ser BR ou US.") from exc


def normalize_currency(value: str | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip().upper()
    if not text:
        return None
    try:
        return Currency(text).value
    except ValueError as exc:
        raise ValueError("Moeda deve ser BRL ou USD.") from exc


def normalize_bool_01(value: object) -> int:
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, int) and value in (0, 1):
        return value
    if isinstance(value, str):
        text = value.strip()
        if text in {"0", "1"}:
            return int(text)
    raise ValueError("Booleano persistido deve ser 0 ou 1.")


def normalize_review_status(value: str) -> str:
    return _enum_exact(AssetMatchReviewStatus, value, "Status de revisao")


def normalize_import_status(value: str, enum_cls: type[E]) -> str:
    return _enum_exact(enum_cls, value, "Status de importacao")


def normalize_b3_monthly_import_status(value: str) -> str:
    return normalize_import_status(value, B3MonthlyImportStatus)


def normalize_b3_market_price_status(value: str) -> str:
    return normalize_import_status(value, B3MarketPriceStatus)


def normalize_b3_income_event_status(value: str) -> str:
    return normalize_import_status(value, B3IncomeEventStatus)


def normalize_reit_type(value: str | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return ReitType(text).value
    except ValueError as exc:
        raise ValueError("REIT Type deve ser Equity, Mortgage ou Hybrid.") from exc


def normalize_treasury_indexer(value: str | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip().upper()
    if not text:
        return None
    try:
        return TreasuryIndexer(text).value
    except ValueError as exc:
        raise ValueError("Indexador deve ser SELIC, IPCA ou PREFIXED.") from exc
