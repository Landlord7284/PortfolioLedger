from backend.database import get_db, init_db
from backend.domain.enums import AssetClass, EventType
from backend.services import asset_service, event_service, import_service, portfolio_service


def test_us_purchase_creates_fiscal_lot_with_precomputed_costs(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        conn.execute(
            "INSERT INTO ptax_cache (date, compra, venda) VALUES (?, ?, ?)",
            ("2023-12-15", 4.8, 5.0),
        )
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset = asset_service.create_asset(conn, AssetClass.STOCK.value, "MSFT")

        event = event_service.create_event(
            conn,
            portfolio["id"],
            asset["id"],
            EventType.COMPRA.value,
            "2023-12-15",
            "10",
            "1000",
            origin_usd="250",
        )

        lot = conn.execute(
            "SELECT * FROM fiscal_lots WHERE event_id = ?",
            (event["id"],),
        ).fetchone()

    assert lot["asset_id"] == asset["id"]
    assert lot["quantity"] == "10"
    assert lot["price_usd"] == "100"
    assert lot["total_usd"] == "1000"
    assert lot["origin_usd"] == "250"
    assert lot["origin_brl_usd"] == "750"
    assert lot["ptax_venda_acq"] == "5.0"
    assert lot["ptax_compra_acq"] == "4.8"
    assert lot["cost_brl_portion_brl"] == "3750.0"
    assert lot["cost_usd_portion_usd"] == "250"
    assert lot["regime"] == "PRE_2024"
    assert lot["quantity_remaining"] == "10"


def test_post_2024_purchase_forces_origin_usd_to_zero(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        conn.execute(
            "INSERT INTO ptax_cache (date, compra, venda) VALUES (?, ?, ?)",
            ("2024-01-02", 4.8, 5.0),
        )
        portfolio = portfolio_service.create_portfolio(conn, "Principal")
        asset = asset_service.create_asset(conn, AssetClass.REIT.value, "O")

        event = event_service.create_event(
            conn,
            portfolio["id"],
            asset["id"],
            EventType.COMPRA.value,
            "2024-01-02",
            "10",
            "1000",
            origin_usd="250",
        )

        lot = conn.execute(
            "SELECT * FROM fiscal_lots WHERE event_id = ?",
            (event["id"],),
        ).fetchone()

    assert lot["origin_usd"] == "0"
    assert lot["origin_brl_usd"] == "1000"
    assert lot["regime"] == "POST_2024"


def test_dados_us_layout_parses_origin_us_column():
    parsed = import_service.parse_xlsx("Dados_US.xlsx")

    assert parsed[0]["asset_class"] == AssetClass.STOCK.value
    assert parsed[0]["market"] == "US"
    assert parsed[0]["event_type"] == EventType.COMPRA.value
    assert parsed[0]["origin_usd"] is None
    assert any(ev["origin_usd"] == "24.5" for ev in parsed)
