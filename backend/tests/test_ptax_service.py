from decimal import Decimal
from datetime import date as Date

from backend.database import get_db, init_db
from backend.domain.enums import AssetClass
from backend.services import ptax_service
from backend.services import asset_service, portfolio_service


def _seed_us_event(conn, ticker="AAPL", event_date="2024-01-10"):
    portfolio = portfolio_service.create_portfolio(conn, "Principal")
    asset = asset_service.create_asset(conn, AssetClass.STOCK.value, ticker, market="US")
    conn.execute(
        """
        INSERT INTO events (
            portfolio_id, asset_id, event_type, event_date, quantity,
            event_value, event_value_brl, sequence_num
        )
        VALUES (?, ?, 'Compra', ?, '1', '100', '500', 1)
        """,
        (portfolio["id"], asset["id"], event_date),
    )
    return portfolio, asset


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


def test_warm_ptax_monthly_cache_uses_effective_month_end_date(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    calls = []

    def fake_fetch(value):
        calls.append(value.isoformat())
        if value.isoformat() == "2024-03-29":
            return {"compra": Decimal("4.9"), "venda": Decimal("5.01")}
        return None

    monkeypatch.setattr(ptax_service, "_fetch_ptax_from_bcb", fake_fetch)

    with get_db(db_path) as conn:
        _seed_us_event(conn, event_date="2024-03-15")
        result = ptax_service.warm_ptax_monthly_cache(conn, today=Date(2024, 4, 1), source="test")
        row = conn.execute("SELECT * FROM ptax_monthly_cache WHERE reference_month = ?", ("2024-03",)).fetchone()

    assert result == {"created": 1, "failed": 0}
    assert calls[-3:] == ["2024-03-31", "2024-03-30", "2024-03-29"]
    assert row["ptax_date"] == "2024-03-29"
    assert row["venda"] == "5.01"
    assert row["source"] == "test"


def test_warm_ptax_monthly_cache_is_incremental(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    calls = []

    def fake_get_ptax_with_date(value, conn=None):
        calls.append(value.isoformat())
        return {"date": value, "compra": Decimal("4.8"), "venda": Decimal("5.0")}

    monkeypatch.setattr(ptax_service, "get_ptax_with_date", fake_get_ptax_with_date)

    with get_db(db_path) as conn:
        _seed_us_event(conn, ticker="MSFT", event_date="2024-01-10")
        first = ptax_service.warm_ptax_monthly_cache(conn, today=Date(2024, 4, 2), source="test")
        second = ptax_service.warm_ptax_monthly_cache(conn, today=Date(2024, 4, 2), source="test")
        rows = conn.execute("SELECT reference_month FROM ptax_monthly_cache ORDER BY reference_month").fetchall()

    assert first == {"created": 3, "failed": 0}
    assert second == {"created": 0, "failed": 0}
    assert calls == ["2024-01-31", "2024-02-29", "2024-03-31"]
    assert [row["reference_month"] for row in rows] == ["2024-01", "2024-02", "2024-03"]


def test_warm_ptax_monthly_cache_fills_only_missing_months(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    calls = []

    def fake_get_ptax_with_date(value, conn=None):
        calls.append(value.isoformat())
        return {"date": value, "compra": Decimal("4.8"), "venda": Decimal("5.0")}

    monkeypatch.setattr(ptax_service, "get_ptax_with_date", fake_get_ptax_with_date)

    with get_db(db_path) as conn:
        _seed_us_event(conn, ticker="GOOG", event_date="2024-01-10")
        conn.execute(
            "INSERT INTO ptax_monthly_cache (reference_month, ptax_date, venda, source) VALUES (?, ?, ?, ?)",
            ("2024-01", "2024-01-31", "5.0", "seed"),
        )
        conn.execute(
            "INSERT INTO ptax_monthly_cache (reference_month, ptax_date, venda, source) VALUES (?, ?, ?, ?)",
            ("2024-03", "2024-03-31", "5.0", "seed"),
        )
        result = ptax_service.warm_ptax_monthly_cache(conn, today=Date(2024, 5, 2), source="test")
        rows = conn.execute("SELECT reference_month FROM ptax_monthly_cache ORDER BY reference_month").fetchall()

    assert result == {"created": 2, "failed": 0}
    assert calls == ["2024-02-29", "2024-04-30"]
    assert [row["reference_month"] for row in rows] == ["2024-01", "2024-02", "2024-03", "2024-04"]


def test_warm_ptax_monthly_cache_no_us_events_is_noop(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    def fail_get_ptax_with_date(value, conn=None):
        raise AssertionError("PTAX should not be requested without US events")

    monkeypatch.setattr(ptax_service, "get_ptax_with_date", fail_get_ptax_with_date)

    with get_db(db_path) as conn:
        result = ptax_service.warm_ptax_monthly_cache(conn, today=Date(2024, 5, 2), source="test")
        count = conn.execute("SELECT COUNT(*) AS count FROM ptax_monthly_cache").fetchone()["count"]

    assert result == {"created": 0, "failed": 0}
    assert count == 0


def test_warm_ptax_monthly_cache_continues_after_ptax_failure(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)
    calls = []

    def fake_get_ptax_with_date(value, conn=None):
        calls.append(value.isoformat())
        if value.isoformat() == "2024-02-29":
            raise ValueError("offline")
        return {"date": value, "compra": Decimal("4.8"), "venda": Decimal("5.0")}

    monkeypatch.setattr(ptax_service, "get_ptax_with_date", fake_get_ptax_with_date)

    with get_db(db_path) as conn:
        _seed_us_event(conn, ticker="TSLA", event_date="2024-01-10")
        result = ptax_service.warm_ptax_monthly_cache(conn, today=Date(2024, 4, 2), source="test")
        rows = conn.execute("SELECT reference_month FROM ptax_monthly_cache ORDER BY reference_month").fetchall()

    assert result == {"created": 2, "failed": 1}
    assert calls == ["2024-01-31", "2024-02-29", "2024-03-31"]
    assert [row["reference_month"] for row in rows] == ["2024-01", "2024-03"]
