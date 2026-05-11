"""
Enumerations for Portfolio Ledger domain.

AssetClass, EventType and Currency are the canonical enums used throughout
the backend. Their `.value` matches the user-facing Portuguese labels stored
in the database and exchanged with the frontend.
"""

from enum import Enum


class AssetClass(str, Enum):
    ACAO = "Ação"
    BDR = "BDR"
    CRIPTOMOEDA = "Criptomoeda"
    DEBENTURE = "Debênture"
    CRI = "CRI"
    CRA = "CRA"
    ETF = "ETF"
    FII = "FII"
    FI_INFRA = "FI-INFRA"
    TESOURO_DIRETO = "Tesouro Direto"
    STOCK = "Stock"
    REIT = "REIT"

    # ── helpers ──────────────────────────────────────────────
    @classmethod
    def national_classes(cls) -> set["AssetClass"]:
        """Classes whose default currency is BRL."""
        return {
            cls.ACAO, cls.BDR, cls.CRIPTOMOEDA, cls.DEBENTURE,
            cls.CRI, cls.CRA, cls.ETF, cls.FII, cls.FI_INFRA,
            cls.TESOURO_DIRETO,
        }

    @classmethod
    def international_classes(cls) -> set["AssetClass"]:
        """Classes whose default currency is USD."""
        return {cls.STOCK, cls.REIT}

    @classmethod
    def has_maturity(cls) -> set["AssetClass"]:
        """Classes that may carry a maturity date."""
        return {cls.DEBENTURE, cls.CRI, cls.CRA, cls.TESOURO_DIRETO}

    @classmethod
    def from_xlsx_label(cls, label: str) -> "AssetClass":
        """Resolve legacy XLSX labels (e.g. 'Ação', 'TD') to enum members."""
        _map = {
            "Ação": cls.ACAO,
            "Acao": cls.ACAO,
            "BDR": cls.BDR,
            "Criptomoeda": cls.CRIPTOMOEDA,
            "Debênture": cls.DEBENTURE,
            "Debenture": cls.DEBENTURE,
            "CRI": cls.CRI,
            "CRA": cls.CRA,
            "ETF": cls.ETF,
            "FII": cls.FII,
            "FI-INFRA": cls.FI_INFRA,
            "Tesouro Direto": cls.TESOURO_DIRETO,
            "TD": cls.TESOURO_DIRETO,
            "Stock": cls.STOCK,
            "REIT": cls.REIT,
        }
        resolved = _map.get(label)
        if resolved is None:
            raise ValueError(f"Unknown asset class label: '{label}'")
        return resolved


class EventType(str, Enum):
    COMPRA = "Compra"
    VENDA = "Venda"
    DESDOBRAMENTO = "Desdobramento"
    GRUPAMENTO = "Grupamento"
    AMORTIZACAO = "Amortização"
    BONIFICACAO = "Bonificação"
    CISAO = "Cisão"
    RESGATE_ANTECIPADO = "Resgate Antecipado"
    RESGATE_VENCIMENTO = "Resgate Vencimento"

    # ── classification helpers ───────────────────────────────
    @classmethod
    def exit_events(cls) -> set["EventType"]:
        """Events that reduce quantity and produce realized result."""
        return {cls.VENDA, cls.RESGATE_ANTECIPADO, cls.RESGATE_VENCIMENTO}

    @classmethod
    def requires_positive_position(cls) -> set["EventType"]:
        """Events that require an existing positive position."""
        return {
            cls.DESDOBRAMENTO, cls.GRUPAMENTO, cls.BONIFICACAO,
            cls.AMORTIZACAO, cls.CISAO,
        }

    @classmethod
    def value_ignored(cls) -> set["EventType"]:
        """Events where event_value must be zero or is ignored."""
        return {cls.DESDOBRAMENTO, cls.GRUPAMENTO}


class Currency(str, Enum):
    BRL = "BRL"
    USD = "USD"


class Market(str, Enum):
    BR = "BR"
    US = "US"


def default_market_for_class(asset_class: str) -> Market | None:
    """Return the forced market for classes that are not manually ambiguous."""
    ac = AssetClass(asset_class)
    if ac in {AssetClass.STOCK, AssetClass.REIT}:
        return Market.US
    if ac == AssetClass.ETF:
        return None
    return Market.BR


def currency_for_market(market: str) -> Currency:
    return Currency.USD if Market(market) == Market.US else Currency.BRL
