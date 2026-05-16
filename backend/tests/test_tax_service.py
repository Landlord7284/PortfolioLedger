from decimal import Decimal

from fastapi.testclient import TestClient

from backend.database import get_db, init_db
from backend.domain.enums import AssetClass, EventType
from backend.main import app
from backend.services import asset_service, event_service, portfolio_service, tax_service


def _seed_ptax(conn, date, compra="5.2", venda="5.5"):
    conn.execute(
        "INSERT INTO ptax_cache (date, compra, venda) VALUES (?, ?, ?)",
        (date, float(compra), float(venda)),
    )


def _portfolio_and_asset(conn):
    portfolio = portfolio_service.create_portfolio(conn, "Principal")
    asset = asset_service.create_asset(conn, AssetClass.STOCK.value, "MSFT")
    return portfolio, asset


def _buy(conn, portfolio, asset, date, qty, total_usd, origin_usd=None):
    return event_service.create_event(
        conn,
        portfolio["id"],
        asset["id"],
        EventType.COMPRA.value,
        date,
        qty,
        total_usd,
        origin_usd=origin_usd,
    )


def _sell(conn, portfolio, asset, date, qty, total_usd, gross_value=None):
    return event_service.create_event(
        conn,
        portfolio["id"],
        asset["id"],
        EventType.VENDA.value,
        date,
        qty,
        total_usd,
        gross_value=gross_value,
    )


def test_pre_2024_brl_origin_gain_uses_ptax_compra(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        _seed_ptax(conn, "2023-12-15", compra="4.8", venda="5.0")
        _seed_ptax(conn, "2023-12-20", compra="5.2", venda="5.4")
        portfolio, asset = _portfolio_and_asset(conn)
        _buy(conn, portfolio, asset, "2023-12-15", "10", "1000", origin_usd="0")
        sale = _sell(conn, portfolio, asset, "2023-12-20", "4", "480")

        result = tax_service.apurar_ganhos_evento_venda(conn, sale)

    assert Decimal(result["total_ganho_brl"]) == Decimal("496")
    assert Decimal(result["events"][0]["ganho_brl"]) == Decimal("496")
    assert result["events"][0]["ptax_used"] == "5.2"
    assert result["events"][0]["regime"] == "PRE_2024"


def test_pre_2024_usd_origin_gain_uses_ptax_compra(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        _seed_ptax(conn, "2023-12-15", compra="4.8", venda="5.0")
        _seed_ptax(conn, "2023-12-20", compra="5.2", venda="5.4")
        portfolio, asset = _portfolio_and_asset(conn)
        _buy(conn, portfolio, asset, "2023-12-15", "10", "1000", origin_usd="1000")
        sale = _sell(conn, portfolio, asset, "2023-12-20", "4", "480")

        result = tax_service.apurar_ganhos_evento_venda(conn, sale)

    assert Decimal(result["total_ganho_brl"]) == Decimal("416")
    assert Decimal(result["events"][0]["ganho_brl"]) == Decimal("416")


def test_pre_2024_mixed_origin_gain_is_proportional(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        _seed_ptax(conn, "2023-12-15", compra="4.8", venda="5.0")
        _seed_ptax(conn, "2023-12-20", compra="5.2", venda="5.4")
        portfolio, asset = _portfolio_and_asset(conn)
        _buy(conn, portfolio, asset, "2023-12-15", "10", "1000", origin_usd="250")
        sale = _sell(conn, portfolio, asset, "2023-12-20", "4", "480")

        result = tax_service.apurar_ganhos_evento_venda(conn, sale)

    assert Decimal(result["total_ganho_brl"]) == Decimal("2972")
    assert Decimal(result["events"][0]["ganho_brl"]) == Decimal("2972")


def test_post_2024_gain_uses_ptax_venda_and_stored_lot_cost(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        _seed_ptax(conn, "2024-01-02", compra="4.8", venda="5.0")
        _seed_ptax(conn, "2024-01-10", compra="5.2", venda="5.5")
        portfolio, asset = _portfolio_and_asset(conn)
        _buy(conn, portfolio, asset, "2024-01-02", "10", "1000", origin_usd="250")
        sale = _sell(conn, portfolio, asset, "2024-01-10", "4", "480")

        result = tax_service.apurar_ganhos_evento_venda(conn, sale)

    assert Decimal(result["total_ganho_brl"]) == Decimal("640")
    assert result["events"][0]["ptax_used"] == "5.5"
    assert result["events"][0]["regime"] == "POST_2024"


def test_sale_after_2024_dispatches_by_stored_lot_regime(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        _seed_ptax(conn, "2023-12-15", compra="4.8", venda="5.0")
        _seed_ptax(conn, "2024-01-10", compra="5.2", venda="5.5")
        portfolio, asset = _portfolio_and_asset(conn)
        _buy(conn, portfolio, asset, "2023-12-15", "10", "1000", origin_usd="0")
        sale = _sell(conn, portfolio, asset, "2024-01-10", "4", "480")

        result = tax_service.apurar_ganhos_evento_venda(conn, sale)

    assert result["events"][0]["regime"] == "PRE_2024"
    assert result["events"][0]["ptax_used"] == "5.2"
    assert Decimal(result["total_ganho_brl"]) == Decimal("496")


def test_sale_consumes_lots_fifo_and_is_idempotent(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        _seed_ptax(conn, "2024-01-02", compra="4.8", venda="5.0")
        _seed_ptax(conn, "2024-01-03", compra="4.9", venda="6.0")
        _seed_ptax(conn, "2024-01-10", compra="5.2", venda="5.5")
        portfolio, asset = _portfolio_and_asset(conn)
        _buy(conn, portfolio, asset, "2024-01-02", "3", "300")
        _buy(conn, portfolio, asset, "2024-01-03", "5", "1000")
        sale = _sell(conn, portfolio, asset, "2024-01-10", "4", "800", gross_value="840")

        first = tax_service.apurar_ganhos_evento_venda(conn, sale)
        second = tax_service.apurar_ganhos_evento_venda(conn, sale)
        lots = conn.execute(
            "SELECT quantity_remaining FROM fiscal_lots ORDER BY date, event_id"
        ).fetchall()

    assert [row["qty_sold"] for row in first["events"]] == ["3", "1"]
    assert Decimal(first["total_ganho_brl"]) == Decimal("1920")
    assert second["total_ganho_brl"] == first["total_ganho_brl"]
    assert [row["quantity_remaining"] for row in lots] == ["0", "4"]


def test_income_on_or_after_2024_uses_credit_date_ptax_venda(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        _seed_ptax(conn, "2023-12-15", compra="4.7", venda="4.9")
        _seed_ptax(conn, "2024-01-20", compra="4.8", venda="5.1")
        portfolio, asset = _portfolio_and_asset(conn)

        post = tax_service.apurar_rendimento(
            conn, portfolio["id"], asset["id"], "10", "2024-01-20", income_type="Interest"
        )

    assert post["regime"] == "POST_2024"
    assert post["ptax_used"] == "5.1"
    assert post["amount_brl"] == "51.0"


def test_income_before_2024_uses_previous_month_first_half_ptax(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        _seed_ptax(conn, "2023-11-15", compra="4.6", venda="4.8")
        portfolio, asset = _portfolio_and_asset(conn)

        row = tax_service.apurar_rendimento(
            conn, portfolio["id"], asset["id"], "10", "2023-12-20", income_type="Dividend"
        )

    assert row["regime"] == "PRE_2024"
    assert row["ptax_used"] == "4.6"
    assert row["amount_brl"] == "46.0"


def test_tax_router_sale_income_and_listing(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        _seed_ptax(conn, "2024-01-02", compra="4.8", venda="5.0")
        _seed_ptax(conn, "2024-01-10", compra="5.2", venda="5.5")
        portfolio, asset = _portfolio_and_asset(conn)
        _buy(conn, portfolio, asset, "2024-01-02", "10", "1000")
        sale = _sell(conn, portfolio, asset, "2024-01-10", "4", "480")

    monkeypatch.setattr("backend.routers.tax.get_db", lambda: get_db(db_path))
    client = TestClient(app)

    ptax_response = client.get("/api/tax/ptax?date=2024-01-10")
    assert ptax_response.status_code == 200
    assert ptax_response.json() == {
        "date": "2024-01-10",
        "compra": "5.2",
        "venda": "5.5",
    }

    sale_response = client.post(f"/api/tax/sales/{sale['id']}/apurar")
    assert sale_response.status_code == 200
    assert sale_response.json()["total_ganho_brl"] == "640.0"

    income_response = client.post(
        "/api/tax/income",
        json={
            "portfolio_id": portfolio["id"],
            "asset_id": asset["id"],
            "amount_usd": "10",
            "credit_date": "2024-01-10",
            "income_type": "Dividend",
        },
    )
    assert income_response.status_code == 200
    assert income_response.json()["amount_brl"] == "55.0"

    events_response = client.get(f"/api/tax/events?portfolio_id={portfolio['id']}&year=2024")
    assert events_response.status_code == 200
    assert len(events_response.json()) == 2

    annual_response = client.get(f"/api/tax/annual?portfolio_id={portfolio['id']}&year=2024")
    assert annual_response.status_code == 200
    assert {row["tax_event_type"] for row in annual_response.json()} == {"SALE", "INCOME"}
