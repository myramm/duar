#!/usr/bin/env python3
import os
import sys
import json
import time
import uuid
import base64
import io
import traceback
from typing import Optional, List, Dict
from datetime import datetime, timezone, timedelta
from contextlib import redirect_stdout, redirect_stderr

from dotenv import load_dotenv
load_dotenv()

from flask import Flask, render_template, request, jsonify, send_from_directory
import qrcode

# Import internal modules from me-cli-sunset
from app.service.auth import AuthInstance, get_auth_for_user, get_storage_dir
from app.service.bookmark import BookmarkInstance, get_bookmark_for_user
from app.service.decoy import DecoyInstance
from app.service.decoy_manager import get_decoy_manager_for_user, DECOY_CATALOG, PACKAGE_PRESETS
from app.service.scan_manager import get_scan_manager_for_user, ScanManager
from app.type_dict import PaymentItem

from app.client.ciam import get_otp, submit_otp, get_new_token
from app.client.engsel import (
    get_profile,
    get_balance,
    get_tiering_info,
    get_family,
    get_package,
    get_package_details,
    get_addons,
    get_transaction_history,
    send_api_request,
    unsubscribe,
    dashboard_segments,
    get_notification_detail,
)
from app.client.famplan import (
    get_family_data,
    validate_msisdn,
    change_member,
)
from app.client.circle import (
    get_group_data,
    get_group_members,
    validate_circle_member,
    invite_circle_member,
    remove_circle_member,
)
from app.client.store.segments import get_segments
from app.client.store.search import get_family_list, get_store_packages
from app.client.store.redeemables import get_redeemables
from app.client.registration import dukcapil, validate_puk

from app.client.purchase.balance import settlement_balance
from app.client.purchase.qris import settlement_qris
from app.client.purchase.ewallet import settlement_multipayment
from app.client.purchase.redeem import (
    settlement_bounty,
    settlement_loyalty,
    bounty_allotment,
)
from app.menus.purchase import (
    purchase_by_family,
    purchase_n_times_by_option_code,
)
from app.menus.util import format_quota_byte

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "web", "templates"),
    static_folder=os.path.join(BASE_DIR, "web", "static"),
    static_url_path="/static"
)
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.jinja_env.auto_reload = True

# Helper function to generate QR code as base64 png
def generate_qr_base64(data_text: str) -> str:
    try:
        qr = qrcode.QRCode(
            version=1,
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=8,
            border=2,
        )
        qr.add_data(data_text)
        qr.make(fit=True)
        img = qr.make_image(fill_color="#000000", back_color="#ffffff")
        buffered = io.BytesIO()
        img.save(buffered, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buffered.getvalue()).decode("ascii")
    except Exception as e:
        print(f"Error generating QR code: {e}")
        return ""

def get_request_user_id() -> Optional[str]:
    """Extract authenticated Google user ID from header, query param, or JSON body."""
    # 1. Check HTTP header X-User-Id or X-Google-User-Id
    uid = request.headers.get("X-User-Id") or request.headers.get("X-Google-User-Id")
    if uid and str(uid).strip():
        return str(uid).strip()
    
    # 2. Check JSON payload if applicable
    if request.is_json and request.json and isinstance(request.json, dict):
        if request.json.get("user_id"):
            return str(request.json["user_id"]).strip()
        if request.json.get("google_user_id"):
            return str(request.json["google_user_id"]).strip()
            
    # 3. Check query args
    uid_arg = request.args.get("user_id") or request.args.get("google_user_id")
    if uid_arg and str(uid_arg).strip():
        return str(uid_arg).strip()
        
    return None

def get_auth_context(user_id=None):
    if user_id is None:
        user_id = get_request_user_id()
    
    if not user_id:
        # If no user ID is provided, strictly isolate: no accounts should leak!
        auth = get_auth_for_user(None)
        return None, auth.api_key, None

    auth = get_auth_for_user(user_id)
    active_user = auth.get_active_user()
    api_key = auth.api_key
    tokens = auth.get_active_tokens()
    return active_user, api_key, tokens

# ----------------- PAGE ROUTES -----------------

@app.after_request
def add_no_cache_headers(response):
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

@app.route("/")
def index():
    return render_template("index.html", cache_buster=int(time.time()))

@app.route("/privacy")
@app.route("/privacy-policy")
def privacy():
    return render_template("privacy.html", cache_buster=int(time.time()))

@app.route("/favicon.ico")
def favicon():
    return ("", 204)

# ----------------- API: GOOGLE AUTH & USER STORAGE -----------------

@app.route("/api/auth/google/config", methods=["GET"])
def api_google_config():
    return jsonify({
        "success": True,
        "client_id": os.getenv("GOOGLE_CLIENT_ID", ""),
        "scopes": "openid email profile https://www.googleapis.com/auth/drive.appdata"
    })

@app.route("/api/auth/google/session", methods=["GET", "POST"])
def api_google_session():
    if request.method == "POST":
        data = request.get_json() or {}
        user = data.get("user")
        return jsonify({"success": True, "user": user})
    return jsonify({"success": True, "active": True})

@app.route("/api/auth/google/logout", methods=["POST"])
def api_google_logout():
    return jsonify({"success": True, "message": "Logged out successfully"})

@app.route("/api/auth/google/sync-session", methods=["POST"])
def api_google_sync_session():
    """Sync user accounts and bookmarks from client/Google Drive to server session."""
    try:
        data = request.get_json() or {}
        user_id = data.get("user_id") or get_request_user_id()
        if not user_id:
            return jsonify({"success": False, "error": "user_id is required"}), 400

        auth = get_auth_for_user(user_id)
        bm = get_bookmark_for_user(user_id)

        accounts = data.get("accounts")
        if accounts is not None and isinstance(accounts, list):
            auth.refresh_tokens = []
            for acc in accounts:
                if isinstance(acc, dict) and "number" in acc and "refresh_token" in acc:
                    auth.refresh_tokens.append({
                        "number": int(acc["number"]),
                        "subscriber_id": str(acc.get("subscriber_id", "")),
                        "subscription_type": str(acc.get("subscription_type", "PREPAID")),
                        "refresh_token": str(acc["refresh_token"])
                    })
            auth.write_tokens_to_file()

            active_num = data.get("active_number")
            if active_num and str(active_num).isdigit():
                auth.set_active_user(int(active_num))
            elif len(auth.refresh_tokens) > 0:
                auth.set_active_user(auth.refresh_tokens[0]["number"])
            else:
                auth.active_user = None
                auth.write_active_number()

        bookmarks = data.get("bookmarks")
        if bookmarks is not None and isinstance(bookmarks, list):
            bm.set_bookmarks(bookmarks)

        # Sync active decoy if provided
        active_decoy = data.get("active_decoy")
        if active_decoy:
            dm = get_decoy_manager_for_user(user_id)
            dm.switch_decoy(str(active_decoy).strip())

        return jsonify({
            "success": True,
            "user_id": user_id,
            "accounts_count": len(auth.refresh_tokens),
            "bookmarks_count": len(bm.get_bookmarks())
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/auth/google/clear-user-session", methods=["POST"])
def api_google_clear_user_session():
    """Clear server-side session data for a specific user ID."""
    try:
        data = request.get_json() or {}
        user_id = data.get("user_id") or get_request_user_id()
        if user_id:
            auth = get_auth_for_user(user_id)
            auth.refresh_tokens = []
            auth.active_user = None
            auth.write_tokens_to_file()
            auth.write_active_number()
            bm = get_bookmark_for_user(user_id)
            bm.set_bookmarks([])
        return jsonify({"success": True, "message": "User session cleared"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# ----------------- API: DEC0Y MANAGEMENT & ENTITLEMENTS -----------------

@app.route("/api/decoy/entitlements", methods=["GET"])
@app.route("/api/decoy/status", methods=["GET"])
def api_decoy_entitlements():
    try:
        user_id = get_request_user_id()
        dm = get_decoy_manager_for_user(user_id)
        return jsonify(dm.get_entitlements())
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/decoy/switch", methods=["POST"])
def api_decoy_switch():
    try:
        user_id = get_request_user_id()
        data = request.get_json() or {}
        decoy_id = str(data.get("decoy_id", "")).strip()

        if not decoy_id:
            return jsonify({"success": False, "error": "decoy_id wajib diisi."}), 400

        dm = get_decoy_manager_for_user(user_id)
        success, msg, ent_data = dm.switch_decoy(decoy_id)
        
        if not success:
            if "kedaluwarsa" in msg or "tidak termasuk" in msg:
                return jsonify({"success": False, "error": msg}), 403
            return jsonify({"success": False, "error": msg}), 400

        return jsonify({
            "success": True,
            "message": msg,
            "activeDecoy": decoy_id,
            "data": ent_data
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/decoy/set-package", methods=["POST"])
def api_decoy_set_package():
    try:
        user_id = get_request_user_id()
        data = request.get_json() or {}
        pkg_id = str(data.get("package_id") or data.get("package", "premium")).strip()
        is_expired = bool(data.get("is_expired", False))
        
        dm = get_decoy_manager_for_user(user_id)
        res = dm.set_package(pkg_id, is_expired=is_expired)
        return jsonify({"success": True, "message": f"Paket berhasil diubah ke {pkg_id}", "data": res})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# ----------------- API: SCAN FAMILY CODE (BULK SCANNER) -----------------

ALLOWED_SCAN_FILES = {"list_famcode.txt", "valid_famcodes.txt", "invalid_famcodes.txt", "success.json", "scan_summary.json"}

@app.route("/api/scan/start", methods=["POST"])
def api_scan_start():
    try:
        user_id = get_request_user_id()
        sm = get_scan_manager_for_user(user_id)

        codes = []
        source_type = "paste"
        concurrency = 20
        timeout_ms = 5000
        is_enterprise = False
        migration_type = "NONE"
        job_name = ""

        # Handle multipart/form-data file upload vs JSON
        if request.content_type and "multipart/form-data" in request.content_type:
            uploaded_file = request.files.get("file")
            raw_text = request.form.get("raw_text", "")
            count_val = request.form.get("count")
            concurrency = int(request.form.get("concurrency", 20))
            timeout_ms = int(request.form.get("timeout_ms", 5000))
            is_enterprise = request.form.get("is_enterprise", "false").lower() in ("true", "1")
            migration_type = request.form.get("migration_type", "NONE")
            job_name = request.form.get("job_name", "")

            if uploaded_file and uploaded_file.filename:
                fname = uploaded_file.filename.lower()
                content = uploaded_file.read().decode("utf-8", errors="ignore")
                is_json = fname.endswith(".json")
                source_type = "json_file" if is_json else "txt_file"
                job_name = job_name or f"Upload {uploaded_file.filename}"
                codes, _, _ = ScanManager.parse_input_codes(content, is_json=is_json)
            elif count_val and str(count_val).isdigit():
                c_int = int(count_val)
                codes = ScanManager.generate_sample_codes(c_int)
                source_type = "preset"
                job_name = job_name or f"Preset Batch {c_int} Codes"
            elif raw_text:
                source_type = "paste"
                codes, _, _ = ScanManager.parse_input_codes(raw_text, is_json=False)
        else:
            data = request.get_json() or {}
            raw_text = data.get("raw_text", "")
            raw_codes_list = data.get("codes", [])
            count_val = data.get("count")
            concurrency = int(data.get("concurrency", 20))
            timeout_ms = int(data.get("timeout_ms", 5000))
            is_enterprise = bool(data.get("is_enterprise", False))
            migration_type = data.get("migration_type", "NONE")
            job_name = data.get("job_name", "")

            if count_val and str(count_val).isdigit():
                c_int = int(count_val)
                codes = ScanManager.generate_sample_codes(c_int)
                source_type = "preset"
                job_name = job_name or f"Preset Batch {c_int} Codes"
            elif raw_codes_list and isinstance(raw_codes_list, list):
                source_type = "json"
                for item in raw_codes_list:
                    if isinstance(item, str) and item.strip():
                        codes.append(item.strip())
                    elif isinstance(item, dict):
                        c = str(item.get("family_code") or item.get("code") or item.get("id") or "").strip()
                        if c:
                            codes.append(c)
            elif raw_text:
                source_type = "paste"
                codes, _, _ = ScanManager.parse_input_codes(raw_text, is_json=False)

        if not codes:
            return jsonify({"success": False, "error": "Daftar Family Code kosong atau tidak dapat diuraikan."}), 400

        # Maximum limit security check
        if len(codes) > 10000:
            codes = codes[:10000]

        job = sm.start_scan(
            codes=codes,
            concurrency=concurrency,
            timeout_ms=timeout_ms,
            is_enterprise=is_enterprise,
            migration_type=migration_type,
            source_type=source_type,
            job_name=job_name
        )

        return jsonify({
            "success": True,
            "job_id": job.job_id,
            "summary": job.to_summary()
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/scan/status/<job_id>", methods=["GET"])
def api_scan_status(job_id):
    try:
        user_id = get_request_user_id()
        sm = get_scan_manager_for_user(user_id)
        job = sm.get_job(job_id)
        if not job:
            return jsonify({"success": False, "error": "Job scan tidak ditemukan."}), 404

        return jsonify({
            "success": True,
            "summary": job.to_summary()
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/scan/results/<job_id>", methods=["GET"])
def api_scan_results(job_id):
    try:
        user_id = get_request_user_id()
        sm = get_scan_manager_for_user(user_id)
        
        filter_status = request.args.get("filter", "all").lower().strip()
        page = max(1, int(request.args.get("page", 1)))
        limit = max(5, min(int(request.args.get("limit", 50)), 500))

        res = sm.get_job_results(job_id, filter_status=filter_status, page=page, limit=limit)
        return jsonify(res)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/scan/stop/<job_id>", methods=["POST"])
def api_scan_stop(job_id):
    try:
        user_id = get_request_user_id()
        sm = get_scan_manager_for_user(user_id)
        success, msg = sm.cancel_job(job_id)
        if not success:
            return jsonify({"success": False, "error": msg}), 404
        return jsonify({"success": True, "message": msg})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/scan/history", methods=["GET"])
def api_scan_history():
    try:
        user_id = get_request_user_id()
        sm = get_scan_manager_for_user(user_id)
        return jsonify({
            "success": True,
            "history": sm.history
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/scan/history/<job_id>", methods=["DELETE"])
def api_scan_history_delete(job_id):
    try:
        user_id = get_request_user_id()
        sm = get_scan_manager_for_user(user_id)
        sm.history = [h for h in sm.history if h.get("job_id") != job_id]
        sm._save_history_metadata()
        return jsonify({"success": True, "message": "Riwayat berhasil dihapus."})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/scan/files", methods=["GET"])
def api_scan_files():
    try:
        user_id = get_request_user_id()
        sm = get_scan_manager_for_user(user_id)
        files = sm.list_generated_files()
        return jsonify({"success": True, "files": files})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/scan/download/<job_id>/<filename>", methods=["GET"])
def api_scan_download(job_id, filename):
    try:
        if filename not in ALLOWED_SCAN_FILES:
            return jsonify({"success": False, "error": "File tidak diizinkan."}), 403

        # Safe directory path
        user_id = get_request_user_id()
        storage_base = get_storage_dir(user_id)
        safe_job_id = "".join(c for c in job_id if c.isalnum() or c in ("-", "_"))
        job_dir = os.path.join(storage_base, "scans", safe_job_id)

        if not os.path.exists(os.path.join(job_dir, filename)):
            return jsonify({"success": False, "error": "File tidak ditemukan."}), 404

        return send_from_directory(job_dir, filename, as_attachment=True)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# ----------------- API: GENERATE FAMCODE (RANDOM UUID v4 TESTING GENERATOR) -----------------

@app.route("/api/generate/famcode", methods=["GET", "POST"])
def api_generate_famcode():
    try:
        count = 100
        format_type = "standard"  # standard | uppercase | nohyphen

        if request.method == "POST":
            data = request.get_json() or {}
            count = int(data.get("count", 100))
            format_type = str(data.get("format", "standard")).lower().strip()
        else:
            count = int(request.args.get("count", 100))
            format_type = str(request.args.get("format", "standard")).lower().strip()

        count = max(1, min(count, 10000))

        unique_uuids = set()
        while len(unique_uuids) < count:
            raw_u = uuid.uuid4()
            if format_type == "uppercase":
                formatted_u = str(raw_u).upper()
            elif format_type == "nohyphen":
                formatted_u = raw_u.hex
            else:
                formatted_u = str(raw_u).lower()
            unique_uuids.add(formatted_u)

        items = list(unique_uuids)

        return jsonify({
            "success": True,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "count": len(items),
            "format": format_type,
            "items": items
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# ----------------- API: STATUS & ACCOUNT -----------------

@app.route("/api/status", methods=["GET"])
def api_status():
    try:
        user_id = get_request_user_id()
        if not user_id:
            # Anonymous / not logged in with Google: return clean unauthenticated state
            return jsonify({
                "success": True,
                "logged_in": False,
                "user": None,
                "accounts": [],
                "accounts_count": 0,
                "user_id": None,
                "timestamp": int(time.time())
            })

        auth = get_auth_for_user(user_id)
        auth.load_tokens()
        active_user = auth.get_active_user()
        api_key = auth.api_key
        tokens = auth.get_active_tokens()

        saved_accounts = []
        for acc in auth.refresh_tokens:
            saved_accounts.append({
                "number": acc.get("number"),
                "subscriber_id": acc.get("subscriber_id", ""),
                "subscription_type": acc.get("subscription_type", ""),
                "is_active": (active_user is not None and acc.get("number") == active_user.get("number"))
            })

        user_info = None
        balance_info = None
        tier_info = None

        if active_user and tokens:
            try:
                raw_bal_res = send_api_request(api_key, "api/v8/packages/balance-and-credit", {"is_enterprise": False, "lang": "en"}, tokens.get("id_token"), "POST")
                if raw_bal_res and "data" in raw_bal_res:
                    b_data = raw_bal_res["data"]
                    bal_obj = b_data.get("balance", {})
                    prio_flex = b_data.get("prio_flex_balance", {})
                    
                    reg_rem = bal_obj.get("remaining", 0)
                    prio_rem = prio_flex.get("remaining", 0)
                    has_prio_flex = prio_flex.get("has_prio_flex", False)
                    
                    effective_balance = reg_rem
                    balance_label = "Pulsa Reguler"
                    if prio_rem > 0 or has_prio_flex:
                        if reg_rem == 0 and prio_rem > 0:
                            effective_balance = prio_rem
                            balance_label = "PRIO Flex"
                        elif prio_rem > 0 and reg_rem > 0:
                            effective_balance = reg_rem + prio_rem
                            balance_label = "Reguler + PRIO Flex"

                    exp_ts = bal_obj.get("expired_at", 0)
                    exp_fmt = "-"
                    if exp_ts and exp_ts > 0:
                        try:
                            dt = datetime.fromtimestamp(exp_ts)
                            exp_fmt = dt.strftime("%Y-%m-%d %H:%M")
                        except Exception:
                            exp_fmt = "-"

                    balance_info = {
                        "remaining": effective_balance,
                        "regular_balance": reg_rem,
                        "prio_flex_balance": prio_rem,
                        "has_prio_flex": has_prio_flex,
                        "balance_label": balance_label,
                        "expired_at": exp_ts,
                        "expired_at_formatted": exp_fmt
                    }
            except Exception as ex:
                balance_info = {"error": str(ex), "remaining": 0, "expired_at_formatted": "-"}

            if active_user.get("subscription_type") == "PREPAID":
                try:
                    t_data = get_tiering_info(api_key, tokens)
                    tier_info = {
                        "tier": t_data.get("tier", 0),
                        "current_point": t_data.get("current_point", 0)
                    }
                except Exception:
                    tier_info = {"tier": "N/A", "current_point": 0}

            user_info = {
                "number": active_user.get("number"),
                "subscriber_id": active_user.get("subscriber_id"),
                "subscription_type": active_user.get("subscription_type"),
                "balance": balance_info,
                "tier": tier_info,
            }

        return jsonify({
            "success": True,
            "logged_in": (active_user is not None),
            "user": user_info,
            "accounts_count": len(saved_accounts),
            "accounts": saved_accounts,
            "accounts_raw": auth.refresh_tokens,
            "active_number": active_user.get("number") if active_user else None,
            "timestamp": int(time.time())
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/auth/otp/request", methods=["POST"])
def api_auth_otp_request():
    data = request.get_json() or {}
    phone_number = str(data.get("phone_number", "")).strip()

    if not phone_number:
        return jsonify({"success": False, "error": "Nomor HP harus diisi"}), 400

    if phone_number.startswith("0"):
        phone_number = "62" + phone_number[1:]
    elif phone_number.startswith("+62"):
        phone_number = phone_number[1:]

    if not phone_number.startswith("628") or len(phone_number) < 10 or len(phone_number) > 14:
        return jsonify({"success": False, "error": "Nomor harus diawali 628 dan panjang 10-14 digit"}), 400

    try:
        subscriber_id = get_otp(phone_number)
        if subscriber_id:
            return jsonify({
                "success": True,
                "message": f"OTP berhasil dikirim ke {phone_number}",
                "phone_number": phone_number,
                "subscriber_id": subscriber_id
            })
        else:
            return jsonify({"success": False, "error": "Gagal mengirim OTP dari server CIAM"}), 400
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/auth/otp/submit", methods=["POST"])
def api_auth_otp_submit():
    data = request.get_json() or {}
    phone_number = str(data.get("phone_number", "")).strip()
    otp = str(data.get("otp", "")).strip()

    if not phone_number or not otp:
        return jsonify({"success": False, "error": "Nomor HP dan OTP harus diisi"}), 400

    if phone_number.startswith("0"):
        phone_number = "62" + phone_number[1:]
    elif phone_number.startswith("+62"):
        phone_number = phone_number[1:]

    try:
        user_id = get_request_user_id()
        auth = get_auth_for_user(user_id)
        api_key = auth.api_key
        tokens = submit_otp(api_key, "SMS", phone_number, otp)
        if tokens and "refresh_token" in tokens:
            num_int = int(phone_number)
            auth.add_refresh_token(num_int, tokens["refresh_token"])
            auth.set_active_user(num_int)
            return jsonify({
                "success": True,
                "message": f"Login berhasil untuk {phone_number}",
                "number": num_int,
                "accounts": auth.refresh_tokens,
                "active_number": num_int
            })
        else:
            return jsonify({"success": False, "error": "OTP salah atau sesi verifikasi telah kedaluwarsa"}), 400
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/auth/accounts/switch", methods=["POST"])
def api_auth_switch_account():
    data = request.get_json() or {}
    number = data.get("number")
    if not number:
        return jsonify({"success": False, "error": "Nomor akun diperlukan"}), 400

    try:
        num_int = int(number)
        user_id = get_request_user_id()
        auth = get_auth_for_user(user_id)
        res = auth.set_active_user(num_int)
        if res is not False:
            return jsonify({
                "success": True,
                "message": f"Akun aktif diubah ke {num_int}",
                "active_number": num_int,
                "accounts": auth.refresh_tokens
            })
        else:
            return jsonify({"success": False, "error": "Gagal mengaktifkan akun tersebut"}), 400
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/auth/accounts/delete", methods=["POST"])
def api_auth_delete_account():
    data = request.get_json() or {}
    number = data.get("number")
    if not number:
        return jsonify({"success": False, "error": "Nomor akun diperlukan"}), 400

    try:
        num_int = int(number)
        user_id = get_request_user_id()
        auth = get_auth_for_user(user_id)
        auth.remove_refresh_token(num_int)
        active_num = auth.active_user.get("number") if auth.active_user else None
        return jsonify({
            "success": True,
            "message": f"Akun {num_int} berhasil dihapus",
            "accounts": auth.refresh_tokens,
            "active_number": active_num
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# ----------------- API: PACKAGES -----------------

@app.route("/api/packages/my-packages", methods=["GET"])
def api_my_packages():
    active_user, api_key, tokens = get_auth_context()
    if not tokens:
        return jsonify({"success": False, "error": "Belum login"}), 401

    try:
        path = "api/v8/packages/quota-details"
        payload = {"is_enterprise": False, "lang": "en", "family_member_id": ""}
        res = send_api_request(api_key, path, payload, tokens.get("id_token"), "POST")

        if not isinstance(res, dict) or res.get("status") != "SUCCESS":
            return jsonify({"success": False, "error": "Gagal mengambil daftar paket", "raw": res}), 400

        quotas = res.get("data", {}).get("quotas", [])
        formatted_packages = []

        for q in quotas:
            benefits_list = []
            for b in q.get("benefits", []):
                data_type = b.get("data_type", "N/A")
                rem = b.get("remaining", 0)
                tot = b.get("total", 0)
                rem_formatted = str(rem)
                tot_formatted = str(tot)

                if data_type == "DATA":
                    rem_formatted = format_quota_byte(rem)
                    tot_formatted = format_quota_byte(tot)
                elif data_type == "VOICE":
                    rem_formatted = f"{rem/60:.1f} mnt"
                    tot_formatted = f"{tot/60:.1f} mnt"
                elif data_type == "TEXT":
                    rem_formatted = f"{rem} SMS"
                    tot_formatted = f"{tot} SMS"

                benefits_list.append({
                    "id": b.get("id"),
                    "name": b.get("name"),
                    "type": data_type,
                    "remaining": rem,
                    "total": tot,
                    "remaining_formatted": rem_formatted,
                    "total_formatted": tot_formatted,
                })

            formatted_packages.append({
                "name": q.get("name"),
                "quota_code": q.get("quota_code"),
                "group_name": q.get("group_name"),
                "group_code": q.get("group_code"),
                "product_subscription_type": q.get("product_subscription_type", ""),
                "product_domain": q.get("product_domain", ""),
                "benefits": benefits_list,
            })

        return jsonify({"success": True, "packages": formatted_packages, "total": len(formatted_packages)})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/packages/unsubscribe", methods=["POST"])
def api_packages_unsubscribe():
    active_user, api_key, tokens = get_auth_context()
    if not tokens:
        return jsonify({"success": False, "error": "Belum login"}), 401

    data = request.get_json() or {}
    quota_code = data.get("quota_code")
    subs_type = data.get("product_subscription_type", "")
    domain = data.get("product_domain", "")

    if not quota_code:
        return jsonify({"success": False, "error": "Quota code diperlukan"}), 400

    try:
        success = unsubscribe(api_key, tokens, quota_code, subs_type, domain)
        return jsonify({"success": success, "message": "Berhasil berhenti berlangganan" if success else "Gagal berhenti berlangganan"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/packages/hot", methods=["GET"])
def api_packages_hot():
    try:
        hot_path = "hot_data/hot.json"
        if os.path.exists(hot_path):
            with open(hot_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return jsonify({"success": True, "packages": data})
        return jsonify({"success": False, "error": "hot.json tidak ditemukan"}), 404
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/packages/hot2", methods=["GET"])
def api_packages_hot2():
    try:
        hot2_path = "hot_data/hot2.json"
        if os.path.exists(hot2_path):
            with open(hot2_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return jsonify({"success": True, "packages": data})
        return jsonify({"success": False, "error": "hot2.json tidak ditemukan"}), 404
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/packages/family", methods=["POST"])
def api_packages_family():
    active_user, api_key, tokens = get_auth_context()
    if not tokens:
        return jsonify({"success": False, "error": "Belum login"}), 401

    data = request.get_json() or {}
    family_code = data.get("family_code", "").strip()
    is_enterprise = bool(data.get("is_enterprise", False))
    migration_type = data.get("migration_type")

    if not family_code:
        return jsonify({"success": False, "error": "Family code diperlukan"}), 400

    try:
        family_data = get_family(api_key, tokens, family_code, is_enterprise, migration_type)
        if not family_data:
            return jsonify({"success": False, "error": "Gagal memuat data family atau family code tidak ditemukan"}), 404

        package_family = family_data.get("package_family", {})
        variants = family_data.get("package_variants", [])

        structured_options = []
        opt_idx = 1
        for v in variants:
            v_name = v.get("name", "")
            v_code = v.get("package_variant_code", "")
            for opt in v.get("package_options", []):
                structured_options.append({
                    "index": opt_idx,
                    "variant_name": v_name,
                    "variant_code": v_code,
                    "option_name": opt.get("name"),
                    "price": opt.get("price"),
                    "option_code": opt.get("package_option_code"),
                    "order": opt.get("order"),
                    "validity": opt.get("validity", "")
                })
                opt_idx += 1

        return jsonify({
            "success": True,
            "family_name": package_family.get("name"),
            "family_code": family_code,
            "family_type": package_family.get("package_family_type"),
            "payment_for": package_family.get("payment_for", "BUY_PACKAGE"),
            "variants_count": len(variants),
            "options": structured_options,
            "raw_data": family_data
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/packages/detail", methods=["POST"])
def api_packages_detail():
    active_user, api_key, tokens = get_auth_context()
    if not tokens:
        return jsonify({"success": False, "error": "Belum login"}), 401

    data = request.get_json() or {}
    option_code = data.get("option_code", "").strip()
    if not option_code:
        return jsonify({"success": False, "error": "Option code diperlukan"}), 400

    try:
        pkg = get_package(api_key, tokens, option_code)
        if not pkg:
            return jsonify({"success": False, "error": "Gagal memuat detail paket"}), 404

        pkg_opt = pkg.get("package_option", {})
        pkg_fam = pkg.get("package_family", {})
        pkg_var = pkg.get("package_detail_variant", {})
        pkg_addon = pkg.get("package_addon", {})

        addons = {}
        try:
            addons = get_addons(api_key, tokens, option_code) or {}
        except Exception:
            pass

        benefits_clean = []
        for b in pkg_opt.get("benefits", []):
            data_type = b.get("data_type", "N/A")
            tot = b.get("total", 0)
            tot_fmt = str(tot)
            if data_type == "DATA":
                tot_fmt = format_quota_byte(tot)
            elif data_type == "VOICE":
                tot_fmt = f"{tot/60:.1f} Menit"
            elif data_type == "TEXT":
                tot_fmt = f"{tot} SMS"

            benefits_clean.append({
                "name": b.get("name"),
                "item_id": b.get("item_id"),
                "type": data_type,
                "total": tot,
                "total_formatted": tot_fmt,
                "is_unlimited": b.get("is_unlimited", False)
            })

        return jsonify({
            "success": True,
            "name": f"{pkg_fam.get('name', '')} - {pkg_var.get('name', '')} - {pkg_opt.get('name', '')}".strip(),
            "option_name": pkg_opt.get("name"),
            "variant_name": pkg_var.get("name"),
            "family_name": pkg_fam.get("name"),
            "family_code": pkg_fam.get("package_family_code"),
            "parent_code": pkg_addon.get("parent_code", "N/A"),
            "price": pkg_opt.get("price", 0),
            "validity": pkg_opt.get("validity", ""),
            "point": pkg_opt.get("point", 0),
            "payment_for": pkg_fam.get("payment_for", "BUY_PACKAGE"),
            "plan_type": pkg_fam.get("plan_type", ""),
            "token_confirmation": pkg.get("token_confirmation", ""),
            "timestamp": pkg.get("timestamp", 0),
            "tnc": pkg_opt.get("tnc", ""),
            "benefits": benefits_clean,
            "addons": addons,
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/packages/purchase", methods=["POST"])
def api_packages_purchase():
    active_user, api_key, tokens = get_auth_context()
    if not tokens:
        return jsonify({"success": False, "error": "Belum login"}), 401

    data = request.get_json() or {}
    option_code = data.get("option_code", "").strip()
    payment_method = data.get("payment_method", "balance") # balance, balance_decoy, balance_decoy_v2, qris, qris_decoy, qris_decoy0, ewallet, redeem_bounty, redeem_loyalty, bounty_allotment, pulsa_n_times
    overwrite_amount = data.get("overwrite_amount")
    destination_msisdn = data.get("destination_msisdn", "")
    n_times = int(data.get("n_times", 1))
    delay_seconds = int(data.get("delay_seconds", 0))

    if not option_code:
        return jsonify({"success": False, "error": "Option code diperlukan"}), 400

    try:
        # Load main package details
        package = get_package(api_key, tokens, option_code)
        if not package:
            return jsonify({"success": False, "error": "Paket tidak ditemukan"}), 404

        price = package["package_option"]["price"]
        token_confirmation = package.get("token_confirmation", "")
        ts_to_sign = package.get("timestamp", int(time.time()))
        payment_for = package.get("package_family", {}).get("payment_for", "") or "BUY_PACKAGE"

        variant_name = package.get("package_detail_variant", {}).get("name", "")
        option_name = package.get("package_option", {}).get("name", "")
        item_title = f"{variant_name} {option_name}".strip()

        payment_items = [
            PaymentItem(
                item_code=option_code,
                product_type="",
                item_price=price,
                item_name=item_title,
                tax=0,
                token_confirmation=token_confirmation,
            )
        ]

        # Dispatch payment method
        if payment_method == "balance":
            amount = int(overwrite_amount) if overwrite_amount is not None else price
            res = settlement_balance(api_key, tokens, payment_items, payment_for, False, overwrite_amount=amount)
            return jsonify({"success": (res and res.get("status") == "SUCCESS"), "result": res})

        elif payment_method == "balance_decoy":
            decoy = DecoyInstance.get_decoy("balance")
            decoy_pkg = get_package(api_key, tokens, decoy["option_code"])
            if not decoy_pkg:
                return jsonify({"success": False, "error": "Gagal memuat decoy package"}), 400

            payment_items.append(
                PaymentItem(
                    item_code=decoy_pkg["package_option"]["package_option_code"],
                    product_type="",
                    item_price=decoy_pkg["package_option"]["price"],
                    item_name=decoy_pkg["package_option"]["name"],
                    tax=0,
                    token_confirmation=decoy_pkg["token_confirmation"],
                )
            )
            calc_amount = price + decoy_pkg["package_option"]["price"]
            amount = int(overwrite_amount) if overwrite_amount is not None else calc_amount
            res = settlement_balance(api_key, tokens, payment_items, payment_for, False, overwrite_amount=amount)
            if res and res.get("status") != "SUCCESS" and "Bizz-err.Amount.Total" in res.get("message", ""):
                parts = res.get("message", "").split("=")
                valid_amt = int(parts[1].strip())
                res = settlement_balance(api_key, tokens, payment_items, payment_for, False, overwrite_amount=valid_amt)
            return jsonify({"success": (res and res.get("status") == "SUCCESS"), "result": res})

        elif payment_method == "balance_decoy_v2":
            decoy = DecoyInstance.get_decoy("balance")
            decoy_pkg = get_package(api_key, tokens, decoy["option_code"])
            if not decoy_pkg:
                return jsonify({"success": False, "error": "Gagal memuat decoy package"}), 400

            payment_items.append(
                PaymentItem(
                    item_code=decoy_pkg["package_option"]["package_option_code"],
                    product_type="",
                    item_price=decoy_pkg["package_option"]["price"],
                    item_name=decoy_pkg["package_option"]["name"],
                    tax=0,
                    token_confirmation=decoy_pkg["token_confirmation"],
                )
            )
            calc_amount = price + decoy_pkg["package_option"]["price"]
            amount = int(overwrite_amount) if overwrite_amount is not None else calc_amount
            res = settlement_balance(api_key, tokens, payment_items, "🤫", False, overwrite_amount=amount, token_confirmation_idx=1)
            if res and res.get("status") != "SUCCESS" and "Bizz-err.Amount.Total" in res.get("message", ""):
                parts = res.get("message", "").split("=")
                valid_amt = int(parts[1].strip())
                res = settlement_balance(api_key, tokens, payment_items, "🤫", False, overwrite_amount=valid_amt, token_confirmation_idx=-1)
            return jsonify({"success": (res and res.get("status") == "SUCCESS"), "result": res})

        elif payment_method == "qris":
            amount = int(overwrite_amount) if overwrite_amount is not None else price
            res = settlement_qris(api_key, tokens, payment_items, payment_for, False, overwrite_amount=amount)
            qr_base64 = ""
            qris_data_str = ""
            if res and res.get("status") == "SUCCESS":
                qris_data_str = res.get("data", {}).get("qris_data", "")
                if qris_data_str:
                    qr_base64 = generate_qr_base64(qris_data_str)
            return jsonify({
                "success": (res and res.get("status") == "SUCCESS"),
                "result": res,
                "qris_data": qris_data_str,
                "qr_image": qr_base64
            })

        elif payment_method == "qris_decoy":
            decoy = DecoyInstance.get_decoy("qris")
            decoy_pkg = get_package(api_key, tokens, decoy["option_code"])
            payment_items.append(
                PaymentItem(
                    item_code=decoy_pkg["package_option"]["package_option_code"],
                    product_type="",
                    item_price=decoy_pkg["package_option"]["price"],
                    item_name=decoy_pkg["package_option"]["name"],
                    tax=0,
                    token_confirmation=decoy_pkg["token_confirmation"],
                )
            )
            calc_amount = price + decoy_pkg["package_option"]["price"]
            amount = int(overwrite_amount) if overwrite_amount is not None else calc_amount
            res = settlement_qris(api_key, tokens, payment_items, "SHARE_PACKAGE", False, overwrite_amount=amount, token_confirmation_idx=1)
            qr_base64 = ""
            qris_data_str = ""
            if res and res.get("status") == "SUCCESS":
                qris_data_str = res.get("data", {}).get("qris_data", "")
                if qris_data_str:
                    qr_base64 = generate_qr_base64(qris_data_str)
            return jsonify({
                "success": (res and res.get("status") == "SUCCESS"),
                "result": res,
                "qris_data": qris_data_str,
                "qr_image": qr_base64
            })

        elif payment_method == "qris_decoy0":
            decoy = DecoyInstance.get_decoy("qris0")
            decoy_pkg = get_package(api_key, tokens, decoy["option_code"])
            payment_items.append(
                PaymentItem(
                    item_code=decoy_pkg["package_option"]["package_option_code"],
                    product_type="",
                    item_price=decoy_pkg["package_option"]["price"],
                    item_name=decoy_pkg["package_option"]["name"],
                    tax=0,
                    token_confirmation=decoy_pkg["token_confirmation"],
                )
            )
            calc_amount = price + decoy_pkg["package_option"]["price"]
            amount = int(overwrite_amount) if overwrite_amount is not None else calc_amount
            res = settlement_qris(api_key, tokens, payment_items, "SHARE_PACKAGE", False, overwrite_amount=amount, token_confirmation_idx=1)
            qr_base64 = ""
            qris_data_str = ""
            if res and res.get("status") == "SUCCESS":
                qris_data_str = res.get("data", {}).get("qris_data", "")
                if qris_data_str:
                    qr_base64 = generate_qr_base64(qris_data_str)
            return jsonify({
                "success": (res and res.get("status") == "SUCCESS"),
                "result": res,
                "qris_data": qris_data_str,
                "qr_image": qr_base64
            })

        elif payment_method == "redeem_bounty":
            res = settlement_bounty(api_key, tokens, token_confirmation, ts_to_sign, option_code, price, item_title)
            return jsonify({"success": (res and res.get("status") == "SUCCESS"), "result": res})

        elif payment_method == "redeem_loyalty":
            res = settlement_loyalty(api_key, tokens, token_confirmation, ts_to_sign, option_code, price)
            return jsonify({"success": (res and res.get("status") == "SUCCESS"), "result": res})

        elif payment_method == "bounty_allotment":
            if not destination_msisdn:
                return jsonify({"success": False, "error": "Nomor tujuan harus diisi"}), 400
            res = bounty_allotment(api_key, tokens, ts_to_sign, destination_msisdn, option_name, option_code, token_confirmation)
            return jsonify({"success": (res and res.get("status") == "SUCCESS"), "result": res})

        elif payment_method == "pulsa_n_times":
            use_decoy = bool(data.get("use_decoy", True))
            results = []
            for i in range(1, n_times + 1):
                res_i = None
                if use_decoy:
                    decoy = DecoyInstance.get_decoy("balance")
                    decoy_pkg = get_package(api_key, tokens, decoy["option_code"])
                    items_copy = [
                        PaymentItem(
                            item_code=option_code,
                            product_type="",
                            item_price=price,
                            item_name=item_title,
                            tax=0,
                            token_confirmation=token_confirmation,
                        ),
                        PaymentItem(
                            item_code=decoy_pkg["package_option"]["package_option_code"],
                            product_type="",
                            item_price=decoy_pkg["package_option"]["price"],
                            item_name=decoy_pkg["package_option"]["name"],
                            tax=0,
                            token_confirmation=decoy_pkg["token_confirmation"],
                        )
                    ]
                    tot_amt = price + decoy_pkg["package_option"]["price"]
                    res_i = settlement_balance(api_key, tokens, items_copy, "🤫", False, overwrite_amount=tot_amt, token_confirmation_idx=1)
                else:
                    items_copy = [
                        PaymentItem(
                            item_code=option_code,
                            product_type="",
                            item_price=price,
                            item_name=item_title,
                            tax=0,
                            token_confirmation=token_confirmation,
                        )
                    ]
                    res_i = settlement_balance(api_key, tokens, items_copy, payment_for, False, overwrite_amount=price)
                results.append({"iteration": i, "result": res_i})
                if i < n_times and delay_seconds > 0:
                    time.sleep(delay_seconds)

            return jsonify({"success": True, "results": results})

        else:
            return jsonify({"success": False, "error": f"Metode pembayaran '{payment_method}' tidak dikenali"}), 400

    except Exception as e:
        return jsonify({"success": False, "error": str(e), "trace": traceback.format_exc()}), 500

@app.route("/api/packages/purchase-family-loop", methods=["POST"])
def api_packages_purchase_family_loop():
    active_user, api_key, tokens = get_auth_context()
    if not tokens:
        return jsonify({"success": False, "error": "Belum login"}), 401

    data = request.get_json() or {}
    family_code = data.get("family_code", "").strip()
    use_decoy = bool(data.get("use_decoy", True))
    delay_seconds = int(data.get("delay_seconds", 0))
    start_from_option = int(data.get("start_from_option", 1))

    if not family_code:
        return jsonify({"success": False, "error": "Family code diperlukan"}), 400

    try:
        # Capture stdout while running loop
        f_stdout = io.StringIO()
        f_stderr = io.StringIO()
        with redirect_stdout(f_stdout), redirect_stderr(f_stderr):
            purchase_by_family(
                family_code,
                use_decoy=use_decoy,
                pause_on_success=False,
                delay_seconds=delay_seconds,
                start_from_option=start_from_option
            )
        stdout_str = f_stdout.getvalue()
        stderr_str = f_stderr.getvalue()
        return jsonify({
            "success": True,
            "stdout": stdout_str,
            "stderr": stderr_str
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# ----------------- API: TRANSACTIONS & DETAILS -----------------

@app.route("/api/transactions/history", methods=["GET"])
def api_transactions_history():
    active_user, api_key, tokens = get_auth_context()
    if not tokens:
        return jsonify({"success": False, "error": "Belum login"}), 401

    try:
        data = get_transaction_history(api_key, tokens) or {}
        raw_list = data.get("list", [])
        formatted_history = []
        for t in raw_list:
            ts = t.get("timestamp", 0)
            formatted_time = ""
            if ts:
                dt = datetime.fromtimestamp(ts) - timedelta(hours=7)
                formatted_time = dt.strftime("%d %b %Y | %H:%M WIB")

            formatted_history.append({
                "title": t.get("title"),
                "price": t.get("price"),
                "payment_method_label": t.get("payment_method_label"),
                "status": t.get("status"),
                "payment_status": t.get("payment_status"),
                "timestamp": ts,
                "formatted_time": formatted_time
            })
        return jsonify({"success": True, "history": formatted_history, "total": len(formatted_history)})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# ----------------- API: FAMILY PLAN & CIRCLE -----------------

@app.route("/api/famplan/info", methods=["GET"])
def api_famplan_info():
    active_user, api_key, tokens = get_auth_context()
    if not tokens:
        return jsonify({"success": False, "error": "Belum login"}), 401

    try:
        res = get_family_data(api_key, tokens)
        return jsonify({"success": True, "data": res})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/famplan/change-member", methods=["POST"])
def api_famplan_change_member():
    active_user, api_key, tokens = get_auth_context()
    if not tokens:
        return jsonify({"success": False, "error": "Belum login"}), 401

    data = request.get_json() or {}
    parent_alias = data.get("parent_alias", "")
    alias = data.get("alias", "")
    slot_id = int(data.get("slot_id", 0))
    family_member_id = data.get("family_member_id", "")
    new_msisdn = data.get("new_msisdn", "")

    try:
        res = change_member(api_key, tokens, parent_alias, alias, slot_id, family_member_id, new_msisdn)
        return jsonify({"success": True, "result": res})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/circle/info", methods=["GET"])
def api_circle_info():
    active_user, api_key, tokens = get_auth_context()
    if not tokens:
        return jsonify({"success": False, "error": "Belum login"}), 401

    try:
        grp_data = get_group_data(api_key, tokens)
        members_data = None
        if grp_data and "data" in grp_data and "group_id" in grp_data["data"]:
            grp_id = grp_data["data"]["group_id"]
            members_data = get_group_members(api_key, tokens, grp_id)

        return jsonify({
            "success": True,
            "group": grp_data,
            "members": members_data
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/circle/validate", methods=["POST"])
def api_circle_validate():
    active_user, api_key, tokens = get_auth_context()
    if not tokens:
        return jsonify({"success": False, "error": "Belum login"}), 401

    data = request.get_json() or {}
    msisdn = data.get("msisdn", "")
    try:
        res = validate_circle_member(api_key, tokens, msisdn)
        return jsonify({"success": True, "result": res})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/circle/invite", methods=["POST"])
def api_circle_invite():
    active_user, api_key, tokens = get_auth_context()
    if not tokens:
        return jsonify({"success": False, "error": "Belum login"}), 401

    data = request.get_json() or {}
    group_id = data.get("group_id", "")
    msisdn = data.get("msisdn", "")
    try:
        res = invite_circle_member(api_key, tokens, group_id, msisdn)
        return jsonify({"success": True, "result": res})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# ----------------- API: STORE & REDEEMABLES -----------------

@app.route("/api/store/segments", methods=["GET"])
def api_store_segments():
    active_user, api_key, tokens = get_auth_context()
    if not tokens:
        return jsonify({"success": False, "error": "Belum login"}), 401

    is_enterprise = request.args.get("is_enterprise", "false").lower() == "true"
    try:
        res = get_segments(api_key, tokens, is_enterprise)
        return jsonify({"success": True, "data": res})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/store/families", methods=["POST"])
def api_store_families():
    active_user, api_key, tokens = get_auth_context()
    if not tokens:
        return jsonify({"success": False, "error": "Belum login"}), 401

    data = request.get_json() or {}
    subs_type = data.get("subs_type", active_user.get("subscription_type", "PREPAID"))
    is_enterprise = bool(data.get("is_enterprise", False))

    try:
        res = get_family_list(api_key, tokens, subs_type, is_enterprise)
        return jsonify({"success": True, "data": res})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/store/packages", methods=["POST"])
def api_store_packages():
    active_user, api_key, tokens = get_auth_context()
    if not tokens:
        return jsonify({"success": False, "error": "Belum login"}), 401

    data = request.get_json() or {}
    subs_type = data.get("subs_type", active_user.get("subscription_type", "PREPAID"))
    is_enterprise = bool(data.get("is_enterprise", False))

    try:
        res = get_store_packages(api_key, tokens, subs_type, is_enterprise)
        return jsonify({"success": True, "data": res})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/store/redeemables", methods=["GET"])
def api_store_redeemables():
    active_user, api_key, tokens = get_auth_context()
    if not tokens:
        return jsonify({"success": False, "error": "Belum login"}), 401

    is_enterprise = request.args.get("is_enterprise", "false").lower() == "true"
    try:
        res = get_redeemables(api_key, tokens, is_enterprise)
        return jsonify({"success": True, "data": res})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# ----------------- API: TOOLS & BOOKMARKS -----------------

@app.route("/api/tools/dukcapil", methods=["POST"])
def api_tools_dukcapil():
    data = request.get_json() or {}
    msisdn = data.get("msisdn", "")
    kk = data.get("kk", "")
    nik = data.get("nik", "")

    if not msisdn or not kk or not nik:
        return jsonify({"success": False, "error": "MSISDN, KK, dan NIK harus diisi"}), 400

    try:
        user_id = get_request_user_id()
        auth = get_auth_for_user(user_id)
        res = dukcapil(auth.api_key, msisdn, kk, nik)
        return jsonify({"success": True, "result": res})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/tools/validate-msisdn", methods=["POST"])
def api_tools_validate_msisdn():
    active_user, api_key, tokens = get_auth_context()
    if not tokens:
        return jsonify({"success": False, "error": "Belum login"}), 401

    data = request.get_json() or {}
    msisdn = data.get("msisdn", "")
    if not msisdn:
        return jsonify({"success": False, "error": "MSISDN harus diisi"}), 400

    try:
        res = validate_msisdn(api_key, tokens, msisdn)
        return jsonify({"success": True, "result": res})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/notifications", methods=["GET", "POST"])
def api_notifications():
    active_user, api_key, tokens = get_auth_context()
    if not tokens:
        return jsonify({"success": False, "error": "Belum login"}), 401

    try:
        if request.method == "POST":
            # Mark all as read
            notifications_res = dashboard_segments(api_key, tokens) or {}
            items = notifications_res.get("data", {}).get("notification", {}).get("data", [])
            marked_count = 0
            for item in items:
                if not item.get("is_read", False):
                    get_notification_detail(api_key, tokens, item.get("notification_id"))
                    marked_count += 1
            return jsonify({"success": True, "marked_count": marked_count})
        else:
            notifications_res = dashboard_segments(api_key, tokens) or {}
            items = notifications_res.get("data", {}).get("notification", {}).get("data", [])
            return jsonify({"success": True, "notifications": items, "total": len(items)})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/bookmarks", methods=["GET", "POST", "DELETE"])
def api_bookmarks():
    try:
        user_id = get_request_user_id()
        bm = get_bookmark_for_user(user_id)
        if request.method == "GET":
            bookmarks = bm.get_bookmarks()
            return jsonify({"success": True, "bookmarks": bookmarks})
        elif request.method == "POST":
            data = request.get_json() or {}
            success = bm.add_bookmark(
                family_code=data.get("family_code", "").strip(),
                family_name=data.get("family_name", "").strip(),
                is_enterprise=bool(data.get("is_enterprise", False)),
                variant_name=data.get("variant_name", "").strip(),
                option_name=data.get("option_name", "").strip(),
                order=int(data.get("order", 1)),
                label=data.get("label", "").strip(),
                payment_method=data.get("payment_method", "balance_decoy_v2"),
                overwrite_amount=int(data.get("overwrite_amount")) if data.get("overwrite_amount") is not None and str(data.get("overwrite_amount")).isdigit() else None,
                option_code=data.get("option_code", "").strip(),
                price=int(data.get("price", 0)),
                mode=data.get("mode", "single"),
            )
            return jsonify({"success": success, "bookmarks": bm.get_bookmarks()})
        elif request.method == "DELETE":
            data = request.get_json() or {}
            bm_id = data.get("id", "")
            if bm_id:
                success = bm.remove_bookmark_by_id(bm_id)
            else:
                success = bm.remove_bookmark(
                    family_code=data.get("family_code", ""),
                    is_enterprise=bool(data.get("is_enterprise", False)),
                    variant_name=data.get("variant_name", ""),
                    order=int(data.get("order", 1)),
                )
            return jsonify({"success": success, "bookmarks": bm.get_bookmarks()})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/bookmarks/auto-buy", methods=["POST"])
def api_bookmarks_auto_buy():
    user_id = get_request_user_id()
    active_user, api_key, tokens = get_auth_context(user_id)
    if not tokens:
        return jsonify({"success": False, "error": "Belum login"}), 401

    bm = get_bookmark_for_user(user_id)
    data = request.get_json() or {}
    bm_id = data.get("id", "")
    family_code = data.get("family_code", "").strip()
    order = int(data.get("order", 1))
    payment_method = data.get("payment_method", "balance_decoy_v2")
    overwrite_amount = data.get("overwrite_amount")
    is_enterprise = bool(data.get("is_enterprise", False))
    mode = data.get("mode", "single")

    # If bm_id provided, look up from bookmarks
    if bm_id:
        for b in bm.get_bookmarks():
            if b.get("id") == bm_id:
                family_code = b.get("family_code") or family_code
                order = int(b.get("order") or order)
                payment_method = b.get("payment_method") or payment_method
                if b.get("overwrite_amount") is not None:
                    overwrite_amount = b.get("overwrite_amount")
                is_enterprise = bool(b.get("is_enterprise", False))
                mode = b.get("mode", mode)
                break

    if not family_code:
        return jsonify({"success": False, "error": "Family code diperlukan"}), 400

    try:
        if mode == "batch_loop":
            f_stdout = io.StringIO()
            f_stderr = io.StringIO()
            with redirect_stdout(f_stdout), redirect_stderr(f_stderr):
                purchase_by_family(
                    family_code,
                    use_decoy=True,
                    pause_on_success=False,
                    delay_seconds=3,
                    start_from_option=order
                )
            return jsonify({
                "success": True,
                "mode": "batch_loop",
                "stdout": f_stdout.getvalue(),
                "stderr": f_stderr.getvalue()
            })

        # Single auto buy: resolve option code from family
        family_data = get_family(api_key, tokens, family_code, is_enterprise)
        if not family_data:
            return jsonify({"success": False, "error": f"Gagal memuat family {family_code}"}), 404

        package_variants = family_data.get("package_variants", [])
        target_opt_code = None
        target_opt_name = ""
        target_var_name = ""
        target_price = 0

        # Scan variants and options to find matching order index
        curr_order = 1
        for var in package_variants:
            v_name = var.get("name", "")
            for opt in var.get("package_options", []):
                opt_order = opt.get("order", curr_order)
                if opt_order == order or curr_order == order:
                    target_opt_code = opt.get("package_option_code")
                    target_opt_name = opt.get("name")
                    target_var_name = v_name
                    target_price = opt.get("price", 0)
                    break
                curr_order += 1
            if target_opt_code:
                break

        # Fallback to first option if not found
        if not target_opt_code and package_variants:
            first_opts = package_variants[0].get("package_options", [])
            if first_opts:
                target_opt_code = first_opts[0].get("package_option_code")
                target_opt_name = first_opts[0].get("name")
                target_var_name = package_variants[0].get("name", "")
                target_price = first_opts[0].get("price", 0)

        if not target_opt_code:
            return jsonify({"success": False, "error": f"Opsi #{order} tidak ditemukan pada family code tersebut"}), 404

        # Now perform purchase using api_packages_purchase dispatch logic
        package = get_package(api_key, tokens, target_opt_code)
        if not package:
            return jsonify({"success": False, "error": "Gagal mengambil detail paket"}), 404

        price = package["package_option"]["price"]
        token_confirmation = package.get("token_confirmation", "")
        ts_to_sign = package.get("timestamp", int(time.time()))
        payment_for = package.get("package_family", {}).get("payment_for", "") or "BUY_PACKAGE"

        item_title = f"{target_var_name} {target_opt_name}".strip()
        payment_items = [
            PaymentItem(
                item_code=target_opt_code,
                product_type="",
                item_price=price,
                item_name=item_title,
                tax=0,
                token_confirmation=token_confirmation,
            )
        ]

        if payment_method == "balance":
            amount = int(overwrite_amount) if overwrite_amount is not None else price
            res = settlement_balance(api_key, tokens, payment_items, payment_for, False, overwrite_amount=amount)
            return jsonify({"success": (res and res.get("status") == "SUCCESS"), "result": res, "option_code": target_opt_code, "package_name": item_title, "price": price})

        elif payment_method in ("balance_decoy", "balance_decoy_v2"):
            decoy = DecoyInstance.get_decoy("balance")
            decoy_pkg = get_package(api_key, tokens, decoy["option_code"])
            if not decoy_pkg:
                return jsonify({"success": False, "error": "Gagal memuat decoy package"}), 400

            payment_items.append(
                PaymentItem(
                    item_code=decoy_pkg["package_option"]["package_option_code"],
                    product_type="",
                    item_price=decoy_pkg["package_option"]["price"],
                    item_name=decoy_pkg["package_option"]["name"],
                    tax=0,
                    token_confirmation=decoy_pkg["token_confirmation"],
                )
            )
            calc_amount = price + decoy_pkg["package_option"]["price"]
            amount = int(overwrite_amount) if overwrite_amount is not None else calc_amount
            token_idx = 1 if payment_method == "balance_decoy_v2" else 0
            p_for_str = "🤫" if payment_method == "balance_decoy_v2" else payment_for
            res = settlement_balance(api_key, tokens, payment_items, p_for_str, False, overwrite_amount=amount, token_confirmation_idx=token_idx)
            if res and res.get("status") != "SUCCESS" and "Bizz-err.Amount.Total" in res.get("message", ""):
                parts = res.get("message", "").split("=")
                valid_amt = int(parts[1].strip())
                res = settlement_balance(api_key, tokens, payment_items, p_for_str, False, overwrite_amount=valid_amt, token_confirmation_idx=token_idx)
            return jsonify({"success": (res and res.get("status") == "SUCCESS"), "result": res, "option_code": target_opt_code, "package_name": item_title, "price": price})

        elif payment_method in ("qris", "qris_decoy", "qris_decoy0"):
            qr_base64 = ""
            qris_data_str = ""
            if payment_method == "qris":
                amount = int(overwrite_amount) if overwrite_amount is not None else price
                res = settlement_qris(api_key, tokens, payment_items, payment_for, False, overwrite_amount=amount)
            elif payment_method == "qris_decoy":
                decoy = DecoyInstance.get_decoy("qris")
                decoy_pkg = get_package(api_key, tokens, decoy["option_code"])
                payment_items.append(
                    PaymentItem(
                        item_code=decoy_pkg["package_option"]["package_option_code"],
                        product_type="",
                        item_price=decoy_pkg["package_option"]["price"],
                        item_name=decoy_pkg["package_option"]["name"],
                        tax=0,
                        token_confirmation=decoy_pkg["token_confirmation"],
                    )
                )
                calc_amount = price + decoy_pkg["package_option"]["price"]
                amount = int(overwrite_amount) if overwrite_amount is not None else calc_amount
                res = settlement_qris(api_key, tokens, payment_items, "SHARE_PACKAGE", False, overwrite_amount=amount, token_confirmation_idx=1)
            elif payment_method == "qris_decoy0":
                decoy = DecoyInstance.get_decoy("qris0")
                decoy_pkg = get_package(api_key, tokens, decoy["option_code"])
                payment_items.append(
                    PaymentItem(
                        item_code=decoy_pkg["package_option"]["package_option_code"],
                        product_type="",
                        item_price=decoy_pkg["package_option"]["price"],
                        item_name=decoy_pkg["package_option"]["name"],
                        tax=0,
                        token_confirmation=decoy_pkg["token_confirmation"],
                    )
                )
                calc_amount = price + decoy_pkg["package_option"]["price"]
                amount = int(overwrite_amount) if overwrite_amount is not None else calc_amount
                res = settlement_qris(api_key, tokens, payment_items, "SHARE_PACKAGE", False, overwrite_amount=amount, token_confirmation_idx=1)

            if res and res.get("status") == "SUCCESS":
                qris_data_str = res.get("data", {}).get("qris_data", "")
                if qris_data_str:
                    qr_base64 = generate_qr_base64(qris_data_str)

            return jsonify({
                "success": (res and res.get("status") == "SUCCESS"),
                "result": res,
                "qris_data": qris_data_str,
                "qr_image": qr_base64,
                "option_code": target_opt_code,
                "package_name": item_title,
                "price": price
            })

        elif payment_method == "redeem_loyalty":
            res = settlement_loyalty(api_key, tokens, token_confirmation, ts_to_sign, target_opt_code, price)
            return jsonify({"success": (res and res.get("status") == "SUCCESS"), "result": res, "option_code": target_opt_code, "package_name": item_title, "price": price})

        else:
            return jsonify({"success": False, "error": f"Metode bayar '{payment_method}' tidak didukung untuk auto-buy"}), 400

    except Exception as e:
        return jsonify({"success": False, "error": str(e), "trace": traceback.format_exc()}), 500

# ----------------- API: COMMAND RUNNER (TERMINAL INTERFACE) -----------------

ALLOWED_COMMANDS = {
    "get-profile": "Ambil profil & data akun aktif",
    "get-balance": "Ambil sisa pulsa dan masa aktif",
    "my-packages": "Lihat paket aktif & rincian kuota",
    "hot-packages": "Lihat daftar paket Hot Promo",
    "hot2-packages": "Lihat daftar paket Hot-2 Promo",
    "package-detail": "Lihat detail paket berdasarkan Option Code",
    "family-packages": "Lihat daftar paket berdasarkan Family Code",
    "purchase-package": "Beli paket berdasarkan Option Code & metode bayar",
    "purchase-family-loop": "Beli berulang semua paket dalam Family Code",
    "transaction-history": "Lihat riwayat transaksi",
    "family-plan-info": "Lihat info Akrab Organizer / Family Plan",
    "circle-info": "Lihat data Circle & anggota",
    "validate-msisdn": "Validasi nomor MSISDN",
    "dukcapil-register": "Registrasi prabayar NIK & KK",
    "store-segments": "Lihat kategori / segmen store",
    "store-families": "Cari family list di store",
    "store-packages": "Cari katalog paket di store",
    "store-redeemables": "Lihat voucher / paket redeemable",
    "get-notifications": "Ambil pesan notifikasi akun",
    "list-bookmarks": "Lihat daftar bookmark paket",
}

@app.route("/api/commands/list", methods=["GET"])
def api_commands_list():
    return jsonify({"success": True, "commands": ALLOWED_COMMANDS})

@app.route("/api/execute", methods=["POST"])
def api_execute():
    data = request.get_json() or {}
    command = data.get("command", "").strip()
    args = data.get("args", {})
    options = data.get("options", {})

    if not command:
        return jsonify({"success": False, "error": "Command parameter is required"}), 400

    if command not in ALLOWED_COMMANDS:
        return jsonify({"success": False, "error": f"Command '{command}' is not in the allowlist"}), 403

    start_time = time.time()
    stdout_capture = io.StringIO()
    stderr_capture = io.StringIO()
    exit_code = 0
    result_data = None
    success = True

    try:
        active_user, api_key, tokens = get_auth_context()

        with redirect_stdout(stdout_capture), redirect_stderr(stderr_capture):
            print(f"> Running command: me-cli {command}")
            print(f"> Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
            print("-" * 50)

            if command == "get-profile":
                if not tokens:
                    raise ValueError("User not logged in.")
                prof = get_profile(api_key, tokens["access_token"], tokens["id_token"])
                result_data = prof
                print(json.dumps(prof, indent=2))

            elif command == "get-balance":
                if not tokens:
                    raise ValueError("User not logged in.")
                bal = get_balance(api_key, tokens["id_token"])
                result_data = bal
                print(json.dumps(bal, indent=2))

            elif command == "my-packages":
                if not tokens:
                    raise ValueError("User not logged in.")
                path = "api/v8/packages/quota-details"
                payload = {"is_enterprise": False, "lang": "en", "family_member_id": ""}
                res = send_api_request(api_key, path, payload, tokens["id_token"], "POST")
                result_data = res
                print(json.dumps(res, indent=2))

            elif command == "hot-packages":
                with open("hot_data/hot.json", "r", encoding="utf-8") as f:
                    result_data = json.load(f)
                print(json.dumps(result_data, indent=2))

            elif command == "hot2-packages":
                with open("hot_data/hot2.json", "r", encoding="utf-8") as f:
                    result_data = json.load(f)
                print(json.dumps(result_data, indent=2))

            elif command == "package-detail":
                opt_code = args.get("option_code") or options.get("option_code")
                if not opt_code:
                    raise ValueError("option_code argument is required")
                pkg = get_package(api_key, tokens, opt_code)
                result_data = pkg
                print(json.dumps(pkg, indent=2))

            elif command == "family-packages":
                fam_code = args.get("family_code") or options.get("family_code")
                if not fam_code:
                    raise ValueError("family_code argument is required")
                fam = get_family(api_key, tokens, fam_code)
                result_data = fam
                print(json.dumps(fam, indent=2))

            elif command == "purchase-package":
                opt_code = args.get("option_code") or options.get("option_code")
                method = options.get("method", "balance")
                overwrite_amt = options.get("overwrite_amount")
                if not opt_code:
                    raise ValueError("option_code is required")
                package = get_package(api_key, tokens, opt_code)
                price = package["package_option"]["price"]
                tok_conf = package.get("token_confirmation", "")
                p_for = package.get("package_family", {}).get("payment_for", "BUY_PACKAGE")
                p_items = [PaymentItem(
                    item_code=opt_code,
                    product_type="",
                    item_price=price,
                    item_name=package["package_option"]["name"],
                    tax=0,
                    token_confirmation=tok_conf,
                )]
                amt = int(overwrite_amt) if overwrite_amt else price
                res = settlement_balance(api_key, tokens, p_items, p_for, False, overwrite_amount=amt)
                result_data = res
                print(json.dumps(res, indent=2))

            elif command == "purchase-family-loop":
                fam_code = args.get("family_code") or options.get("family_code")
                use_decoy = bool(options.get("use_decoy", True))
                delay = int(options.get("delay_seconds", 0))
                start_opt = int(options.get("start_from_option", 1))
                if not fam_code:
                    raise ValueError("family_code is required")
                purchase_by_family(fam_code, use_decoy, False, delay, start_opt)

            elif command == "transaction-history":
                if not tokens:
                    raise ValueError("User not logged in.")
                res = get_transaction_history(api_key, tokens)
                result_data = res
                print(json.dumps(res, indent=2))

            elif command == "family-plan-info":
                if not tokens:
                    raise ValueError("User not logged in.")
                res = get_family_data(api_key, tokens)
                result_data = res
                print(json.dumps(res, indent=2))

            elif command == "circle-info":
                if not tokens:
                    raise ValueError("User not logged in.")
                res = get_group_data(api_key, tokens)
                result_data = res
                print(json.dumps(res, indent=2))

            elif command == "validate-msisdn":
                msisdn = args.get("msisdn") or options.get("msisdn")
                if not msisdn:
                    raise ValueError("msisdn is required")
                res = validate_msisdn(api_key, tokens, msisdn)
                result_data = res
                print(json.dumps(res, indent=2))

            elif command == "dukcapil-register":
                msisdn = args.get("msisdn") or options.get("msisdn")
                kk = args.get("kk") or options.get("kk")
                nik = args.get("nik") or options.get("nik")
                if not msisdn or not kk or not nik:
                    raise ValueError("msisdn, kk, and nik are required")
                res = dukcapil(api_key, msisdn, kk, nik)
                result_data = res
                print(json.dumps(res, indent=2))

            elif command == "store-segments":
                is_ent = bool(options.get("is_enterprise", False))
                res = get_segments(api_key, tokens, is_ent)
                result_data = res
                print(json.dumps(res, indent=2))

            elif command == "store-families":
                is_ent = bool(options.get("is_enterprise", False))
                subs_type = options.get("subs_type", "PREPAID")
                res = get_family_list(api_key, tokens, subs_type, is_ent)
                result_data = res
                print(json.dumps(res, indent=2))

            elif command == "store-packages":
                is_ent = bool(options.get("is_enterprise", False))
                subs_type = options.get("subs_type", "PREPAID")
                res = get_store_packages(api_key, tokens, subs_type, is_ent)
                result_data = res
                print(json.dumps(res, indent=2))

            elif command == "store-redeemables":
                is_ent = bool(options.get("is_enterprise", False))
                res = get_redeemables(api_key, tokens, is_ent)
                result_data = res
                print(json.dumps(res, indent=2))

            elif command == "get-notifications":
                res = dashboard_segments(api_key, tokens)
                result_data = res
                print(json.dumps(res, indent=2))

            elif command == "list-bookmarks":
                bm = get_bookmark_for_user(user_id)
                result_data = bm.get_bookmarks()
                print(json.dumps(result_data, indent=2))

    except Exception as e:
        success = False
        exit_code = 1
        print(f"ERROR: {e}", file=stderr_capture)
        print(traceback.format_exc(), file=stderr_capture)

    duration = round(time.time() - start_time, 3)

    return jsonify({
        "success": success,
        "command": command,
        "stdout": stdout_capture.getvalue(),
        "stderr": stderr_capture.getvalue(),
        "exitCode": exit_code,
        "result": result_data,
        "duration": duration
    })

# ----------------- API: CONFIG DATA MANAGER (DECOY & HOT DATA) -----------------

ALLOWED_DATA_FILES = {
    "hot_data/hot.json": {"name": "HOT Promo (Catalog 1)", "type": "hot", "description": "Daftar paket promo HOT utama"},
    "hot_data/hot2.json": {"name": "HOT-2 Promo (Catalog 2)", "type": "hot", "description": "Daftar paket promo HOT versi 2 dengan opsi overwrite"},
    "decoy_data/decoy-default-balance.json": {"name": "Decoy Default (Balance/Pulsa)", "type": "decoy", "description": "Paket decoy bypass pulsa untuk pelanggan Prabayar reguler"},
    "decoy_data/decoy-default-qris.json": {"name": "Decoy Default (QRIS +1K)", "type": "decoy", "description": "Paket decoy bypass QRIS share package prabayar"},
    "decoy_data/decoy-default-qris0.json": {"name": "Decoy Default (QRIS Rp0)", "type": "decoy", "description": "Paket decoy bypass QRIS Rp0 prabayar"},
    "decoy_data/decoy-prio-balance.json": {"name": "Decoy Prioritas (Balance/Pulsa)", "type": "decoy", "description": "Paket decoy bypass pulsa untuk pelanggan Prioritas / PrioHybrid"},
    "decoy_data/decoy-prio-qris.json": {"name": "Decoy Prioritas (QRIS +1K)", "type": "decoy", "description": "Paket decoy bypass QRIS share package Prioritas"},
    "decoy_data/decoy-prio-qris0.json": {"name": "Decoy Prioritas (QRIS Rp0)", "type": "decoy", "description": "Paket decoy bypass QRIS Rp0 Prioritas"},
}

@app.route("/api/config/data-files", methods=["GET"])
def api_config_data_files():
    files_list = []
    for fpath, meta in ALLOWED_DATA_FILES.items():
        exists = os.path.exists(fpath)
        files_list.append({
            "path": fpath,
            "name": meta["name"],
            "type": meta["type"],
            "description": meta["description"],
            "exists": exists
        })
    return jsonify({"success": True, "files": files_list})

@app.route("/api/config/data-file", methods=["GET", "POST"])
def api_config_data_file():
    if request.method == "GET":
        fpath = request.args.get("file", "").strip()
        if fpath not in ALLOWED_DATA_FILES:
            return jsonify({"success": False, "error": f"File '{fpath}' tidak diizinkan atau tidak valid"}), 403

        if not os.path.exists(fpath):
            return jsonify({"success": False, "error": f"File '{fpath}' tidak ditemukan"}), 404

        try:
            with open(fpath, "r", encoding="utf-8") as f:
                content = json.load(f)
            return jsonify({
                "success": True,
                "file": fpath,
                "meta": ALLOWED_DATA_FILES[fpath],
                "data": content
            })
        except Exception as e:
            return jsonify({"success": False, "error": str(e)}), 500

    elif request.method == "POST":
        data = request.get_json() or {}
        fpath = data.get("file", "").strip()
        content = data.get("content")

        if fpath not in ALLOWED_DATA_FILES:
            return jsonify({"success": False, "error": f"File '{fpath}' tidak diizinkan"}), 403

        if content is None:
            return jsonify({"success": False, "error": "Konten JSON harus diisi"}), 400

        try:
            # If string, validate JSON
            if isinstance(content, str):
                parsed = json.loads(content)
            else:
                parsed = content

            # Write to disk cleanly
            with open(fpath, "w", encoding="utf-8") as f:
                json.dump(parsed, f, indent=4)

            # Reset Decoy memory cache so new decoy data takes effect immediately
            DecoyInstance.reset_decoys()

            return jsonify({
                "success": True,
                "message": f"File '{fpath}' berhasil diperbarui dan cache di-reset",
                "file": fpath
            })
        except Exception as e:
            return jsonify({"success": False, "error": f"Gagal menyimpan JSON: {str(e)}"}), 400


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    host = os.getenv("HOST", "0.0.0.0")
    print("=" * 60)
    print(f"🚀 MYnyak Engsel Web Server running at http://{host}:{port}")
    print("=" * 60)
    app.run(host=host, port=port, debug=False)
