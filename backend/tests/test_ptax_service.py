from decimal import Decimal

from backend.database import get_db, init_db
from backend.services import ptax_service


def test_get_ptax_uses_cache(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    def fail_fetch(_date):
        raise AssertionError("BCB should not be called when cache exists")

    monkeypatch.setattr(ptax_service, "_fetch_ptax_from_bcb", fail_fetch)

    with get_db(db_path) as conn:
        conn.execute(
            "INSERT INTO ptax_cache (date, compra, venda) VALUES (?, ?, ?)",
            ("2023-12-15", 4.9, 5.1),
        )
        result = ptax_service.get_ptax("2023-12-15", conn=conn)

    assert result == {"compra": Decimal("4.9"), "venda": Decimal("5.1")}


def test_get_ptax_falls_back_and_caches_result(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    calls = []

    def fake_fetch(value):
        calls.append(value.isoformat())
        if value.isoformat() == "2023-12-15":
            return {"compra": Decimal("4.8"), "venda": Decimal("5.0")}
        return None

    monkeypatch.setattr(ptax_service, "_fetch_ptax_from_bcb", fake_fetch)

    with get_db(db_path) as conn:
        result = ptax_service.get_ptax("2023-12-17", conn=conn)
        cached = conn.execute(
            "SELECT compra, venda FROM ptax_cache WHERE date = ?",
            ("2023-12-15",),
        ).fetchone()

    assert calls == ["2023-12-17", "2023-12-16", "2023-12-15"]
    assert result == {"compra": Decimal("4.8"), "venda": Decimal("5.0")}
    assert cached["compra"] == 4.8
    assert cached["venda"] == 5.0


def test_get_ptax_primeira_quinzena_mes_anterior_uses_day_15(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    calls = []

    def fake_get_ptax(value, conn=None):
        calls.append(value.isoformat())
        return {"compra": Decimal("4.7"), "venda": Decimal("4.9")}

    monkeypatch.setattr(ptax_service, "get_ptax", fake_get_ptax)

    with get_db(db_path) as conn:
        result = ptax_service.get_ptax_primeira_quinzena_mes_anterior("2024-01-20", conn=conn)

    assert calls == ["2023-12-15"]
    assert result == {"compra": Decimal("4.7"), "venda": Decimal("4.9")}
