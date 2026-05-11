from backend.database import get_db, init_db
from backend.services import asset_service


def test_delete_merged_target_clears_merge_reference(tmp_path):
    db_path = tmp_path / "ledger.db"
    init_db(db_path)

    with get_db(db_path) as conn:
        source = asset_service.create_asset(conn, "Ação", "AAAA3", market="BR")
        target = asset_service.create_asset(conn, "Ação", "BBBB3", market="BR")

        asset_service.merge_assets(conn, source["id"], target["id"])
        assert asset_service.delete_asset(conn, target["id"])

        assert asset_service.get_asset(conn, target["id"]) is None
        unmerged_source = asset_service.get_asset(conn, source["id"])
        assert unmerged_source["merged_into_asset_id"] is None
        assert unmerged_source["merged_at"] is None
