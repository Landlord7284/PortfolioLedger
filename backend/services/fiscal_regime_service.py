"""
Shared fiscal regime helpers for capital gains contracts.
"""

from __future__ import annotations

import sqlite3
from typing import Final


REGIME_B3_COMMON: Final = "B3_COMMON_15"
REGIME_B3_FII: Final = "B3_FII_FIAGRO_20"
REGIME_FI_INFRA_EXEMPT: Final = "FI_INFRA_EXEMPT"
REGIME_CRYPTO: Final = "CRYPTO_GCAP"

SUPPORTED_CAPITAL_GAIN_REGIMES: Final = {
    REGIME_B3_COMMON,
    REGIME_B3_FII,
    REGIME_FI_INFRA_EXEMPT,
    REGIME_CRYPTO,
}


def is_supported_capital_gain_regime(regime: str | None) -> bool:
    if regime in (None, ""):
        return True
    return regime in SUPPORTED_CAPITAL_GAIN_REGIMES


def require_supported_capital_gain_regime(regime: str | None) -> str | None:
    if regime in (None, ""):
        return None
    if not is_supported_capital_gain_regime(regime):
        raise ValueError(f"Regime fiscal nao suportado nesta entrega: {regime}.")
    return regime


def has_tax_parameter(conn: sqlite3.Connection, regime: str, fact_date: str) -> bool:
    row = conn.execute(
        """
        SELECT 1
        FROM fiscal_tax_parameters
        WHERE regime = ?
          AND valid_from <= ?
          AND (valid_until IS NULL OR valid_until >= ?)
        LIMIT 1
        """,
        (regime, fact_date, fact_date),
    ).fetchone()
    return row is not None
