import os
import json
import time
from typing import Dict, List, Optional
from app.client.ciam import get_new_token
from app.client.engsel import get_profile
from app.util import ensure_api_key

_user_auth_registry: Dict[str, "Auth"] = {}

def get_storage_dir(user_id: Optional[str] = None) -> str:
    """Returns the storage directory for the given user_id."""
    if not user_id:
        return "."
    # Sanitize user_id for filesystem safety
    safe_uid = "".join(c for c in str(user_id) if c.isalnum() or c in ("-", "_"))
    base_dir = os.path.join(".", "user_data", safe_uid)
    try:
        os.makedirs(base_dir, exist_ok=True)
        return base_dir
    except OSError:
        tmp_dir = os.path.join("/tmp", "duar_users", safe_uid)
        os.makedirs(tmp_dir, exist_ok=True)
        return tmp_dir

class Auth:
    def __init__(self, user_id: Optional[str] = None):
        self.user_id = user_id
        self.api_key = ensure_api_key()
        self.storage_dir = get_storage_dir(user_id)
        self.tokens_file = os.path.join(self.storage_dir, "refresh-tokens.json")
        self.active_number_file = os.path.join(self.storage_dir, "active.number")
        
        self.refresh_tokens: List[dict] = []
        self.active_user: Optional[dict] = None
        self.last_refresh_time: Optional[float] = None

        if os.path.exists(self.tokens_file):
            self.load_tokens()
        else:
            self._save_tokens_file([])

        self.load_active_number()
        self.last_refresh_time = time.time()

    def _save_tokens_file(self, tokens_data: list):
        try:
            with open(self.tokens_file, "w", encoding="utf-8") as f:
                json.dump(tokens_data, f, indent=4)
        except OSError:
            if self.user_id:
                safe_uid = "".join(c for c in str(self.user_id) if c.isalnum() or c in ("-", "_"))
                tmp_dir = os.path.join("/tmp", "duar_users", safe_uid)
                os.makedirs(tmp_dir, exist_ok=True)
                self.tokens_file = os.path.join(tmp_dir, "refresh-tokens.json")
                with open(self.tokens_file, "w", encoding="utf-8") as f:
                    json.dump(tokens_data, f, indent=4)

    def load_tokens(self):
        if not os.path.exists(self.tokens_file):
            self.refresh_tokens = []
            return
        try:
            with open(self.tokens_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                valid = []
                if isinstance(data, list):
                    for rt in data:
                        if isinstance(rt, dict) and "number" in rt and "refresh_token" in rt:
                            valid.append(rt)
                self.refresh_tokens = valid
        except Exception as e:
            print(f"Error loading tokens for user {self.user_id}: {e}")
            self.refresh_tokens = []

    def add_refresh_token(self, number: int, refresh_token: str):
        existing = next((rt for rt in self.refresh_tokens if rt["number"] == number), None)
        if existing:
            existing["refresh_token"] = refresh_token
        else:
            try:
                tokens = get_new_token(self.api_key, refresh_token, "")
                profile_data = get_profile(self.api_key, tokens["access_token"], tokens["id_token"])
                sub_id = profile_data.get("profile", {}).get("subscriber_id", "")
                sub_type = profile_data.get("profile", {}).get("subscription_type", "PREPAID")

                self.refresh_tokens.append({
                    "number": int(number),
                    "subscriber_id": sub_id,
                    "subscription_type": sub_type,
                    "refresh_token": refresh_token
                })
            except Exception as e:
                print(f"Error fetching profile on add_refresh_token: {e}")
                self.refresh_tokens.append({
                    "number": int(number),
                    "subscriber_id": "",
                    "subscription_type": "PREPAID",
                    "refresh_token": refresh_token
                })

        self.write_tokens_to_file()
        self.set_active_user(number)

    def remove_refresh_token(self, number: int):
        self.refresh_tokens = [rt for rt in self.refresh_tokens if rt["number"] != number]
        self.write_tokens_to_file()

        if self.active_user and self.active_user["number"] == number:
            if len(self.refresh_tokens) != 0:
                first_rt = self.refresh_tokens[0]
                self.set_active_user(first_rt["number"])
            else:
                self.active_user = None
                self.write_active_number()

    def set_active_user(self, number: int) -> bool:
        rt_entry = next((rt for rt in self.refresh_tokens if rt["number"] == number), None)
        if not rt_entry:
            return False

        try:
            tokens = get_new_token(self.api_key, rt_entry["refresh_token"], rt_entry.get("subscriber_id", ""))
            if not tokens:
                return False

            profile_data = get_profile(self.api_key, tokens["access_token"], tokens["id_token"])
            subscriber_id = profile_data.get("profile", {}).get("subscriber_id", "")
            subscription_type = profile_data.get("profile", {}).get("subscription_type", "PREPAID")

            self.active_user = {
                "number": int(number),
                "subscriber_id": subscriber_id,
                "subscription_type": subscription_type,
                "tokens": tokens
            }

            rt_entry["subscriber_id"] = subscriber_id
            rt_entry["subscription_type"] = subscription_type
            rt_entry["refresh_token"] = tokens.get("refresh_token", rt_entry["refresh_token"])
            self.write_tokens_to_file()
            self.last_refresh_time = time.time()
            self.write_active_number()
            return True
        except Exception as e:
            print(f"Error setting active user {number}: {e}")
            return False

    def renew_active_user_token(self) -> bool:
        if self.active_user and "tokens" in self.active_user and self.active_user["tokens"].get("refresh_token"):
            try:
                tokens = get_new_token(
                    self.api_key,
                    self.active_user["tokens"]["refresh_token"],
                    self.active_user.get("subscriber_id", "")
                )
                if tokens:
                    self.active_user["tokens"] = tokens
                    self.last_refresh_time = time.time()
                    self.add_refresh_token(self.active_user["number"], self.active_user["tokens"]["refresh_token"])
                    return True
            except Exception as e:
                print(f"Error renewing token: {e}")
        return False

    def get_active_user(self) -> Optional[dict]:
        if not self.active_user:
            if len(self.refresh_tokens) != 0:
                first_rt = self.refresh_tokens[0]
                self.set_active_user(first_rt["number"])
            return self.active_user

        if self.last_refresh_time is None or (time.time() - self.last_refresh_time) > 300:
            self.renew_active_user_token()
            self.last_refresh_time = time.time()

        return self.active_user

    def get_active_tokens(self) -> Optional[dict]:
        active_user = self.get_active_user()
        return active_user["tokens"] if active_user else None

    def write_tokens_to_file(self):
        self._save_tokens_file(self.refresh_tokens)

    def write_active_number(self):
        if self.active_user:
            try:
                with open(self.active_number_file, "w", encoding="utf-8") as f:
                    f.write(str(self.active_user["number"]))
            except OSError:
                if self.user_id:
                    safe_uid = "".join(c for c in str(self.user_id) if c.isalnum() or c in ("-", "_"))
                    tmp_dir = os.path.join("/tmp", "duar_users", safe_uid)
                    os.makedirs(tmp_dir, exist_ok=True)
                    self.active_number_file = os.path.join(tmp_dir, "active.number")
                    with open(self.active_number_file, "w", encoding="utf-8") as f:
                        f.write(str(self.active_user["number"]))
        else:
            if os.path.exists(self.active_number_file):
                try:
                    os.remove(self.active_number_file)
                except OSError:
                    pass

    def load_active_number(self):
        if os.path.exists(self.active_number_file):
            try:
                with open(self.active_number_file, "r", encoding="utf-8") as f:
                    number_str = f.read().strip()
                    if number_str.isdigit():
                        number = int(number_str)
                        self.set_active_user(number)
            except Exception:
                pass


def get_auth_for_user(user_id: Optional[str] = None) -> Auth:
    """Get or create an isolated Auth instance for a specific user ID."""
    key = str(user_id).strip() if user_id else "__default__"
    if key not in _user_auth_registry:
        _user_auth_registry[key] = Auth(user_id=user_id if user_id else None)
    return _user_auth_registry[key]


# Global fallback instance for CLI compatibility
AuthInstance = get_auth_for_user(None)
