import os
import json
import time
import uuid
from typing import List, Dict, Optional

_user_bookmark_registry: Dict[str, "Bookmark"] = {}

def get_bookmark_storage_path(user_id: Optional[str] = None) -> str:
    """Returns the filepath for bookmark storage for the given user_id."""
    if not user_id:
        return "bookmark.json"
    safe_uid = "".join(c for c in str(user_id) if c.isalnum() or c in ("-", "_"))
    base_dir = os.path.join(".", "user_data", safe_uid)
    try:
        os.makedirs(base_dir, exist_ok=True)
        return os.path.join(base_dir, "bookmark.json")
    except OSError:
        tmp_dir = os.path.join("/tmp", "duar_users", safe_uid)
        os.makedirs(tmp_dir, exist_ok=True)
        return os.path.join(tmp_dir, "bookmark.json")

class Bookmark:
    def __init__(self, user_id: Optional[str] = None):
        self.user_id = user_id
        self.packages: List[Dict] = []
        self.filepath = get_bookmark_storage_path(user_id)

        if os.path.exists(self.filepath):
            self.load_bookmark()
        else:
            self._save([])

    def _save(self, data: List[Dict]):
        try:
            with open(self.filepath, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=4)
        except OSError:
            safe_uid = "".join(c for c in str(self.user_id) if c.isalnum() or c in ("-", "_")) if self.user_id else "default"
            tmp_dir = os.path.join("/tmp", "duar_users", safe_uid)
            os.makedirs(tmp_dir, exist_ok=True)
            self.filepath = os.path.join(tmp_dir, "bookmark.json")
            with open(self.filepath, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=4)

    def _ensure_schema(self):
        updated = False
        for p in self.packages:
            if "id" not in p or not p["id"]:
                p["id"] = f"bm_{uuid.uuid4().hex[:8]}"
                updated = True
            if "label" not in p:
                p["label"] = ""
                updated = True
            if "family_name" not in p:
                p["family_name"] = ""
                updated = True
            if "variant_name" not in p:
                p["variant_name"] = ""
                updated = True
            if "option_name" not in p:
                p["option_name"] = ""
                updated = True
            if "option_code" not in p:
                p["option_code"] = ""
                updated = True
            if "order" not in p:
                p["order"] = 1
                updated = True
            if "price" not in p:
                p["price"] = 0
                updated = True
            if "is_enterprise" not in p:
                p["is_enterprise"] = False
                updated = True
            if "payment_method" not in p:
                p["payment_method"] = "balance_decoy_v2"
                updated = True
            if "overwrite_amount" not in p:
                p["overwrite_amount"] = None
                updated = True
            if "mode" not in p:
                p["mode"] = "single"
                updated = True
            if "created_at" not in p:
                p["created_at"] = int(time.time())
                updated = True
        if updated:
            self.save_bookmark()

    def load_bookmark(self):
        if not os.path.exists(self.filepath):
            self.packages = []
            return
        try:
            with open(self.filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
                self.packages = data if isinstance(data, list) else []
            self._ensure_schema()
        except Exception as e:
            print(f"Error loading bookmarks for user {self.user_id}: {e}")
            self.packages = []

    def save_bookmark(self):
        self._save(self.packages)

    def set_bookmarks(self, bookmarks_list: List[Dict]):
        """Replace all bookmarks (used during sync)."""
        self.packages = list(bookmarks_list) if isinstance(bookmarks_list, list) else []
        self._ensure_schema()
        self.save_bookmark()

    def add_bookmark(
        self,
        family_code: str,
        family_name: str = "",
        is_enterprise: bool = False,
        variant_name: str = "",
        option_name: str = "",
        order: int = 1,
        label: str = "",
        payment_method: str = "balance_decoy_v2",
        overwrite_amount: Optional[int] = None,
        option_code: str = "",
        price: int = 0,
        mode: str = "single",
    ) -> bool:
        for p in self.packages:
            if (
                p.get("family_code") == family_code
                and p.get("order") == order
                and (not variant_name or p.get("variant_name") == variant_name)
            ):
                p["family_name"] = family_name or p.get("family_name", "")
                p["is_enterprise"] = is_enterprise
                p["option_name"] = option_name or p.get("option_name", "")
                p["label"] = label or p.get("label", "")
                p["payment_method"] = payment_method or p.get("payment_method", "balance_decoy_v2")
                p["overwrite_amount"] = overwrite_amount
                p["option_code"] = option_code or p.get("option_code", "")
                p["price"] = price if price > 0 else p.get("price", 0)
                p["mode"] = mode
                self.save_bookmark()
                return True

        new_bm = {
            "id": f"bm_{uuid.uuid4().hex[:8]}",
            "label": label,
            "family_code": family_code,
            "family_name": family_name,
            "is_enterprise": is_enterprise,
            "variant_name": variant_name,
            "option_name": option_name,
            "option_code": option_code,
            "order": order,
            "price": price,
            "payment_method": payment_method,
            "overwrite_amount": overwrite_amount,
            "mode": mode,
            "created_at": int(time.time()),
        }
        self.packages.append(new_bm)
        self.save_bookmark()
        return True

    def remove_bookmark_by_id(self, bm_id: str) -> bool:
        for i, p in enumerate(self.packages):
            if p.get("id") == bm_id:
                del self.packages[i]
                self.save_bookmark()
                return True
        return False

    def remove_bookmark(
        self,
        family_code: str,
        is_enterprise: bool,
        variant_name: str,
        order: int,
    ) -> bool:
        for i, p in enumerate(self.packages):
            if (
                p.get("family_code") == family_code
                and p.get("is_enterprise") == is_enterprise
                and (not variant_name or p.get("variant_name") == variant_name)
                and p.get("order") == order
            ):
                del self.packages[i]
                self.save_bookmark()
                return True
        return False

    def get_bookmarks(self) -> List[Dict]:
        return self.packages.copy()


def get_bookmark_for_user(user_id: Optional[str] = None) -> Bookmark:
    key = str(user_id).strip() if user_id else "__default__"
    if key not in _user_bookmark_registry:
        _user_bookmark_registry[key] = Bookmark(user_id=user_id if user_id else None)
    return _user_bookmark_registry[key]


BookmarkInstance = get_bookmark_for_user(None)
