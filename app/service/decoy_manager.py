import os
import json
import time
from typing import Dict, List, Optional, Tuple
from app.service.auth import get_storage_dir

DECOY_CATALOG = {
    "main": {
        "id": "main",
        "name": "Decoy Utama",
        "short_name": "Main",
        "badge": "Standard",
        "type": "Standard High-Priority Gateway",
        "description": "Default core decoy routing channel. Optimal untuk transaksi reguler & bypass.",
        "icon": "bi-shield-shaded",
        "color": "cyan"
    },
    "decoy2": {
        "id": "decoy2",
        "name": "Decoy 2",
        "short_name": "Fast Proxy",
        "badge": "Speed Boost",
        "type": "High-Throughput Endpoint",
        "description": "Jalur decoy sekunder dengan latensi rendah untuk eksekusi paket instan.",
        "icon": "bi-lightning-charge-fill",
        "color": "warning"
    },
    "decoy3": {
        "id": "decoy3",
        "name": "Decoy 3",
        "short_name": "Stealth",
        "badge": "Stealth Mode",
        "type": "Encrypted Shadow Gateway",
        "description": "Jalur decoy keamanan tinggi dengan enkripsi ganda untuk transaksi privat.",
        "icon": "bi-incognito",
        "color": "primary"
    },
    "decoy4": {
        "id": "decoy4",
        "name": "Decoy 4",
        "short_name": "Enterprise",
        "badge": "Multi-Loop",
        "type": "Dedicated Enterprise Route",
        "description": "Jalur multi-loop enterprise untuk batch order dan volume pembelian tinggi.",
        "icon": "bi-cpu-fill",
        "color": "danger"
    }
}

PACKAGE_PRESETS = {
    "basic": {
        "package_id": "basic",
        "name": "Free / Basic Tier",
        "duration_days": 365,
        "allowed_decoys": ["main"],
        "description": "Tier dasar gratis dengan akses Decoy Utama."
    },
    "standard": {
        "package_id": "standard",
        "name": "Paket Standard / Akrab",
        "duration_days": 30,
        "allowed_decoys": ["main", "decoy2"],
        "description": "Paket kuota reguler dengan akses Decoy Utama + Decoy 2."
    },
    "premium": {
        "package_id": "premium",
        "name": "Paket Premium VIP",
        "duration_days": 30,
        "allowed_decoys": ["main", "decoy2", "decoy3"],
        "description": "Paket Premium dengan akses Decoy Utama + Decoy 2 + Decoy 3."
    },
    "enterprise": {
        "package_id": "enterprise",
        "name": "Paket Enterprise Ultimate",
        "duration_days": 30,
        "allowed_decoys": ["main", "decoy2", "decoy3", "decoy4"],
        "description": "Paket Enterprise dengan akses seluruh 4 Decoy."
    }
}

class DecoyManager:
    def __init__(self, user_id: Optional[str] = None):
        self.user_id = user_id
        self.storage_dir = get_storage_dir(user_id)
        self.config_file = os.path.join(self.storage_dir, "decoy_config.json")
        self._load_config()

    def _load_config(self):
        self.config = {
            "active_package_id": "premium",
            "package_name": "Paket Premium VIP",
            "package_expired_at": int(time.time()) + (30 * 86400),
            "is_custom_expired": False,
            "active_decoy": "main",
            "allowed_decoys": ["main", "decoy2", "decoy3"],
            "updated_at": int(time.time())
        }

        if os.path.exists(self.config_file):
            try:
                with open(self.config_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, dict):
                        self.config.update(data)
            except Exception as e:
                print(f"Error loading decoy config for {self.user_id}: {e}")

    def _save_config(self):
        self.config["updated_at"] = int(time.time())
        try:
            with open(self.config_file, "w", encoding="utf-8") as f:
                json.dump(self.config, f, indent=4)
        except OSError:
            if self.user_id:
                safe_uid = "".join(c for c in str(self.user_id) if c.isalnum() or c in ("-", "_"))
                tmp_dir = os.path.join("/tmp", "duar_users", safe_uid)
                os.makedirs(tmp_dir, exist_ok=True)
                self.config_file = os.path.join(tmp_dir, "decoy_config.json")
                with open(self.config_file, "w", encoding="utf-8") as f:
                    json.dump(self.config, f, indent=4)

    def get_entitlements(self) -> dict:
        self._load_config()

        exp_ts = self.config.get("package_expired_at")
        is_expired = False
        if self.config.get("is_custom_expired", False):
            is_expired = True
        elif exp_ts and int(exp_ts) > 0 and time.time() > int(exp_ts):
            is_expired = True

        allowed_decoys = self.config.get("allowed_decoys", ["main"])
        active_decoy = self.config.get("active_decoy", "main")

        # If active_decoy is not in allowed_decoys, fallback to main
        if active_decoy not in allowed_decoys:
            active_decoy = "main"
            self.config["active_decoy"] = "main"
            self._save_config()

        # Build list of decoys with entitlement states
        decoys_list = []
        for d_id, d_info in DECOY_CATALOG.items():
            is_entitled = (d_id in allowed_decoys) and (not is_expired)
            is_current = (active_decoy == d_id) and (not is_expired)
            
            # Status: ACTIVE | AVAILABLE | LOCKED
            if is_current:
                status_label = "ACTIVE"
                status_code = "active"
            elif is_entitled:
                status_label = "AVAILABLE"
                status_code = "available"
            else:
                status_label = "LOCKED"
                status_code = "locked"

            decoys_list.append({
                "id": d_id,
                "name": d_info["name"],
                "short_name": d_info["short_name"],
                "badge": d_info["badge"],
                "type": d_info["type"],
                "description": d_info["description"],
                "icon": d_info["icon"],
                "color": d_info["color"],
                "enabled": is_entitled,
                "is_active": is_current,
                "status": status_code,
                "status_label": status_label
            })

        exp_formatted = "-"
        if exp_ts and int(exp_ts) > 0:
            try:
                exp_formatted = time.strftime("%d %b %Y, %H:%M", time.localtime(exp_ts))
            except Exception:
                exp_formatted = "-"

        return {
            "success": True,
            "package": self.config.get("active_package_id", "premium"),
            "package_name": self.config.get("package_name", "Paket Premium VIP"),
            "package_expired_at": exp_ts,
            "package_expired_formatted": exp_formatted,
            "is_expired": is_expired,
            "activeDecoy": active_decoy if not is_expired else None,
            "entitlements": allowed_decoys,
            "decoys": decoys_list,
            "total_decoys": len(decoys_list),
            "available_count": len([d for d in decoys_list if d["enabled"]])
        }

    def switch_decoy(self, decoy_id: str) -> Tuple[bool, str, dict]:
        """Switch active decoy with strict security verification."""
        self._load_config()

        # 1. Validate Decoy ID exists in catalog
        if not decoy_id or decoy_id not in DECOY_CATALOG:
            return False, f"ID Decoy '{decoy_id}' tidak valid atau tidak ditemukan.", {}

        # 2. Check Package Expiry
        exp_ts = self.config.get("package_expired_at")
        if self.config.get("is_custom_expired", False) or (exp_ts and int(exp_ts) > 0 and time.time() > int(exp_ts)):
            return False, "Paket Anda telah kedaluwarsa. Perpanjang paket untuk menggunakan fitur DEC0Y.", {}

        # 3. Check Entitlement
        allowed_decoys = self.config.get("allowed_decoys", ["main"])
        if decoy_id not in allowed_decoys:
            return False, f"Decoy '{DECOY_CATALOG[decoy_id]['name']}' tidak termasuk dalam entitlement paket Anda.", {}

        # 4. Save new active decoy
        self.config["active_decoy"] = decoy_id
        self._save_config()

        updated_data = self.get_entitlements()
        return True, f"Decoy berhasil diubah ke {DECOY_CATALOG[decoy_id]['name']}", updated_data

    def set_package(self, package_id: str, is_expired: bool = False) -> dict:
        """Set package preset for testing or tier upgrades."""
        if package_id not in PACKAGE_PRESETS:
            package_id = "basic"

        preset = PACKAGE_PRESETS[package_id]
        dur = preset["duration_days"]
        
        self.config["active_package_id"] = preset["package_id"]
        self.config["package_name"] = preset["name"]
        self.config["allowed_decoys"] = list(preset["allowed_decoys"])
        self.config["is_custom_expired"] = is_expired
        
        if is_expired:
            self.config["package_expired_at"] = int(time.time()) - 3600
        else:
            self.config["package_expired_at"] = int(time.time()) + (dur * 86400)

        if self.config.get("active_decoy") not in self.config["allowed_decoys"]:
            self.config["active_decoy"] = "main"

        self._save_config()
        return self.get_entitlements()


_user_decoy_registry: Dict[str, DecoyManager] = {}

def get_decoy_manager_for_user(user_id: Optional[str] = None) -> DecoyManager:
    """Get or create isolated DecoyManager for specific Google user ID."""
    key = str(user_id).strip() if user_id else "__default__"
    if key not in _user_decoy_registry:
        _user_decoy_registry[key] = DecoyManager(user_id=user_id if user_id else None)
    return _user_decoy_registry[key]
