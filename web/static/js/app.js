/**
 * MYnyak Engsel Web Client — Main Application Logic
 */

// Global Fetch Interceptor to attach active Google User ID to all /api requests
const _originalFetch = window.fetch;
window.fetch = function (url, options = {}) {
    options = options || {};
    const uid = window.GoogleAuth ? window.GoogleAuth.getActiveUserId() : (sessionStorage.getItem("duar_active_google_user_id") || localStorage.getItem("duar_active_google_user_id") || "");

    if (uid) {
        if (options.headers instanceof Headers) {
            if (!options.headers.has("X-User-Id")) {
                options.headers.set("X-User-Id", uid);
            }
        } else if (Array.isArray(options.headers)) {
            if (!options.headers.some(([k]) => k.toLowerCase() === "x-user-id")) {
                options.headers.push(["X-User-Id", uid]);
            }
        } else {
            options.headers = Object.assign({}, options.headers, {
                "X-User-Id": uid
            });
        }
    }
    return _originalFetch.call(this, url, options);
};

// Global State
const state = {
    user: null,
    loggedIn: false,
    accounts: [],
    currentHotCatalog: 1,
    hotPackages: [],
    myPackages: [],
    activePurchasePkg: null,
    activePurchaseFamCode: null,
    currentConfigFile: null,
    currentConfigData: null,
    isSyncingForm: false,
    decoyData: null,
    activeDecoy: "main",
};

// DOM Loaded Initialization
document.addEventListener("DOMContentLoaded", () => {
    initNavigation();
    initPaymentMethodListeners();

    // Initialize Official Google OAuth & Cloud Storage Layer
    if (window.GoogleAuth) {
        window.GoogleAuth.onAuthSuccess(async (user, isUserAction) => {
            if (isUserAction) {
                showToast(`Selamat datang, ${user.name}!`, "success");
            }

            // Immediately reset UI to clean state for new user
            state.user = null;
            state.loggedIn = false;
            state.accounts = [];
            state.myPackages = [];
            state.hotPackages = [];
            state.decoyData = null;
            updateStatusUI({ logged_in: false, user: null, accounts: [] });

            // Sync user data to isolated backend session
            if (window.CloudStorage) {
                await window.CloudStorage.syncToBackendSession();
            }

            await refreshStatus();
            await loadDecoyEntitlements();
            loadDashboardPresets();
        });

        window.GoogleAuth.onLogout(() => {
            // Reset active UI views completely
            state.user = null;
            state.loggedIn = false;
            state.accounts = [];
            state.myPackages = [];
            state.hotPackages = [];
            state.decoyData = null;
            updateStatusUI({ logged_in: false, user: null, accounts: [] });
            renderAccountsList([]);
            const dashPresets = document.getElementById("dashPresetsList");
            if (dashPresets) dashPresets.innerHTML = "";
            loadDecoyEntitlements();
        });

        window.GoogleAuth.initialize();
    } else {
        refreshStatus();
        loadDecoyEntitlements();
    }

    // Listen to hash changes for deep linking
    window.addEventListener("hashchange", () => {
        const hash = window.location.hash.replace("#", "") || "dashboard";
        switchTab(hash);
    });

    const initialHash = window.location.hash.replace("#", "") || "dashboard";
    switchTab(initialHash);
});

// ----------------- TOAST UTILITY -----------------
function showToast(message, type = "info") {
    const toastContainer = document.getElementById("toastContainer");
    if (!toastContainer) return;

    const bgClass = type === "success" ? "bg-success text-white" :
                    type === "danger" || type === "error" ? "bg-danger text-white" :
                    type === "warning" ? "bg-warning text-dark" : "bg-dark text-light border border-secondary";

    const toastId = "toast-" + Date.now();
    const html = `
        <div id="${toastId}" class="toast align-items-center ${bgClass} border-0 shadow" role="alert" aria-live="assertive" aria-atomic="true">
            <div class="d-flex">
                <div class="toast-body fs-7">${message}</div>
                <button type="button" class="btn-close ${type !== 'warning' ? 'btn-close-white' : ''} me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
            </div>
        </div>
    `;

    toastContainer.insertAdjacentHTML("beforeend", html);
    const toastElem = document.getElementById(toastId);
    const bsToast = new bootstrap.Toast(toastElem, { delay: 4000 });
    bsToast.show();
    toastElem.addEventListener("hidden.bs.toast", () => toastElem.remove());
}

// ----------------- NAVIGATION -----------------
function initNavigation() {
    document.querySelectorAll("[data-tab]").forEach(link => {
        link.addEventListener("click", (e) => {
            e.preventDefault();
            const tab = link.getAttribute("data-tab");
            switchTab(tab);
        });
    });
}

function switchTab(tabId) {
    window.location.hash = tabId;

    // Update nav links active state
    document.querySelectorAll(".sidebar .nav-link, .offcanvas-body .nav-link, .bottom-nav-item").forEach(el => {
        if (el.getAttribute("data-tab") === tabId) {
            el.classList.add("active");
        } else {
            el.classList.remove("active");
        }
    });

    // Toggle tab sections
    document.querySelectorAll(".tab-content").forEach(sec => {
        sec.classList.add("d-none");
        sec.classList.remove("active");
    });

    const target = document.getElementById("tab-" + tabId);
    if (target) {
        target.classList.remove("d-none");
        target.classList.add("active");

        // Lazy load tab data
        if (tabId === "packages") loadMyPackages();
        else if (tabId === "hot") loadHotPackages();
        else if (tabId === "transactions") loadTransactionHistory();
        else if (tabId === "famplan") { loadFamplanInfo(); loadCircleInfo(); }
        else if (tabId === "bookmarks") loadBookmarks();
        else if (tabId === "decoy") loadDecoyEntitlements();
        else if (tabId === "config") loadConfigFileList();
        else if (tabId === "scan") { if (typeof initScanTab === "function") initScanTab(); }
        else if (tabId === "generate") { if (typeof initGenerateTab === "function") initGenerateTab(); }
        else if (tabId === "terminal") {
            if (typeof initTerminalRunner === "function") initTerminalRunner();
        }
    }
}

// ----------------- STATUS & AUTH -----------------
async function refreshStatus() {
    const refreshIcon = document.getElementById("refreshIcon");
    if (refreshIcon) refreshIcon.classList.add("spin-animation");

    try {
        const res = await fetch("/api/status");
        const data = await res.json();

        state.loggedIn = data.logged_in;
        state.user = data.user;
        state.accounts = data.accounts || [];

        // Persist accounts in user CloudStorage (localStorage + Google Drive) for persistence on refresh
        if (data.accounts_raw && data.accounts_raw.length > 0 && window.CloudStorage) {
            window.CloudStorage.saveXlAccounts(data.accounts_raw, data.active_number);
        }

        updateStatusUI(data);
        loadDecoyEntitlements();
    } catch (err) {
        console.error("Error refreshing status:", err);
        showToast("Gagal memperbarui status: " + err.message, "danger");
    } finally {
        if (refreshIcon) refreshIcon.classList.remove("spin-animation");
    }
}

function setTextSafe(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text !== undefined && text !== null ? text : "-";
}

function setHtmlSafe(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html !== undefined && html !== null ? html : "";
}

function updateStatusUI(data) {
    const navUserBadge = document.getElementById("navUserBadge");
    const user = data.user;

    if (data.logged_in && user) {
        if (navUserBadge) navUserBadge.classList.remove("d-none");
        setTextSafe("navUserPhone", user.number);
        setTextSafe("navUserType", user.subscription_type || "PREPAID");

        const balVal = user.balance ? `Rp ${(user.balance.remaining || 0).toLocaleString('id-ID')}` : "Rp 0";
        const balLabel = user.balance && user.balance.balance_label ? user.balance.balance_label : "Sisa Saldo";
        setTextSafe("navUserBalance", balVal);

        // Dashboard widgets
        setTextSafe("dashPhone", user.number);
        setTextSafe("dashType", user.subscription_type || "PREPAID");
        setTextSafe("dashSubId", "SubID: " + (user.subscriber_id ? user.subscriber_id.substring(0, 10) + '...' : '-'));
        setTextSafe("dashBalanceLabel", balLabel);
        setTextSafe("dashBalance", balVal);
        
        const expLabel = (user.balance && user.balance.expired_at_formatted) ? user.balance.expired_at_formatted : "-";
        
        const expContainer = document.getElementById("dashExpContainer");
        if (expContainer) {
            if (user.balance && user.balance.has_prio_flex) {
                expContainer.innerHTML = `<span class="badge bg-info-subtle text-info font-monospace fs-9 me-1">PRIO FLEX</span> <span class="text-muted">Masa: ${expLabel}</span>`;
            } else {
                expContainer.innerHTML = `<i class="bi bi-clock me-1"></i>s/d: <span class="text-light" id="dashExp">${expLabel}</span>`;
            }
        }

        if (user.tier) {
            setTextSafe("dashPoints", `${user.tier.current_point || 0} Poin`);
            setTextSafe("dashTier", `Tier ${user.tier.tier || 0}`);
        } else {
            setTextSafe("dashPoints", "N/A");
            setTextSafe("dashTier", "-");
        }
    } else {
        if (navUserBadge) navUserBadge.classList.add("d-none");
        setTextSafe("dashPhone", "Belum Login");
        setTextSafe("dashType", "-");
        setTextSafe("dashSubId", "-");
        setTextSafe("dashBalanceLabel", "Sisa Saldo");
        setTextSafe("dashBalance", "Rp 0");
        setTextSafe("dashPoints", "-");
        setTextSafe("dashTier", "-");
        
        const expContainer = document.getElementById("dashExpContainer");
        if (expContainer) {
            expContainer.innerHTML = `<i class="bi bi-clock me-1"></i>s/d: <span class="text-light" id="dashExp">-</span>`;
        }
    }

    setTextSafe("dashAccountsCount", `${data.accounts_count || 0} Akun`);

    // Render accounts list in modal
    renderModalAccountsList(data.accounts || []);

    // Load Dashboard Notifications & Auto-Buy Presets
    loadDashboardNotifications();
    loadDashboardPresets();
}

function renderModalAccountsList(accounts) {
    const listElem = document.getElementById("modalAccountsList");
    if (!listElem) return;

    if (!accounts || accounts.length === 0) {
        listElem.innerHTML = `<div class="p-3 text-center text-muted fs-7">Belum ada akun tersimpan. Klik <b>Tambah Akun Baru</b> untuk login.</div>`;
        return;
    }

    let html = "";
    accounts.forEach((acc, idx) => {
        const activeBadge = acc.is_active ? `<span class="badge bg-success font-monospace">AKTIF</span>` : "";
        const actionBtn = acc.is_active ?
            `<button class="btn btn-xs btn-outline-success disabled">Sedang Digunakan</button>` :
            `<button class="btn btn-xs btn-outline-primary" onclick="switchAccount(${acc.number})">Gunakan</button>`;

        html += `
            <div class="list-group-item bg-dark border-secondary d-flex justify-content-between align-items-center py-2 px-3">
                <div>
                    <div class="fw-bold font-monospace fs-7 d-flex align-items-center gap-2">
                        ${acc.number} ${activeBadge}
                    </div>
                    <div class="text-muted fs-8 font-monospace">${acc.subscription_type || 'PREPAID'} | SubID: ${acc.subscriber_id ? acc.subscriber_id.substring(0, 10) + '...' : '-'}</div>
                </div>
                <div class="d-flex align-items-center gap-2">
                    ${actionBtn}
                    ${!acc.is_active ? `<button class="btn btn-xs btn-outline-danger" onclick="deleteAccount(${acc.number})"><i class="bi bi-trash"></i></button>` : ''}
                </div>
            </div>
        `;
    });

    listElem.innerHTML = html;
}

function switchAccountModalTab(tab, event) {
    if (event) event.preventDefault();
    document.querySelectorAll("#accountModalTabs .nav-link").forEach(el => el.classList.remove("active"));
    if (event && event.target) event.target.classList.add("active");

    if (tab === "list") {
        document.getElementById("subtab-account-list").classList.remove("d-none");
        document.getElementById("subtab-account-login").classList.add("d-none");
    } else {
        document.getElementById("subtab-account-list").classList.add("d-none");
        document.getElementById("subtab-account-login").classList.remove("d-none");
    }
}

async function switchAccount(number) {
    try {
        const res = await fetch("/api/auth/accounts/switch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ number })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Berhasil berganti ke akun ${number}`, "success");
            if (data.accounts && window.CloudStorage) {
                await window.CloudStorage.saveXlAccounts(data.accounts, data.active_number || number);
            }
            await refreshStatus();
        } else {
            showToast(`Gagal ganti akun: ${data.error}`, "danger");
        }
    } catch (e) {
        showToast(`Error: ${e.message}`, "danger");
    }
}

async function deleteAccount(number) {
    if (!confirm(`Yakin ingin menghapus akun ${number}?`)) return;
    try {
        const res = await fetch("/api/auth/accounts/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ number })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Akun ${number} berhasil dihapus`, "success");
            if (window.CloudStorage) {
                await window.CloudStorage.saveXlAccounts(data.accounts || [], data.active_number || null);
            }
            await refreshStatus();
        } else {
            showToast(`Gagal hapus akun: ${data.error}`, "danger");
        }
    } catch (e) {
        showToast(`Error: ${e.message}`, "danger");
    }
}

function normalizeMsisdn(val) {
    if (!val) return "";
    let clean = String(val).replace(/[\s\-\+\(\)]/g, "").trim();
    if (clean.startsWith("08")) {
        clean = "62" + clean.substring(1);
    } else if (clean.startsWith("8")) {
        clean = "62" + clean;
    }
    return clean;
}

async function requestLoginOtp() {
    const phoneInput = document.getElementById("loginPhoneInput");
    let phone = normalizeMsisdn(phoneInput.value);
    phoneInput.value = phone;
    if (!phone) {
        showToast("Masukkan nomor HP terlebih dahulu (format 628xxxx)", "warning");
        return;
    }

    const btn = document.getElementById("btnReqOtp");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Mengirim OTP...`;

    try {
        const res = await fetch("/api/auth/otp/request", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone_number: phone })
        });
        const data = await res.json();

        if (data.success) {
            showToast(data.message, "success");
            document.getElementById("stepRequestOtp").classList.add("d-none");
            document.getElementById("stepSubmitOtp").classList.remove("d-none");
            document.getElementById("otpSentPhone").textContent = data.phone_number;
        } else {
            showToast(data.error || "Gagal request OTP", "danger");
        }
    } catch (e) {
        showToast(`Error: ${e.message}`, "danger");
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="bi bi-send me-1"></i> Request OTP via SMS`;
    }
}

function backToRequestOtp() {
    document.getElementById("stepRequestOtp").classList.remove("d-none");
    document.getElementById("stepSubmitOtp").classList.add("d-none");
}

async function submitLoginOtp() {
    const phone = document.getElementById("otpSentPhone").textContent.trim();
    const otp = document.getElementById("loginOtpInput").value.trim();

    if (!otp || otp.length !== 6) {
        showToast("Masukkan 6 digit kode OTP", "warning");
        return;
    }

    const btn = document.getElementById("btnSubmitOtp");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Verifikasi...`;

    try {
        const res = await fetch("/api/auth/otp/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone_number: phone, otp })
        });
        const data = await res.json();

        if (data.success) {
            showToast(data.message, "success");
            if (data.accounts && window.CloudStorage) {
                await window.CloudStorage.saveXlAccounts(data.accounts, data.active_number || data.number);
            }
            const modalElem = document.getElementById("accountsModal");
            const modal = bootstrap.Modal.getInstance(modalElem);
            if (modal) modal.hide();
            backToRequestOtp();
            document.getElementById("loginOtpInput").value = "";
            await refreshStatus();
        } else {
            showToast(data.error || "OTP salah atau kedaluwarsa", "danger");
        }
    } catch (e) {
        showToast(`Error: ${e.message}`, "danger");
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="bi bi-check-circle me-1"></i> Verifikasi & Login`;
    }
}

// ----------------- DASHBOARD NOTIFICATIONS -----------------
async function loadDashboardNotifications() {
    const container = document.getElementById("dashNotificationsList");
    if (!container) return;

    try {
        const res = await fetch("/api/notifications");
        const data = await res.json();

        if (!data.success || !data.notifications || data.notifications.length === 0) {
            container.innerHTML = `<div class="p-3 text-center text-muted fs-7">Tidak ada notifikasi baru.</div>`;
            return;
        }

        let html = "";
        data.notifications.slice(0, 5).forEach(n => {
            const isRead = n.is_read;
            const badge = isRead ? `<span class="badge bg-secondary font-monospace fs-9">READ</span>` : `<span class="badge bg-danger font-monospace fs-9">UNREAD</span>`;
            html += `
                <div class="list-group-item bg-surface border-bottom d-flex justify-content-between align-items-start py-2 px-3">
                    <div>
                        <div class="fw-semibold fs-7 mb-1">${n.brief_message || 'Pemberitahuan'} ${badge}</div>
                        <div class="text-muted fs-8">${n.full_message || ''}</div>
                    </div>
                    <span class="text-muted fs-9 font-monospace ms-2">${n.timestamp || ''}</span>
                </div>
            `;
        });
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<div class="p-3 text-center text-muted fs-8">Gagal memuat notifikasi.</div>`;
    }
}

async function markAllNotificationsRead() {
    try {
        const res = await fetch("/api/notifications", { method: "POST" });
        const data = await res.json();
        if (data.success) {
            showToast(`${data.marked_count || 0} notifikasi ditandai dibaca`, "success");
            loadDashboardNotifications();
        }
    } catch (e) {
        showToast("Gagal update notifikasi", "danger");
    }
}

// ----------------- MY PACKAGES -----------------
async function loadMyPackages() {
    const container = document.getElementById("myPackagesContainer");
    if (!container) return;

    container.innerHTML = `<div class="col-12 text-center p-5 text-muted"><div class="spinner-border spinner-border-sm me-2"></div>Memuat paket aktif...</div>`;

    try {
        const res = await fetch("/api/packages/my-packages");
        const data = await res.json();

        if (!data.success) {
            container.innerHTML = `<div class="col-12 text-center p-5 text-danger"><i class="bi bi-exclamation-triangle me-2"></i>${data.error || 'Gagal mengambil paket'}</div>`;
            return;
        }

        const pkgs = data.packages || [];
        if (pkgs.length === 0) {
            container.innerHTML = `<div class="col-12 text-center p-5 text-muted"><i class="bi bi-box-seam fs-1 mb-2 d-block"></i>Belum ada paket aktif pada nomor ini.</div>`;
            return;
        }

        let html = "";
        pkgs.forEach((p, idx) => {
            let benefitsHtml = "";
            (p.benefits || []).forEach(b => {
                benefitsHtml += `
                    <div class="d-flex justify-content-between align-items-center bg-dark rounded px-2 py-1 mb-1 fs-8">
                        <span class="text-muted">${b.name || b.type}:</span>
                        <span class="font-monospace fw-semibold text-cyan">${b.remaining_formatted} / ${b.total_formatted}</span>
                    </div>
                `;
            });

            html += `
                <div class="col-12 col-md-6 col-xl-4">
                    <div class="card bg-surface border h-100 shadow-sm">
                        <div class="card-body d-flex flex-column">
                            <div class="d-flex justify-content-between align-items-start mb-2">
                                <h6 class="fw-bold text-light mb-0">${p.name}</h6>
                                <span class="badge bg-primary-subtle text-primary border border-primary-subtle fs-9">${p.group_name || 'Paket'}</span>
                            </div>
                            <div class="text-muted fs-8 font-monospace mb-3">Quota Code: ${p.quota_code}</div>
                            <div class="flex-grow-1 mb-3">
                                ${benefitsHtml}
                            </div>
                            <div class="d-flex gap-2 pt-2 border-top">
                                <button class="btn btn-xs btn-outline-info flex-grow-1" onclick="openPurchaseModal('${p.quota_code}')">
                                    <i class="bi bi-info-circle me-1"></i> Detail
                                </button>
                                <button class="btn btn-xs btn-outline-danger" onclick="unsubscribePackage('${p.quota_code}', '${p.product_subscription_type}', '${p.product_domain}')">
                                    <i class="bi bi-x-circle me-1"></i> Unsub
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<div class="col-12 text-center p-5 text-danger"><i class="bi bi-exclamation-triangle me-2"></i>Error: ${e.message}</div>`;
    }
}

async function unsubscribePackage(quotaCode, subsType, domain) {
    if (!confirm(`Yakin ingin berhenti berlangganan dari paket (${quotaCode})?`)) return;
    try {
        const res = await fetch("/api/packages/unsubscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                quota_code: quotaCode,
                product_subscription_type: subsType,
                product_domain: domain
            })
        });
        const data = await res.json();
        if (data.success) {
            showToast("Berhasil berhenti berlangganan paket", "success");
            loadMyPackages();
        } else {
            showToast("Gagal unsub: " + (data.error || "Gagal dari server"), "danger");
        }
    } catch (e) {
        showToast("Error: " + e.message, "danger");
    }
}

// ----------------- HOT PACKAGES -----------------
function switchHotCatalog(catNum, event) {
    if (event) event.preventDefault();
    state.currentHotCatalog = catNum;
    document.querySelectorAll("#hotTabNav .nav-link").forEach(el => el.classList.remove("active"));
    if (event && event.target) event.target.classList.add("active");
    loadHotPackages();
}

async function loadHotPackages() {
    const container = document.getElementById("hotPackagesContainer");
    if (!container) return;

    container.innerHTML = `<div class="col-12 text-center p-5 text-muted"><div class="spinner-border spinner-border-sm me-2"></div>Memuat katalog HOT ${state.currentHotCatalog}...</div>`;

    const endpoint = state.currentHotCatalog === 1 ? "/api/packages/hot" : "/api/packages/hot2";

    try {
        const res = await fetch(endpoint);
        const data = await res.json();

        if (!data.success) {
            container.innerHTML = `<div class="col-12 text-center p-5 text-danger">${data.error || 'Gagal memuat paket'}</div>`;
            return;
        }

        state.hotPackages = data.packages || [];
        renderHotPackages(state.hotPackages);
    } catch (e) {
        container.innerHTML = `<div class="col-12 text-center p-5 text-danger">Error: ${e.message}</div>`;
    }
}

function renderHotPackages(pkgs) {
    const container = document.getElementById("hotPackagesContainer");
    if (!container) return;

    if (!pkgs || pkgs.length === 0) {
        container.innerHTML = `<div class="col-12 text-center p-5 text-muted">Tidak ada paket promo ditemukan.</div>`;
        return;
    }

    let html = "";
    pkgs.forEach((p, idx) => {
        const title = p.name || `${p.family_name || ''} - ${p.variant_name || ''} - ${p.option_name || ''}`;
        const priceFmt = p.price !== undefined ? `Rp ${p.price.toLocaleString('id-ID')}` : "-";
        const code = p.option_code || p.package_option_code || "";
        const famCode = p.family_code || "";

        html += `
            <div class="col-12 col-md-6 col-xl-4 hot-item-card" data-title="${title.toLowerCase()}" data-price="${p.price || ''}">
                <div class="card bg-surface border h-100 interactive-card">
                    <div class="card-body d-flex flex-column">
                        <div class="d-flex justify-content-between align-items-start mb-2">
                            <h6 class="fw-bold text-light mb-0">${title}</h6>
                            <span class="badge bg-warning-subtle text-warning border border-warning-subtle">HOT</span>
                        </div>
                        <div class="fs-5 fw-bold text-success font-monospace mb-2">${priceFmt}</div>
                        ${famCode ? `<div class="text-muted fs-8 font-monospace mb-1 text-truncate" title="${famCode}">Fam: ${famCode}</div>` : ''}
                        ${code ? `<div class="text-muted fs-8 font-monospace mb-3 text-truncate" title="${code}">Code: ${code}</div>` : ''}
                        
                        <div class="mt-auto pt-2 border-top d-flex gap-2">
                            ${code ? `
                                <button class="btn btn-sm btn-primary w-100" onclick="openPurchaseModal('${code}', '${famCode}')">
                                    <i class="bi bi-cart-plus me-1"></i> Beli Paket
                                </button>
                            ` : `
                                <button class="btn btn-sm btn-outline-info w-100" onclick="inspectFamilyCodeFromHot('${famCode}')">
                                    <i class="bi bi-search me-1"></i> Buka Family
                                </button>
                            `}
                        </div>
                    </div>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

function filterHotPackages() {
    const q = (document.getElementById("hotSearchInput").value || "").toLowerCase();
    document.querySelectorAll(".hot-item-card").forEach(el => {
        const title = el.getAttribute("data-title") || "";
        const price = el.getAttribute("data-price") || "";
        if (title.includes(q) || price.includes(q)) {
            el.classList.remove("d-none");
        } else {
            el.classList.add("d-none");
        }
    });
}

function inspectFamilyCodeFromHot(famCode) {
    switchTab("family");
    document.getElementById("familyCodeInput").value = famCode;
    inspectFamilyCode();
}

// ----------------- FAMILY & OPTION INSPECTOR -----------------
async function inspectFamilyCode() {
    const famCode = (document.getElementById("familyCodeInput").value || "").trim();
    const isEnterprise = document.getElementById("familyIsEnterprise").checked;
    const container = document.getElementById("familyResultContainer");

    if (!famCode) {
        showToast("Masukkan Family Code terlebih dahulu", "warning");
        return;
    }

    container.innerHTML = `<div class="card bg-surface border p-5 text-center text-muted"><div class="spinner-border spinner-border-sm me-2"></div>Mengambil data Family Code: ${famCode}...</div>`;

    try {
        const res = await fetch("/api/packages/family", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ family_code: famCode, is_enterprise: isEnterprise })
        });
        const data = await res.json();

        if (!data.success) {
            container.innerHTML = `<div class="alert alert-danger"><i class="bi bi-exclamation-triangle me-2"></i>${data.error || 'Gagal memuat family'}</div>`;
            return;
        }

        const options = data.options || [];
        let optionsHtml = "";

        options.forEach(opt => {
            optionsHtml += `
                <div class="col-12 col-md-6 col-xl-4">
                    <div class="card bg-dark border h-100 p-3 d-flex flex-column">
                        <div class="d-flex justify-content-between align-items-start mb-2">
                            <span class="badge bg-secondary font-monospace">#${opt.index}</span>
                            <span class="fs-6 fw-bold text-success font-monospace">Rp ${opt.price.toLocaleString('id-ID')}</span>
                        </div>
                        <h6 class="fw-bold text-light mb-1">${opt.variant_name} - ${opt.option_name}</h6>
                        <div class="text-muted fs-8 font-monospace mb-3 text-truncate" title="${opt.option_code}">Code: ${opt.option_code}</div>
                        <div class="mt-auto d-flex gap-2">
                            <button class="btn btn-xs btn-primary flex-grow-1" onclick="openPurchaseModal('${opt.option_code}', '${famCode}')">
                                <i class="bi bi-cart me-1"></i> Beli #${opt.index}
                            </button>
                            <button class="btn btn-xs btn-outline-warning" onclick="openAddPresetFromFamily('${famCode}', '${(data.family_name || '').replace(/'/g, "\\'")}', '${(opt.variant_name || '').replace(/'/g, "\\'")}', '${(opt.option_name || '').replace(/'/g, "\\'")}', '${opt.option_code}', ${opt.index}, ${opt.price}, ${isEnterprise})" title="Simpan sebagai Preset 1-Klik Auto Buy">
                                <i class="bi bi-star"></i> Simpan
                            </button>
                        </div>
                    </div>
                </div>
            `;
        });

        container.innerHTML = `
            <div class="card bg-surface border mb-4">
                <div class="card-header bg-transparent border-bottom d-flex justify-content-between align-items-center flex-wrap gap-2">
                    <div>
                        <h5 class="fw-bold mb-0 text-light">${data.family_name || 'Family Package'}</h5>
                        <div class="text-muted fs-8 font-monospace">Code: ${data.family_code} | Tipe: ${data.family_type || '-'}</div>
                    </div>
                    <span class="badge bg-info-subtle text-info border border-info-subtle">${options.length} Opsi Tersedia</span>
                </div>
                <div class="card-body">
                    <div class="row g-3">
                        ${optionsHtml}
                    </div>
                </div>
            </div>
        `;
    } catch (e) {
        container.innerHTML = `<div class="alert alert-danger">Error: ${e.message}</div>`;
    }
}

async function inspectOptionCode() {
    const code = (document.getElementById("familyCodeInput").value || "").trim();
    if (!code) {
        showToast("Masukkan Option Code terlebih dahulu", "warning");
        return;
    }
    openPurchaseModal(code);
}

async function startBatchFamilyPurchase() {
    const famCode = (document.getElementById("familyCodeInput").value || "").trim();
    const startOpt = parseInt(document.getElementById("batchStartOpt").value || "1");
    const delay = parseInt(document.getElementById("batchDelay").value || "0");
    const useDecoy = document.getElementById("batchUseDecoy").checked;

    if (!famCode) {
        showToast("Masukkan Family Code terlebih dahulu", "warning");
        return;
    }

    if (!confirm(`Jalankan loop pembelian untuk semua opsi di Family Code ${famCode}?`)) return;

    showToast("Memulai loop pembelian batch...", "info");

    try {
        const res = await fetch("/api/packages/purchase-family-loop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                family_code: famCode,
                start_from_option: startOpt,
                delay_seconds: delay,
                use_decoy: useDecoy
            })
        });
        const data = await res.json();
        if (data.success) {
            showToast("Loop batch selesai dijalankan", "success");
            if (data.stdout) alert("Hasil Eksekusi Loop:\n\n" + data.stdout);
        } else {
            showToast("Loop gagal: " + (data.error || "Unknown error"), "danger");
        }
    } catch (e) {
        showToast("Error: " + e.message, "danger");
    }
}

// ----------------- PURCHASE MODAL & WORKFLOW -----------------
function initPaymentMethodListeners() {
    document.querySelectorAll("input[name='payMethod']").forEach(radio => {
        radio.addEventListener("change", (e) => {
            const val = e.target.value;
            const nTimesField = document.getElementById("fieldNTimes");
            const delayField = document.getElementById("fieldDelay");
            const destField = document.getElementById("fieldDestMsisdn");

            if (val === "pulsa_n_times") {
                nTimesField.classList.remove("d-none");
                delayField.classList.remove("d-none");
            } else {
                nTimesField.classList.add("d-none");
                delayField.classList.add("d-none");
            }

            if (val === "bounty_allotment") {
                destField.classList.remove("d-none");
            } else {
                destField.classList.add("d-none");
            }
        });
    });
}

async function openPurchaseModal(optionCode, familyCode = "") {
    state.activePurchasePkg = null;
    state.activePurchaseFamCode = familyCode;

    const modalElem = document.getElementById("purchaseModal");
    if (!modalElem) return;
    const bsModal = new bootstrap.Modal(modalElem);
    bsModal.show();

    setTextSafe("modalPkgName", "Memuat rincian paket...");
    setTextSafe("modalPkgCode", optionCode || "-");
    setTextSafe("modalPkgFamCode", familyCode || "-");
    setTextSafe("modalPkgPrice", "Rp ...");
    setTextSafe("modalPkgValidity", "-");
    setHtmlSafe("modalPkgBenefits", `<div class="spinner-border spinner-border-sm me-2"></div>`);
    
    const resultArea = document.getElementById("purchaseResultArea");
    if (resultArea) resultArea.classList.add("d-none");
    
    const btnExec = document.getElementById("btnExecutePurchase");
    if (btnExec) btnExec.disabled = true;

    try {
        const res = await fetch("/api/packages/detail", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ option_code: optionCode })
        });
        const data = await res.json();

        if (!data.success) {
            setTextSafe("modalPkgName", "Rincian Paket");
            setHtmlSafe("modalPkgBenefits", `<span class="text-muted fs-8">${data.error || 'Detail paket tidak tersedia, silakan lanjutkan pembelian.'}</span>`);
            if (btnExec) btnExec.disabled = false;
            return;
        }

        state.activePurchasePkg = data;
        state.activePurchaseFamCode = data.family_code || familyCode;

        setTextSafe("modalPkgName", data.name || data.option_name || "Paket");
        setTextSafe("modalPkgCode", optionCode || "-");
        setTextSafe("modalPkgFamCode", state.activePurchaseFamCode || "-");
        setTextSafe("modalPkgPrice", `Rp ${(data.price || 0).toLocaleString('id-ID')}`);
        setTextSafe("modalPkgValidity", data.validity ? `Masa Aktif: ${data.validity}` : "Tanpa Masa Aktif");
        setTextSafe("modalPkgPoint", `${data.point || 0} Poin`);

        let benefitsHtml = "";
        (data.benefits || []).forEach(b => {
            benefitsHtml += `
                <div class="benefit-pill">
                    <span class="text-muted">${b.name || b.type}:</span>
                    <span class="text-cyan font-monospace fw-semibold">${b.total_formatted}</span>
                </div>
            `;
        });
        setHtmlSafe("modalPkgBenefits", benefitsHtml || `<span class="text-muted fs-8">Tidak ada rincian benefit khusus</span>`);
        if (btnExec) btnExec.disabled = false;
    } catch (e) {
        setTextSafe("modalPkgName", "Rincian Paket");
        setHtmlSafe("modalPkgBenefits", `<span class="text-muted fs-8">Siap dibeli</span>`);
        if (btnExec) btnExec.disabled = false;
    }
}

function copyOptionCode() {
    const code = document.getElementById("modalPkgCode")?.textContent?.trim();
    if (code && code !== "-") {
        navigator.clipboard.writeText(code).then(() => {
            showToast("Option Code disalin ke clipboard", "info");
        }).catch(() => {
            showToast("Gagal menyalin Option Code", "warning");
        });
    }
}

function copyFamilyCode() {
    const code = document.getElementById("modalPkgFamCode")?.textContent?.trim();
    if (code && code !== "-") {
        navigator.clipboard.writeText(code).then(() => {
            showToast("Family Code disalin ke clipboard", "info");
        }).catch(() => {
            showToast("Gagal menyalin Family Code", "warning");
        });
    }
}

async function executePackagePurchase() {
    if (!state.activePurchasePkg) return;

    const optCode = document.getElementById("modalPkgCode").textContent.trim();
    const payMethod = document.querySelector("input[name='payMethod']:checked")?.value || "balance";
    const overwriteAmt = document.getElementById("purchaseOverwriteAmount").value.trim();
    const nTimes = parseInt(document.getElementById("purchaseNTimes").value || "1");
    const delaySecs = parseInt(document.getElementById("purchaseDelay").value || "0");
    const destMsisdn = (document.getElementById("purchaseDestMsisdn").value || "").trim();

    const btn = document.getElementById("btnExecutePurchase");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Memproses...`;

    const resArea = document.getElementById("purchaseResultArea");
    resArea.classList.remove("d-none");
    resArea.innerHTML = `<div class="p-3 bg-dark rounded border text-center text-muted"><div class="spinner-border spinner-border-sm me-2"></div>Menghubungi API pembayaran...</div>`;

    try {
        const res = await fetch("/api/packages/purchase", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                option_code: optCode,
                payment_method: payMethod,
                overwrite_amount: overwriteAmt ? parseInt(overwriteAmt) : null,
                n_times: nTimes,
                delay_seconds: delaySecs,
                destination_msisdn: destMsisdn,
            })
        });
        const data = await res.json();

        if (data.success) {
            showToast("Transaksi Berhasil Diproses!", "success");

            if (data.qr_image) {
                // QRIS Render
                resArea.innerHTML = `
                    <div class="alert alert-success border-success text-center">
                        <h6 class="fw-bold mb-2">QRIS Berhasil Di-generate!</h6>
                        <div class="qris-box my-2">
                            <img src="${data.qr_image}" alt="QRIS Code">
                        </div>
                        <div class="fs-8 text-muted mb-2">Silakan scan QRIS di atas dengan aplikasi BCA / GoPay / OVO / Dana / Mandiri dll.</div>
                        <div class="input-group input-group-sm">
                            <input type="text" class="form-control font-monospace fs-8" value="${data.qris_data}" readonly id="qrisStrCopy">
                            <button class="btn btn-outline-secondary" onclick="navigator.clipboard.writeText(document.getElementById('qrisStrCopy').value); showToast('String QRIS disalin', 'info');">Copy</button>
                        </div>
                    </div>
                `;
            } else {
                resArea.innerHTML = `
                    <div class="alert alert-success border-success">
                        <div class="fw-bold mb-1"><i class="bi bi-check-circle-fill me-2"></i>Pembelian Sukses!</div>
                        <pre class="bg-dark p-2 rounded text-light fs-8 font-monospace m-0">${JSON.stringify(data.result || data, null, 2)}</pre>
                    </div>
                `;
            }
            refreshStatus();
        } else {
            showToast("Transaksi Gagal", "danger");
            resArea.innerHTML = `
                <div class="alert alert-danger border-danger">
                    <div class="fw-bold mb-1"><i class="bi bi-x-circle-fill me-2"></i>Transaksi Gagal / Ditolak Server</div>
                    <div class="fs-8 mb-2">${data.error || 'Server menolak request transaksi'}</div>
                    <pre class="bg-dark p-2 rounded text-light fs-8 font-monospace m-0">${JSON.stringify(data.result || data.trace || data, null, 2)}</pre>
                </div>
            `;
        }
    } catch (e) {
        resArea.innerHTML = `<div class="alert alert-danger">Error: ${e.message}</div>`;
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="bi bi-bag-check-fill me-1"></i> Beli Sekarang`;
    }
}

async function bookmarkCurrentPackage() {
    if (!state.activePurchasePkg) return;
    const pkg = state.activePurchasePkg;
    const payMethod = document.querySelector("input[name='payMethod']:checked")?.value || "balance_decoy_v2";
    const overwriteAmt = document.getElementById("purchaseOverwriteAmount")?.value?.trim();

    try {
        const res = await fetch("/api/bookmarks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                family_code: state.activePurchaseFamCode || pkg.family_code || "",
                family_name: pkg.family_name || "",
                is_enterprise: false,
                variant_name: pkg.variant_name || "",
                option_name: pkg.option_name || "",
                option_code: pkg.option_code || "",
                price: pkg.price || 0,
                order: 1,
                payment_method: payMethod,
                overwrite_amount: overwriteAmt ? parseInt(overwriteAmt) : null,
                label: `${pkg.variant_name || ''} ${pkg.option_name || ''}`.trim()
            })
        });
        const data = await res.json();
        if (data.success) {
            showToast("Paket berhasil disimpan ke Preset 1-Klik Auto Buy", "success");
            loadDashboardPresets();
        } else {
            showToast("Paket sudah tersimpan di Preset", "warning");
        }
    } catch (e) {
        showToast("Error: " + e.message, "danger");
    }
}

// ----------------- TRANSACTIONS HISTORY -----------------
async function loadTransactionHistory() {
    const tbody = document.getElementById("transactionsTableBody");
    if (!tbody) return;

    tbody.innerHTML = `<tr><td colspan="7" class="text-center p-4 text-muted"><div class="spinner-border spinner-border-sm me-2"></div>Memuat riwayat...</td></tr>`;

    try {
        const res = await fetch("/api/transactions/history");
        const data = await res.json();

        if (!data.success || !data.history || data.history.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center p-4 text-muted">Tidak ada riwayat transaksi.</td></tr>`;
            return;
        }

        let html = "";
        data.history.forEach((t, idx) => {
            const statusClass = t.status === "SUCCESS" ? "bg-success" : t.status === "FAILED" ? "bg-danger" : "bg-secondary";
            const payStatusClass = t.payment_status === "PAID" ? "bg-success" : t.payment_status === "UNPAID" ? "bg-warning text-dark" : "bg-secondary";

            html += `
                <tr class="fs-8">
                    <td class="ps-3 font-monospace text-muted">${idx + 1}</td>
                    <td class="fw-semibold text-light">${t.title || '-'}</td>
                    <td class="font-monospace text-success">${t.price || '-'}</td>
                    <td><span class="badge bg-dark border border-secondary font-monospace">${t.payment_method_label || '-'}</span></td>
                    <td class="text-muted font-monospace">${t.formatted_time || '-'}</td>
                    <td><span class="badge ${statusClass} font-monospace">${t.status || '-'}</span></td>
                    <td class="pe-3"><span class="badge ${payStatusClass} font-monospace">${t.payment_status || '-'}</span></td>
                </tr>
            `;
        });

        tbody.innerHTML = html;
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center p-4 text-danger">Error: ${e.message}</td></tr>`;
    }
}

// ----------------- FAMILY PLAN & CIRCLE -----------------
async function loadFamplanInfo() {
    const container = document.getElementById("famplanInfoContainer");
    if (!container) return;

    try {
        const res = await fetch("/api/famplan/info");
        const data = await res.json();
        container.innerHTML = `<pre class="bg-dark p-3 rounded font-monospace fs-8 text-light m-0 overflow-auto" style="max-height: 350px;">${JSON.stringify(data.data || data, null, 2)}</pre>`;
    } catch (e) {
        container.innerHTML = `<div class="text-danger fs-8">Error: ${e.message}</div>`;
    }
}

async function loadCircleInfo() {
    const container = document.getElementById("circleInfoContainer");
    if (!container) return;

    try {
        const res = await fetch("/api/circle/info");
        const data = await res.json();
        container.innerHTML = `<pre class="bg-dark p-3 rounded font-monospace fs-8 text-light m-0 overflow-auto" style="max-height: 350px;">${JSON.stringify(data, null, 2)}</pre>`;
    } catch (e) {
        container.innerHTML = `<div class="text-danger fs-8">Error: ${e.message}</div>`;
    }
}

// ----------------- STORE BROWSER -----------------
async function loadStoreSegments() {
    const container = document.getElementById("storeResultContainer");
    container.innerHTML = `<div class="col-12 text-center p-5 text-muted"><div class="spinner-border spinner-border-sm me-2"></div>Memuat segmen store...</div>`;
    try {
        const res = await fetch("/api/store/segments");
        const data = await res.json();
        container.innerHTML = `<div class="col-12"><pre class="bg-dark p-3 rounded font-monospace fs-8 text-light overflow-auto" style="max-height: 450px;">${JSON.stringify(data.data || data, null, 2)}</pre></div>`;
    } catch (e) {
        container.innerHTML = `<div class="col-12 text-danger">Error: ${e.message}</div>`;
    }
}

async function loadStoreFamilies() {
    const container = document.getElementById("storeResultContainer");
    container.innerHTML = `<div class="col-12 text-center p-5 text-muted"><div class="spinner-border spinner-border-sm me-2"></div>Memuat family list store...</div>`;
    try {
        const res = await fetch("/api/store/families", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ is_enterprise: false })
        });
        const data = await res.json();
        container.innerHTML = `<div class="col-12"><pre class="bg-dark p-3 rounded font-monospace fs-8 text-light overflow-auto" style="max-height: 450px;">${JSON.stringify(data.data || data, null, 2)}</pre></div>`;
    } catch (e) {
        container.innerHTML = `<div class="col-12 text-danger">Error: ${e.message}</div>`;
    }
}

async function loadStoreRedeemables() {
    const container = document.getElementById("storeResultContainer");
    container.innerHTML = `<div class="col-12 text-center p-5 text-muted"><div class="spinner-border spinner-border-sm me-2"></div>Memuat redeemables store...</div>`;
    try {
        const res = await fetch("/api/store/redeemables");
        const data = await res.json();
        container.innerHTML = `<div class="col-12"><pre class="bg-dark p-3 rounded font-monospace fs-8 text-light overflow-auto" style="max-height: 450px;">${JSON.stringify(data.data || data, null, 2)}</pre></div>`;
    } catch (e) {
        container.innerHTML = `<div class="col-12 text-danger">Error: ${e.message}</div>`;
    }
}

// ----------------- TOOLS -----------------
async function executeValidateMsisdn() {
    const msisdn = (document.getElementById("toolMsisdnInput").value || "").trim();
    const resElem = document.getElementById("toolMsisdnResult");
    if (!msisdn) {
        showToast("Masukkan MSISDN terlebih dahulu", "warning");
        return;
    }
    resElem.innerHTML = `<div class="spinner-border spinner-border-sm me-2"></div>Validasi...`;
    try {
        const res = await fetch("/api/tools/validate-msisdn", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ msisdn })
        });
        const data = await res.json();
        resElem.innerHTML = `<pre class="bg-dark p-2 rounded fs-8 font-monospace text-light m-0">${JSON.stringify(data.result || data, null, 2)}</pre>`;
    } catch (e) {
        resElem.innerHTML = `<div class="text-danger fs-8">Error: ${e.message}</div>`;
    }
}

async function executeDukcapilRegist() {
    const msisdn = (document.getElementById("dukcapilMsisdn").value || "").trim();
    const kk = (document.getElementById("dukcapilKk").value || "").trim();
    const nik = (document.getElementById("dukcapilNik").value || "").trim();
    const resElem = document.getElementById("dukcapilResult");

    if (!msisdn || !kk || !nik) {
        showToast("Lengkapi MSISDN, KK, dan NIK", "warning");
        return;
    }

    resElem.innerHTML = `<div class="spinner-border spinner-border-sm me-2"></div>Submit registrasi...`;
    try {
        const res = await fetch("/api/tools/dukcapil", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ msisdn, kk, nik })
        });
        const data = await res.json();
        resElem.innerHTML = `<pre class="bg-dark p-2 rounded fs-8 font-monospace text-light m-0">${JSON.stringify(data.result || data, null, 2)}</pre>`;
    } catch (e) {
        resElem.innerHTML = `<div class="text-danger fs-8">Error: ${e.message}</div>`;
    }
}

// ----------------- 1-CLICK AUTO BUY PRESETS & BOOKMARKS -----------------

function getPaymentMethodBadge(method) {
    if (method === "balance_decoy_v2") return `<span class="badge bg-warning text-dark font-monospace fs-9">🛡️ Pulsa + Decoy V2</span>`;
    if (method === "balance_decoy") return `<span class="badge bg-secondary font-monospace fs-9">⚡ Pulsa + Decoy V1</span>`;
    if (method === "balance") return `<span class="badge bg-primary-subtle text-primary font-monospace fs-9">💰 Pulsa Reguler</span>`;
    if (method === "qris_decoy") return `<span class="badge bg-info-subtle text-info font-monospace fs-9">🎯 QRIS + Decoy (+1K)</span>`;
    if (method === "qris_decoy0") return `<span class="badge bg-info-subtle text-info font-monospace fs-9">🎯 QRIS + Decoy (Rp0)</span>`;
    if (method === "qris") return `<span class="badge bg-cyan-subtle text-cyan font-monospace fs-9">📱 QRIS Direct</span>`;
    if (method === "redeem_loyalty") return `<span class="badge bg-success-subtle text-success font-monospace fs-9">🎁 Tukar Poin</span>`;
    return `<span class="badge bg-dark border border-secondary font-monospace fs-9">${method || 'balance'}</span>`;
}

async function loadDashboardPresets() {
    const container = document.getElementById("dashPresetsContainer");
    if (!container) return;

    try {
        const res = await fetch("/api/bookmarks");
        const data = await res.json();
        const bookmarks = data.bookmarks || [];
        state.bookmarks = bookmarks;

        if (bookmarks.length === 0) {
            container.innerHTML = `
                <div class="col-12 text-center py-2 text-muted fs-8">
                    <span>Belum ada preset 1-klik tersimpan.</span>
                    <button class="btn btn-xs btn-link text-warning text-decoration-none fw-bold ms-1" onclick="openAddPresetModal()">
                        <i class="bi bi-plus-circle me-1"></i>+ Tambah Preset Famcode
                    </button>
                </div>
            `;
            return;
        }

        let html = "";
        bookmarks.slice(0, 6).forEach(bm => {
            const label = bm.label || `${bm.family_name || 'Fam'} #${bm.order}`;
            const priceStr = bm.price ? `Rp ${bm.price.toLocaleString('id-ID')}` : (bm.overwrite_amount ? `Rp ${bm.overwrite_amount.toLocaleString('id-ID')}` : 'Rp -');
            const isBatch = bm.mode === "batch_loop";

            html += `
                <div class="col-12 col-md-6 col-xl-4">
                    <div class="dash-preset-chip d-flex justify-content-between align-items-center gap-2">
                        <div class="min-w-0">
                            <div class="fw-bold text-light fs-8 text-truncate mb-0.5">${label}</div>
                            <div class="d-flex align-items-center gap-1.5 flex-wrap">
                                <span class="text-success fs-9 font-monospace fw-semibold">${priceStr}</span>
                                ${getPaymentMethodBadge(bm.payment_method)}
                                ${isBatch ? `<span class="badge bg-danger font-monospace fs-9">LOOP</span>` : ''}
                            </div>
                        </div>
                        <button class="btn btn-xs btn-autobuy flex-shrink-0 px-2.5 py-1" id="btnDashAutoBuy-${bm.id}" onclick="triggerOneClickAutoBuy('${bm.id}', this)" title="Eksekusi Pembelian 1-Klik Sekarang">
                            <i class="bi bi-lightning-charge-fill me-1"></i> 1-Klik Beli
                        </button>
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<div class="col-12 text-danger fs-8">Gagal memuat preset: ${e.message}</div>`;
    }
}

async function loadBookmarks() {
    const container = document.getElementById("bookmarksContainer");
    if (!container) return;
    container.innerHTML = `<div class="col-12 text-center p-5 text-muted"><div class="spinner-border spinner-border-sm me-2"></div>Memuat preset...</div>`;

    try {
        const res = await fetch("/api/bookmarks");
        const data = await res.json();
        const bookmarks = data.bookmarks || [];
        state.bookmarks = bookmarks;

        if (bookmarks.length === 0) {
            container.innerHTML = `
                <div class="col-12 text-center p-5 text-muted">
                    <i class="bi bi-lightning-charge fs-1 mb-2 d-block text-warning opacity-75"></i>
                    <h6 class="fw-bold text-light">Belum Ada Preset 1-Klik Auto Buy</h6>
                    <p class="fs-8 text-muted mb-3">Simpan Family Code dengan metode pembayaran untuk eksekusi langsung dalam 1 klik tanpa konfirmasi ulang.</p>
                    <button class="btn btn-sm btn-warning text-dark fw-semibold" onclick="openAddPresetModal()">
                        <i class="bi bi-plus-lg me-1"></i> Buat Preset Pertama
                    </button>
                </div>
            `;
            return;
        }

        let html = "";
        bookmarks.forEach(bm => {
            const title = bm.label || `${bm.family_name || 'Family Package'} - ${bm.variant_name || ''} - ${bm.option_name || ''}`.replace(/^ - | - $/g, '');
            const priceDisplay = bm.price ? `Rp ${bm.price.toLocaleString('id-ID')}` : "-";
            const overwriteText = (bm.overwrite_amount !== null && bm.overwrite_amount !== undefined) ?
                `<span class="badge bg-warning text-dark font-monospace fs-9">Overwrite: Rp ${bm.overwrite_amount.toLocaleString('id-ID')}</span>` : '';
            const isBatch = bm.mode === "batch_loop";

            html += `
                <div class="col-12 col-md-6 col-xl-4">
                    <div class="preset-card h-100 p-3 d-flex flex-column">
                        <div class="d-flex justify-content-between align-items-start mb-2 gap-2">
                            <div class="d-flex flex-wrap gap-1">
                                <span class="badge bg-dark border border-warning text-warning font-monospace fs-9">#${bm.order}</span>
                                ${getPaymentMethodBadge(bm.payment_method)}
                                ${isBatch ? `<span class="badge bg-danger font-monospace fs-9">BATCH LOOP</span>` : ''}
                                ${overwriteText}
                            </div>
                            <button class="btn btn-xs btn-outline-danger" onclick="deleteBookmarkById('${bm.id}')" title="Hapus Preset">
                                <i class="bi bi-trash"></i>
                            </button>
                        </div>

                        <h6 class="fw-bold text-light mb-1 text-truncate" title="${title}">${title}</h6>
                        <div class="fs-5 fw-bold text-success font-monospace mb-2">${priceDisplay}</div>

                        <div class="bg-darker rounded p-2 mb-3 fs-9 font-monospace">
                            <div class="text-muted text-truncate mb-0.5">Fam: <span class="text-light">${bm.family_code}</span></div>
                            <div class="text-muted">Target: <span class="text-info">${bm.variant_name || 'Variant'} - ${bm.option_name || 'Opsi ' + bm.order}</span></div>
                        </div>

                        <div class="mt-auto d-flex flex-column gap-2">
                            <button class="btn btn-sm btn-autobuy w-100 py-1.5" id="btnAutoBuy-${bm.id}" onclick="triggerOneClickAutoBuy('${bm.id}', this)">
                                <i class="bi bi-lightning-charge-fill me-1"></i> ⚡ 1-Click Auto Buy
                            </button>
                            <div class="d-flex gap-2">
                                <button class="btn btn-xs btn-outline-info flex-grow-1" onclick="inspectFamilyCodeFromHot('${bm.family_code}')">
                                    <i class="bi bi-search me-1"></i> Buka Family
                                </button>
                                <button class="btn btn-xs btn-outline-secondary" onclick="openEditPresetModal('${bm.id}')" title="Edit Pengaturan Preset">
                                    <i class="bi bi-pencil"></i> Edit
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;
        loadDashboardPresets();
    } catch (e) {
        container.innerHTML = `<div class="col-12 text-danger">Error: ${e.message}</div>`;
    }
}

function openAddPresetModal(prefill = {}) {
    document.getElementById("presetEditId").value = prefill.id || "";
    document.getElementById("presetLabelInput").value = prefill.label || "";
    document.getElementById("presetFamCodeInput").value = prefill.family_code || "";
    document.getElementById("presetOrderInput").value = prefill.order || 1;
    document.getElementById("presetPaymentMethodInput").value = prefill.payment_method || "balance_decoy_v2";
    document.getElementById("presetOverwriteAmountInput").value = prefill.overwrite_amount !== undefined && prefill.overwrite_amount !== null ? prefill.overwrite_amount : "";
    document.getElementById("presetIsEnterprise").checked = !!prefill.is_enterprise;
    document.getElementById("presetModeInput").value = prefill.mode || "single";
    document.getElementById("presetQuickInspectResult").classList.add("d-none");

    const modalElem = document.getElementById("addPresetModal");
    const modal = new bootstrap.Modal(modalElem);
    modal.show();
}

function openAddPresetFromFamily(familyCode, familyName, variantName, optionName, optionCode, order, price, isEnterprise) {
    const label = `${familyName ? familyName + ' - ' : ''}${variantName || ''} ${optionName || ''}`.trim() || `Opsi #${order}`;
    openAddPresetModal({
        family_code: familyCode,
        label: label,
        order: order,
        price: price,
        is_enterprise: isEnterprise,
        payment_method: "balance_decoy_v2",
    });
}

function openEditPresetModal(bmId) {
    const bm = (state.bookmarks || []).find(b => b.id === bmId);
    if (!bm) {
        showToast("Preset tidak ditemukan", "warning");
        return;
    }
    openAddPresetModal(bm);
}

async function inspectPresetFamCodeLive() {
    const famCode = (document.getElementById("presetFamCodeInput").value || "").trim();
    const isEnt = document.getElementById("presetIsEnterprise").checked;
    const resElem = document.getElementById("presetQuickInspectResult");

    if (!famCode) {
        showToast("Masukkan Family Code terlebih dahulu", "warning");
        return;
    }

    resElem.classList.remove("d-none");
    resElem.innerHTML = `<div class="spinner-border spinner-border-sm me-2"></div>Memeriksa Family Code...`;

    try {
        const res = await fetch("/api/packages/family", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ family_code: famCode, is_enterprise: isEnt })
        });
        const data = await res.json();

        if (data.success) {
            const count = (data.options || []).length;
            resElem.innerHTML = `
                <div class="text-success fw-semibold"><i class="bi bi-check-circle me-1"></i>Family Ditemukan!</div>
                <div><b>${data.family_name || 'Family Package'}</b> (${count} opsi tersedia)</div>
            `;
            const labelInput = document.getElementById("presetLabelInput");
            if (labelInput && !labelInput.value) {
                labelInput.value = data.family_name || "";
            }
        } else {
            resElem.innerHTML = `<div class="text-danger"><i class="bi bi-x-circle me-1"></i>${data.error || 'Family tidak ditemukan'}</div>`;
        }
    } catch (e) {
        resElem.innerHTML = `<div class="text-danger">Error: ${e.message}</div>`;
    }
}

async function saveAutoBuyPreset() {
    const famCode = (document.getElementById("presetFamCodeInput").value || "").trim();
    const label = (document.getElementById("presetLabelInput").value || "").trim();
    const order = parseInt(document.getElementById("presetOrderInput").value || "1");
    const mode = document.getElementById("presetModeInput").value || "single";
    const payMethod = document.getElementById("presetPaymentMethodInput").value || "balance_decoy_v2";
    const overwriteAmt = document.getElementById("presetOverwriteAmountInput").value.trim();
    const isEnt = document.getElementById("presetIsEnterprise").checked;
    const editId = document.getElementById("presetEditId").value;

    if (!famCode) {
        showToast("Family Code harus diisi", "warning");
        return;
    }

    const btn = document.getElementById("btnSavePreset");
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Menyimpan...`;
    }

    try {
        const res = await fetch("/api/bookmarks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: editId || undefined,
                family_code: famCode,
                label: label,
                order: order,
                mode: mode,
                payment_method: payMethod,
                overwrite_amount: overwriteAmt ? parseInt(overwriteAmt) : null,
                is_enterprise: isEnt
            })
        });
        const data = await res.json();

        if (data.success) {
            showToast("Preset 1-Klik Auto Buy berhasil disimpan!", "success");
            const modalElem = document.getElementById("addPresetModal");
            const modal = bootstrap.Modal.getInstance(modalElem);
            if (modal) modal.hide();
            loadBookmarks();
            loadDashboardPresets();
        } else {
            showToast("Gagal menyimpan preset: " + (data.error || "Unknown"), "danger");
        }
    } catch (e) {
        showToast("Error: " + e.message, "danger");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<i class="bi bi-save me-1"></i> Simpan Preset`;
        }
    }
}

async function triggerOneClickAutoBuy(presetId, btnElem) {
    let originalHtml = "";
    if (btnElem) {
        originalHtml = btnElem.innerHTML;
        btnElem.disabled = true;
        btnElem.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Buying...`;
    }

    showToast("⚡ Menjalankan 1-Klik Auto Buy...", "info");

    const resultModalElem = document.getElementById("autoBuyResultModal");
    const resultModalBody = document.getElementById("autoBuyResultModalBody");
    const bsResultModal = new bootstrap.Modal(resultModalElem);

    try {
        const res = await fetch("/api/bookmarks/auto-buy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: presetId })
        });
        const data = await res.json();

        if (data.success) {
            if (data.qr_image) {
                // QRIS Render
                showToast("QRIS Auto Buy Berhasil Dibuat!", "success");
                resultModalBody.innerHTML = `
                    <div class="alert alert-success border-success text-center">
                        <h6 class="fw-bold mb-2">QRIS 1-Klik Siap Di-scan!</h6>
                        <div class="qris-box my-2">
                            <img src="${data.qr_image}" alt="QRIS Code">
                        </div>
                        <div class="fs-8 text-muted mb-2">Paket: <b>${data.package_name || '-'}</b> (Rp ${(data.price || 0).toLocaleString('id-ID')})</div>
                        <div class="input-group input-group-sm mt-2">
                            <input type="text" class="form-control font-monospace fs-8" value="${data.qris_data}" readonly id="qrisAutoBuyCopy">
                            <button class="btn btn-outline-secondary" onclick="navigator.clipboard.writeText(document.getElementById('qrisAutoBuyCopy').value); showToast('String QRIS disalin', 'info');">Copy</button>
                        </div>
                    </div>
                `;
                bsResultModal.show();
            } else if (data.mode === "batch_loop") {
                showToast("Batch Loop Pembelian Selesai!", "success");
                resultModalBody.innerHTML = `
                    <div class="alert alert-success border-success">
                        <div class="fw-bold mb-2"><i class="bi bi-check-circle-fill me-2"></i>Batch Loop Selesai!</div>
                        <pre class="bg-dark p-2 rounded text-light fs-8 font-monospace m-0 overflow-auto" style="max-height: 250px;">${data.stdout || 'Loop completed'}</pre>
                    </div>
                `;
                bsResultModal.show();
                refreshStatus();
            } else {
                showToast(`⚡ Pembelian Sukses: ${data.package_name || 'Paket'}!`, "success");
                resultModalBody.innerHTML = `
                    <div class="alert alert-success border-success">
                        <div class="fw-bold mb-1"><i class="bi bi-check-circle-fill me-2"></i>Pembelian 1-Klik Berhasil!</div>
                        <div class="fs-8 mb-2">Paket: <b>${data.package_name || '-'}</b> (Rp ${(data.price || 0).toLocaleString('id-ID')})</div>
                        <pre class="bg-dark p-2 rounded text-light fs-8 font-monospace m-0">${JSON.stringify(data.result || data, null, 2)}</pre>
                    </div>
                `;
                bsResultModal.show();
                refreshStatus();
            }
        } else {
            showToast("Pembelian Gagal: " + (data.error || "Ditolak server"), "danger");
            resultModalBody.innerHTML = `
                <div class="alert alert-danger border-danger">
                    <div class="fw-bold mb-1"><i class="bi bi-x-circle-fill me-2"></i>1-Klik Auto Buy Gagal</div>
                    <div class="fs-8 mb-2">${data.error || 'Server menolak request transaksi'}</div>
                    <pre class="bg-dark p-2 rounded text-light fs-8 font-monospace m-0">${JSON.stringify(data.result || data.trace || data, null, 2)}</pre>
                </div>
            `;
            bsResultModal.show();
        }
    } catch (e) {
        showToast("Error Auto Buy: " + e.message, "danger");
        resultModalBody.innerHTML = `<div class="alert alert-danger">Error: ${e.message}</div>`;
        bsResultModal.show();
    } finally {
        if (btnElem) {
            btnElem.disabled = false;
            btnElem.innerHTML = originalHtml;
        }
    }
}

async function deleteBookmarkById(bmId) {
    if (!confirm("Hapus preset 1-klik ini?")) return;
    try {
        const res = await fetch("/api/bookmarks", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: bmId })
        });
        const data = await res.json();
        if (data.success) {
            showToast("Preset dihapus", "info");
            loadBookmarks();
            loadDashboardPresets();
        }
    } catch (e) {
        showToast("Error: " + e.message, "danger");
    }
}


// ----------------- CONFIG & DATA MANAGER (DECOY & HOT DATA) -----------------

async function loadConfigFileList() {
    const listElem = document.getElementById("configFilesList");
    if (!listElem) return;

    listElem.innerHTML = `<div class="p-3 text-center text-muted"><div class="spinner-border spinner-border-sm me-2"></div>Memuat daftar file...</div>`;

    try {
        const res = await fetch("/api/config/data-files");
        const data = await res.json();

        if (!data.success || !data.files || data.files.length === 0) {
            listElem.innerHTML = `<div class="p-3 text-center text-muted fs-8">Tidak ada file konfigurasi ditemukan.</div>`;
            return;
        }

        let html = "";
        data.files.forEach(f => {
            const isHot = f.type === "hot";
            const badge = isHot ? `<span class="badge bg-danger font-monospace fs-9">HOT</span>` : `<span class="badge bg-warning text-dark font-monospace fs-9">DECOY</span>`;
            const isActive = state.currentConfigFile === f.path ? "active" : "";

            html += `
                <a href="javascript:void(0)" class="list-group-item list-group-item-action bg-dark border-secondary ${isActive} py-2.5 px-3 config-file-item" data-path="${f.path}" onclick="selectConfigFile('${f.path}')">
                    <div class="d-flex justify-content-between align-items-center mb-1">
                        <div class="fw-semibold fs-8 text-light text-truncate">${f.name}</div>
                        ${badge}
                    </div>
                    <div class="text-muted fs-9 font-monospace text-truncate">${f.path}</div>
                </a>
            `;
        });

        listElem.innerHTML = html;

        // Auto-select first file if none selected
        if (!state.currentConfigFile && data.files.length > 0) {
            selectConfigFile(data.files[0].path);
        } else if (state.currentConfigFile) {
            selectConfigFile(state.currentConfigFile);
        }
    } catch (e) {
        listElem.innerHTML = `<div class="p-3 text-center text-danger fs-8">Error: ${e.message}</div>`;
    }
}

async function selectConfigFile(filePath) {
    state.currentConfigFile = filePath;

    // Highlight active list item
    document.querySelectorAll(".config-file-item").forEach(el => {
        if (el.getAttribute("data-path") === filePath) {
            el.classList.add("active");
        } else {
            el.classList.remove("active");
        }
    });

    const statusElem = document.getElementById("configJsonStatus");
    const jsonEditor = document.getElementById("configJsonEditor");
    const visualForm = document.getElementById("configVisualForm");
    const titleElem = document.getElementById("configEditorTitle");
    const pathElem = document.getElementById("configEditorPath");
    const descElem = document.getElementById("configEditorDesc");

    if (statusElem) statusElem.textContent = "Loading file...";

    try {
        const res = await fetch(`/api/config/data-file?file=${encodeURIComponent(filePath)}`);
        const data = await res.json();

        if (!data.success) {
            showToast("Gagal memuat file: " + (data.error || "Unknown"), "danger");
            if (statusElem) statusElem.innerHTML = `<span class="text-danger">Gagal memuat</span>`;
            return;
        }

        state.currentConfigData = data.data;

        if (titleElem) titleElem.textContent = data.meta.name;
        if (pathElem) pathElem.textContent = filePath;
        if (descElem) descElem.textContent = data.meta.description || "-";

        const formattedJson = JSON.stringify(data.data, null, 4);
        if (jsonEditor) jsonEditor.value = formattedJson;
        if (statusElem) statusElem.innerHTML = `<span class="text-success"><i class="bi bi-check-circle me-1"></i>Valid JSON</span>`;

        // Check if data is single decoy package object
        const isDecoyObject = (typeof data.data === "object" && !Array.isArray(data.data) && (data.data.family_code !== undefined || data.data.package_variant_code !== undefined));

        if (isDecoyObject) {
            if (visualForm) visualForm.classList.remove("d-none");
            populateVisualForm(data.data);
        } else {
            if (visualForm) visualForm.classList.add("d-none");
        }

    } catch (e) {
        showToast("Error memuat file: " + e.message, "danger");
        if (statusElem) statusElem.innerHTML = `<span class="text-danger">Error: ${e.message}</span>`;
    }
}

function populateVisualForm(obj) {
    state.isSyncingForm = true;
    try {
        const famName = document.getElementById("vFormFamName");
        const optName = document.getElementById("vFormOptName");
        const famCode = document.getElementById("vFormFamCode");
        const varCode = document.getElementById("vFormVarCode");
        const order = document.getElementById("vFormOrder");
        const price = document.getElementById("vFormPrice");
        const migType = document.getElementById("vFormMigType");
        const isEnt = document.getElementById("vFormIsEnterprise");

        if (famName) famName.value = obj.family_name || "";
        if (optName) optName.value = obj.option_name || "";
        if (famCode) famCode.value = obj.family_code || "";
        if (varCode) varCode.value = obj.package_variant_code || "";
        if (order) order.value = obj.order !== undefined ? obj.order : 1;
        if (price) price.value = obj.price !== undefined ? obj.price : 0;
        if (migType) migType.value = obj.migration_type || "NONE";
        if (isEnt) isEnt.checked = !!obj.is_enterprise;
    } finally {
        state.isSyncingForm = false;
    }
}

function syncVisualFormToJson() {
    if (state.isSyncingForm) return;
    if (!state.currentConfigData || typeof state.currentConfigData !== "object" || Array.isArray(state.currentConfigData)) return;

    const famName = document.getElementById("vFormFamName")?.value || "";
    const optName = document.getElementById("vFormOptName")?.value || "";
    const famCode = document.getElementById("vFormFamCode")?.value?.trim() || "";
    const varCode = document.getElementById("vFormVarCode")?.value?.trim() || "";
    const order = parseInt(document.getElementById("vFormOrder")?.value || "1");
    const price = parseInt(document.getElementById("vFormPrice")?.value || "0");
    const migType = document.getElementById("vFormMigType")?.value || "NONE";
    const isEnt = document.getElementById("vFormIsEnterprise")?.checked || false;

    // Update currentConfigData properties
    state.currentConfigData.family_name = famName;
    state.currentConfigData.option_name = optName;
    state.currentConfigData.family_code = famCode;
    state.currentConfigData.package_variant_code = varCode;
    state.currentConfigData.order = isNaN(order) ? 1 : order;
    state.currentConfigData.price = isNaN(price) ? 0 : price;
    state.currentConfigData.migration_type = migType;
    state.currentConfigData.is_enterprise = isEnt;

    // Sync to textarea editor
    const jsonEditor = document.getElementById("configJsonEditor");
    if (jsonEditor) {
        jsonEditor.value = JSON.stringify(state.currentConfigData, null, 4);
    }

    const statusElem = document.getElementById("configJsonStatus");
    if (statusElem) statusElem.innerHTML = `<span class="text-cyan">Synced from form</span>`;
}

function onJsonEditorChange() {
    const jsonEditor = document.getElementById("configJsonEditor");
    const statusElem = document.getElementById("configJsonStatus");
    if (!jsonEditor) return;

    const text = jsonEditor.value.trim();
    if (!text) {
        if (statusElem) statusElem.innerHTML = `<span class="text-warning">Empty</span>`;
        return;
    }

    try {
        const parsed = JSON.parse(text);
        state.currentConfigData = parsed;
        if (statusElem) statusElem.innerHTML = `<span class="text-success"><i class="bi bi-check-circle me-1"></i>Valid JSON</span>`;

        // If decoy object, update visual form
        const isDecoyObject = (typeof parsed === "object" && !Array.isArray(parsed) && (parsed.family_code !== undefined || parsed.package_variant_code !== undefined));
        const visualForm = document.getElementById("configVisualForm");
        if (isDecoyObject) {
            if (visualForm) visualForm.classList.remove("d-none");
            populateVisualForm(parsed);
        } else {
            if (visualForm) visualForm.classList.add("d-none");
        }
    } catch (e) {
        if (statusElem) statusElem.innerHTML = `<span class="text-danger"><i class="bi bi-exclamation-triangle me-1"></i>Invalid JSON</span>`;
    }
}

function beautifyConfigJson() {
    const jsonEditor = document.getElementById("configJsonEditor");
    if (!jsonEditor) return;

    try {
        const parsed = JSON.parse(jsonEditor.value);
        jsonEditor.value = JSON.stringify(parsed, null, 4);
        showToast("JSON berhasil diformat rapi", "info");
    } catch (e) {
        showToast("Format gagal: JSON tidak valid (" + e.message + ")", "warning");
    }
}

function reloadCurrentConfigFile() {
    if (state.currentConfigFile) {
        selectConfigFile(state.currentConfigFile);
        showToast("File dimuat ulang dari disk", "info");
    }
}

async function saveCurrentConfigFile() {
    if (!state.currentConfigFile) {
        showToast("Pilih file terlebih dahulu", "warning");
        return;
    }

    const jsonEditor = document.getElementById("configJsonEditor");
    if (!jsonEditor) return;

    let parsedContent;
    try {
        parsedContent = JSON.parse(jsonEditor.value);
    } catch (e) {
        showToast("Tidak dapat menyimpan: Format JSON tidak valid (" + e.message + ")", "danger");
        return;
    }

    const btn = document.getElementById("btnSaveConfigFile");
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Menyimpan...`;
    }

    try {
        const res = await fetch("/api/config/data-file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                file: state.currentConfigFile,
                content: parsedContent
            })
        });
        const data = await res.json();

        if (data.success) {
            showToast(data.message || "File berhasil disimpan!", "success");
            // If we edited a hot catalog, re-fetch active hot packages
            if (state.currentConfigFile.includes("hot")) {
                loadHotPackages();
            }
        } else {
            showToast("Gagal menyimpan: " + (data.error || "Unknown"), "danger");
        }
    } catch (e) {
        showToast("Error: " + e.message, "danger");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<i class="bi bi-save me-1"></i> Simpan Perubahan`;
        }
    }
}

function inspectConfigFamily() {
    let famCode = "";
    if (state.currentConfigData) {
        if (typeof state.currentConfigData === "object" && !Array.isArray(state.currentConfigData)) {
            famCode = state.currentConfigData.family_code || "";
        } else if (Array.isArray(state.currentConfigData) && state.currentConfigData.length > 0) {
            famCode = state.currentConfigData[0].family_code || "";
        }
    }

    if (!famCode) {
        famCode = document.getElementById("vFormFamCode")?.value?.trim() || "";
    }

    if (!famCode) {
        showToast("Family code tidak ditemukan pada file ini", "warning");
        return;
    }

    switchTab("family");
    const famInput = document.getElementById("familyCodeInput");
    if (famInput) famInput.value = famCode;
    inspectFamilyCode();
}

// ==========================================================================
// DEC0Y MANAGEMENT & ENTITLEMENTS CONTROLLER
// ==========================================================================

async function loadDecoyEntitlements(showToastFeedback = false) {
    try {
        const res = await fetch("/api/decoy/entitlements");
        const data = await res.json();
        
        if (data && data.success) {
            state.decoyData = data;
            state.activeDecoy = data.activeDecoy || "main";
            renderDashboardDecoy(data);
            renderDecoyTab(data);
            if (showToastFeedback) {
                showToast("Data DEC0Y berhasil diperbarui", "info");
            }
        }
    } catch (err) {
        console.error("Error loading decoy entitlements:", err);
    }
}

function renderDashboardDecoy(data) {
    if (!data) return;
    const activeDecoyObj = (data.decoys || []).find(d => d.is_active) || (data.decoys || []).find(d => d.id === data.activeDecoy) || (data.decoys || [])[0];
    
    const activeTitle = activeDecoyObj ? activeDecoyObj.name : "Decoy Utama";
    setTextSafe("dashActiveDecoyTitle", activeTitle);
    setTextSafe("dashActivePackageName", data.package_name || "Paket Premium VIP");
    setTextSafe("dashDecoyAvailableCount", `${data.available_count || 0} dari ${data.total_decoys || 4} Decoy Tersedia`);
    
    const badgeElem = document.getElementById("dashActiveDecoyBadge");
    if (badgeElem) {
        if (data.is_expired) {
            badgeElem.className = "badge-decoy-locked fs-9";
            badgeElem.innerHTML = `<i class="bi bi-clock-history me-1"></i>EXPIRED`;
        } else {
            badgeElem.className = "badge-decoy-active fs-9";
            badgeElem.innerHTML = `<span class="pulse-dot"></span>ACTIVE`;
        }
    }
}

function renderDecoyTab(data) {
    if (!data) return;
    setTextSafe("decoyActivePkgName", data.package_name || "Paket Premium VIP");
    setTextSafe("decoyActivePkgExp", data.package_expired_formatted || "-");
    setTextSafe("decoyEntitledCountText", `${data.available_count || 0} Decoy Termasuk`);
    
    const pkgBadge = document.getElementById("decoyPkgStatusBadge");
    if (pkgBadge) {
        if (data.is_expired) {
            pkgBadge.className = "badge bg-danger-subtle text-danger fs-9";
            pkgBadge.textContent = "EXPIRED";
        } else {
            pkgBadge.className = "badge bg-success-subtle text-success fs-9";
            pkgBadge.textContent = "ACTIVE";
        }
    }

    // Update simulator active button
    const pkgId = (data.package || "premium").toLowerCase();
    ["basic", "standard", "premium", "enterprise"].forEach(p => {
        const btn = document.getElementById("btnPkgSim" + p.charAt(0).toUpperCase() + p.slice(1));
        if (btn) {
            if (p === pkgId) {
                btn.classList.add("active", "btn-info", "text-dark");
                btn.classList.remove("btn-outline-secondary");
            } else {
                btn.classList.remove("active", "btn-info", "text-dark");
                btn.classList.add("btn-outline-secondary");
            }
        }
    });

    const container = document.getElementById("decoyCardsContainer");
    if (!container) return;

    if (!data.decoys || data.decoys.length === 0) {
        container.innerHTML = `<div class="col-12 text-center text-muted p-4">Tidak ada decoy tersedia.</div>`;
        return;
    }

    container.innerHTML = data.decoys.map(d => {
        const isActive = d.is_active;
        const isEnabled = d.enabled;
        const cardClass = isActive ? "decoy-card is-active" : (isEnabled ? "decoy-card is-available" : "decoy-card is-locked");
        
        let statusBadgeHtml = "";
        let actionButtonHtml = "";

        if (isActive) {
            statusBadgeHtml = `<span class="badge-decoy-active"><span class="pulse-dot"></span>ACTIVE</span>`;
            actionButtonHtml = `
                <div class="d-flex align-items-center justify-content-between p-2 rounded bg-success-subtle border border-success-subtle text-success fs-8 fw-semibold">
                    <span class="d-flex align-items-center gap-1.5"><i class="bi bi-check-circle-fill"></i> Sedang Digunakan</span>
                    <i class="bi bi-shield-fill-check fs-6"></i>
                </div>
            `;
        } else if (isEnabled) {
            statusBadgeHtml = `<span class="badge-decoy-available">○ AVAILABLE</span>`;
            actionButtonHtml = `
                <button class="btn btn-sm btn-outline-cyan w-100 fw-semibold d-flex align-items-center justify-content-center gap-1.5 py-2" onclick="selectDecoy('${d.id}', this)">
                    <i class="bi bi-arrow-left-right"></i>
                    <span>Pilih & Gunakan Decoy</span>
                </button>
            `;
        } else {
            statusBadgeHtml = `<span class="badge-decoy-locked"><i class="bi bi-lock-fill me-1"></i>LOCKED</span>`;
            actionButtonHtml = `
                <button class="btn btn-sm btn-outline-secondary w-100 text-muted d-flex align-items-center justify-content-center gap-1.5 py-2" disabled title="Tingkatkan paket untuk membuka decoy ini">
                    <i class="bi bi-lock"></i>
                    <span>Terkunci (Upgrade Paket)</span>
                </button>
            `;
        }

        const iconColor = d.color === "warning" ? "bg-warning-subtle text-warning" :
                          d.color === "cyan" ? "bg-cyan-subtle text-cyan" :
                          d.color === "danger" ? "bg-danger-subtle text-danger" :
                          "bg-primary-subtle text-primary";

        return `
            <div class="col-12 col-md-6 col-xl-3">
                <div class="${cardClass}" id="decoy-card-${d.id}">
                    <div>
                        <div class="d-flex justify-content-between align-items-start gap-2 mb-2.5">
                            <div class="decoy-card-icon ${iconColor}">
                                <i class="bi ${d.icon || 'bi-shield-shaded'}"></i>
                            </div>
                            <div>
                                ${statusBadgeHtml}
                            </div>
                        </div>
                        <div class="d-flex align-items-center gap-2 mb-1">
                            <h6 class="fw-bold text-light mb-0">${d.name}</h6>
                            <span class="badge bg-dark border border-secondary text-muted font-monospace fs-9">${d.badge || d.short_name}</span>
                        </div>
                        <div class="text-cyan fs-9 font-monospace mb-2">${d.type || 'Decoy Gateway'}</div>
                        <p class="text-muted fs-8 mb-3" style="min-height: 40px; line-height: 1.35;">${d.description || ''}</p>
                    </div>
                    <div class="mt-auto pt-2 border-top border-secondary">
                        ${actionButtonHtml}
                    </div>
                </div>
            </div>
        `;
    }).join("");
}

async function selectDecoy(decoyId, btnElem) {
    if (!decoyId) return;
    
    // Check if already active
    if (state.decoyData && state.decoyData.activeDecoy === decoyId) {
        showToast("Decoy ini sudah aktif", "info");
        return;
    }

    // Confirmation / Loading State
    let originalHtml = "";
    if (btnElem) {
        originalHtml = btnElem.innerHTML;
        btnElem.disabled = true;
        btnElem.innerHTML = `<span class="spinner-border spinner-border-sm me-1.5" role="status" aria-hidden="true"></span>Mengaktifkan...`;
    }

    // Disable all other buttons in decoy tab to prevent concurrent requests
    const allBtns = document.querySelectorAll("#decoyCardsContainer button");
    allBtns.forEach(b => b.disabled = true);

    try {
        const res = await fetch("/api/decoy/switch", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                decoy_id: decoyId
            })
        });

        const result = await res.json();

        if (res.ok && result.success) {
            showToast(result.message || `Decoy berhasil diaktifkan!`, "success");
            
            // Persist to CloudStorage if available
            if (window.CloudStorage) {
                window.CloudStorage.saveActiveDecoy(decoyId);
            }

            state.activeDecoy = decoyId;
            if (result.data) {
                state.decoyData = result.data;
                renderDashboardDecoy(result.data);
                renderDecoyTab(result.data);
            } else {
                await loadDecoyEntitlements();
            }
        } else {
            showToast(result.error || "Gagal mengganti decoy", "danger");
            if (btnElem) {
                btnElem.disabled = false;
                btnElem.innerHTML = originalHtml;
            }
            // Re-render to restore all button states
            if (state.decoyData) {
                renderDecoyTab(state.decoyData);
            }
        }
    } catch (err) {
        console.error("Error switching decoy:", err);
        showToast("Error saat menghubungi server: " + err.message, "danger");
        if (btnElem) {
            btnElem.disabled = false;
            btnElem.innerHTML = originalHtml;
        }
        if (state.decoyData) {
            renderDecoyTab(state.decoyData);
        }
    }
}

async function changeDecoyPackage(packageId, isExpired = false) {
    try {
        const res = await fetch("/api/decoy/set-package", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                package_id: packageId,
                is_expired: isExpired
            })
        });
        const result = await res.json();
        if (result.success) {
            showToast(result.message || `Paket diubah ke ${packageId}`, "info");
            if (result.data) {
                state.decoyData = result.data;
                renderDashboardDecoy(result.data);
                renderDecoyTab(result.data);
            } else {
                await loadDecoyEntitlements();
            }
        } else {
            showToast(result.error || "Gagal mengubah paket", "danger");
        }
    } catch (err) {
        showToast("Error: " + err.message, "danger");
    }
}

// ==========================================================================
// SCAN FAMILY CODE MODULE (Bulk Scanner & Validator)
// ==========================================================================

const scanState = {
    activeSubView: "scanner", // 'scanner' | 'files' | 'history'
    inputMode: "upload",      // 'upload' | 'paste' | 'preset'
    selectedFile: null,
    selectedFileName: "",
    selectedPresetCount: 0,
    activeJobId: null,
    isScanning: false,
    pollTimer: null,
    activeFilter: "all",
    currentPage: 1,
    limitPerPage: 30,
    totalPages: 1,
    totalFiltered: 0,
    cachedSummary: null,
    searchQuery: "",
    cachedRawResults: []
};

function initScanTab() {
    updateScanFilesBadge();
    if (!scanState.activeJobId) {
        loadScanHistoryList(true); // silent background load
    }
}

function switchScanSubView(subView) {
    scanState.activeSubView = subView;
    
    // Update subnav buttons
    const btnScanner = document.getElementById("btnScanViewScanner");
    const btnFiles = document.getElementById("btnScanViewFiles");
    const btnHistory = document.getElementById("btnScanViewHistory");
    
    if (btnScanner) btnScanner.className = subView === 'scanner' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline-secondary';
    if (btnFiles) btnFiles.className = subView === 'files' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline-secondary';
    if (btnHistory) btnHistory.className = subView === 'history' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline-secondary';
    
    // Toggle view containers
    const vScanner = document.getElementById("scanViewScanner");
    const vFiles = document.getElementById("scanViewFiles");
    const vHistory = document.getElementById("scanViewHistory");
    
    if (vScanner) vScanner.classList.toggle("d-none", subView !== "scanner");
    if (vFiles) vFiles.classList.toggle("d-none", subView !== "files");
    if (vHistory) vHistory.classList.toggle("d-none", subView !== "history");
    
    if (subView === "files") {
        loadScanFilesList();
    } else if (subView === "history") {
        loadScanHistoryList();
    }
}

function switchScanInputMode(mode, event) {
    if (event) event.preventDefault();
    scanState.inputMode = mode;
    
    // Update tabs active state
    document.querySelectorAll("#scanInputTabs .nav-link").forEach(el => el.classList.remove("active"));
    const activeTabBtn = document.getElementById(
        mode === 'upload' ? 'tabBtnScanUpload' :
        mode === 'paste' ? 'tabBtnScanPaste' : 'tabBtnScanPreset'
    );
    if (activeTabBtn) activeTabBtn.classList.add("active");
    
    // Toggle input panels
    const pUpload = document.getElementById("scanModeUpload");
    const pPaste = document.getElementById("scanModePaste");
    const pPreset = document.getElementById("scanModePreset");
    
    if (pUpload) pUpload.classList.toggle("d-none", mode !== "upload");
    if (pPaste) pPaste.classList.toggle("d-none", mode !== "paste");
    if (pPreset) pPreset.classList.toggle("d-none", mode !== "preset");
}

function handleScanFileSelected(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    scanState.selectedFile = file;
    scanState.selectedFileName = file.name;
    
    const dropTitle = document.getElementById("scanDropzoneTitle");
    const dropSub = document.getElementById("scanDropzoneSub");
    const badge = document.getElementById("scanFileInfoBadge");
    
    if (dropTitle) dropTitle.innerHTML = `<i class="bi bi-file-earmark-check text-success me-1"></i>${file.name}`;
    if (dropSub) dropSub.innerText = `Ukuran: ${(file.size / 1024).toFixed(1)} KB`;
    if (badge) {
        badge.className = "badge bg-success-subtle text-success border border-success font-monospace fs-9";
        badge.innerText = "File siap di-scan";
    }
}

function updateScanPasteCounter() {
    const textarea = document.getElementById("scanPasteInput");
    const counter = document.getElementById("scanPasteLineCount");
    if (!textarea || !counter) return;
    
    const lines = textarea.value.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
    counter.innerText = `${lines.length} family code terdeteksi`;
}

function selectScanPreset(count) {
    scanState.selectedPresetCount = count;
    const info = document.getElementById("scanPresetSelectedInfo");
    if (info) {
        info.classList.remove("d-none");
        info.innerHTML = `<i class="bi bi-check2-circle text-success me-1"></i>Preset <b>${count.toLocaleString()} Family Codes</b> dipilih untuk benchmark / validasi.`;
    }
    showToast(`Preset batch ${count} dipilih`, "info");
}

async function loadListFamcodeFile() {
    try {
        const res = await fetch("/api/scan/files");
        const data = await res.json();
        if (data.success && data.files && data.files.length > 0) {
            const listFile = data.files.find(f => f.filename === "list_famcode.txt");
            if (listFile) {
                const fileRes = await fetch(listFile.download_url);
                const text = await fileRes.text();
                switchScanInputMode("paste");
                const textarea = document.getElementById("scanPasteInput");
                if (textarea) {
                    textarea.value = text;
                    updateScanPasteCounter();
                }
                showToast(`Berhasil memuat list_famcode.txt (${listFile.size_formatted})`, "success");
                return;
            }
        }
        selectScanPreset(200);
        showToast("Memuat preset sample 200 family codes", "info");
    } catch (err) {
        selectScanPreset(200);
    }
}

function resetScanForm() {
    scanState.selectedFile = null;
    scanState.selectedFileName = "";
    scanState.selectedPresetCount = 0;
    
    const fileInput = document.getElementById("scanFileInput");
    if (fileInput) fileInput.value = "";
    
    const dropTitle = document.getElementById("scanDropzoneTitle");
    const dropSub = document.getElementById("scanDropzoneSub");
    const badge = document.getElementById("scanFileInfoBadge");
    
    if (dropTitle) dropTitle.innerText = "Klik atau Tarik File ke Sini";
    if (dropSub) dropSub.innerText = "Mendukung format .TXT (1 code per baris) atau .JSON";
    if (badge) {
        badge.className = "badge bg-darker border border-secondary text-secondary font-monospace fs-9";
        badge.innerText = "Belum ada file dipilih";
    }
    
    const textarea = document.getElementById("scanPasteInput");
    if (textarea) textarea.value = "";
    updateScanPasteCounter();
    
    const presetInfo = document.getElementById("scanPresetSelectedInfo");
    if (presetInfo) presetInfo.classList.add("d-none");
    
    showToast("Form input scan di-reset", "secondary");
}

async function startFamilyScan() {
    const concurrency = parseInt(document.getElementById("scanConcurrencyRange")?.value || "20");
    const timeout_ms = parseInt(document.getElementById("scanTimeoutInput")?.value || "5000");
    const migration_type = document.getElementById("scanMigTypeSelect")?.value || "NONE";
    const is_enterprise = document.getElementById("scanIsEnterpriseSwitch")?.checked || false;
    
    let body = null;
    let headers = {};
    let isFormData = false;
    
    if (scanState.inputMode === "upload") {
        if (!scanState.selectedFile) {
            showToast("Silakan pilih file .TXT atau .JSON terlebih dahulu", "warning");
            return;
        }
        const formData = new FormData();
        formData.append("file", scanState.selectedFile);
        formData.append("concurrency", concurrency);
        formData.append("timeout_ms", timeout_ms);
        formData.append("migration_type", migration_type);
        formData.append("is_enterprise", is_enterprise ? "true" : "false");
        body = formData;
        isFormData = true;
    } else if (scanState.inputMode === "paste") {
        const rawText = document.getElementById("scanPasteInput")?.value.trim();
        if (!rawText) {
            showToast("Silakan tempel daftar Family Code di textarea", "warning");
            return;
        }
        headers["Content-Type"] = "application/json";
        body = JSON.stringify({
            raw_text: rawText,
            concurrency,
            timeout_ms,
            migration_type,
            is_enterprise
        });
    } else if (scanState.inputMode === "preset") {
        const count = scanState.selectedPresetCount || 200;
        headers["Content-Type"] = "application/json";
        body = JSON.stringify({
            count,
            concurrency,
            timeout_ms,
            migration_type,
            is_enterprise
        });
    }
    
    const btnStart = document.getElementById("btnStartScan");
    const btnStop = document.getElementById("btnStopScan");
    if (btnStart) btnStart.disabled = true;
    
    try {
        const fetchOptions = {
            method: "POST",
            body
        };
        if (!isFormData) {
            fetchOptions.headers = headers;
        }
        
        const res = await fetch("/api/scan/start", fetchOptions);
        const data = await res.json();
        
        if (!res.ok || !data.success) {
            showToast(data.error || "Gagal memulai scan", "danger");
            if (btnStart) btnStart.disabled = false;
            return;
        }
        
        const jobId = data.job_id;
        scanState.activeJobId = jobId;
        scanState.isScanning = true;
        scanState.activeFilter = "all";
        scanState.currentPage = 1;
        
        // Reset results section while scanning
        const resultsSec = document.getElementById("scanResultsSection");
        if (resultsSec) resultsSec.classList.add("d-none");
        
        // Show progress box & Stop button
        const progBox = document.getElementById("scanProgressContainer");
        if (progBox) progBox.classList.remove("d-none");
        
        if (btnStart) btnStart.classList.add("d-none");
        if (btnStop) {
            btnStop.classList.remove("d-none");
            btnStop.disabled = false;
            btnStop.innerHTML = `<i class="bi bi-stop-circle-fill me-1"></i>Stop Scan`;
        }
        
        showToast(`Scan dimulai untuk ${data.summary.total} Family Codes`, "info");
        
        // Start live polling loop
        if (scanState.pollTimer) clearInterval(scanState.pollTimer);
        renderScanProgressUI(data.summary);
        scanState.pollTimer = setInterval(() => pollScanProgress(jobId), 600);
        
    } catch (err) {
        showToast("Error menghubungi server: " + err.message, "danger");
        if (btnStart) btnStart.disabled = false;
    }
}

async function pollScanProgress(jobId) {
    if (!jobId) return;
    try {
        const res = await fetch(`/api/scan/status/${jobId}`);
        const data = await res.json();
        
        if (!res.ok || !data.success) return;
        
        const summary = data.summary;
        scanState.cachedSummary = summary;
        renderScanProgressUI(summary);
        
        if (summary.status === "completed" || summary.status === "cancelled" || summary.status === "error") {
            clearInterval(scanState.pollTimer);
            scanState.pollTimer = null;
            scanState.isScanning = false;
            
            const btnStart = document.getElementById("btnStartScan");
            const btnStop = document.getElementById("btnStopScan");
            if (btnStart) {
                btnStart.classList.remove("d-none");
                btnStart.disabled = false;
            }
            if (btnStop) btnStop.classList.add("d-none");
            
            const pBar = document.getElementById("scanProgressBar");
            if (pBar) pBar.classList.remove("animated-stripes");
            
            if (summary.status === "completed") {
                showToast(`Scan selesai! Ditemukan ${summary.valid_count} Family Code Valid.`, "success");
            } else if (summary.status === "cancelled") {
                showToast(`Scan dihentikan. (${summary.scanned}/${summary.total} kode diperiksa)`, "warning");
            }
            
        loadScanResults(jobId, scanState.activeFilter, 1);
        updateScanFilesBadge();
        const resultsSec = document.getElementById("scanResultsSection");
        if (resultsSec) {
            resultsSec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        }
    } catch (err) {
        console.warn("Polling error:", err);
    }
}

function renderScanProgressUI(summary) {
    if (!summary) return;
    
    // Status Badge
    const statusBadge = document.getElementById("scanJobStatusBadge");
    if (statusBadge) {
        statusBadge.innerText = summary.status.toUpperCase();
        statusBadge.className = "badge font-monospace fs-9 " + (
            summary.status === "running" ? "bg-primary" :
            summary.status === "completed" ? "bg-success" :
            summary.status === "cancelled" ? "bg-warning text-dark" : "bg-secondary"
        );
    }
    
    // Job ID
    const jobIdDisplay = document.getElementById("scanJobIdDisplay");
    if (jobIdDisplay) jobIdDisplay.innerText = summary.job_id;
    
    // Elapsed & Speed
    const elapsedDisplay = document.getElementById("scanElapsedDisplay");
    if (elapsedDisplay) {
        const secs = Math.floor(summary.elapsed_seconds || 0);
        const m = Math.floor(secs / 60).toString().padStart(2, '0');
        const s = (secs % 60).toString().padStart(2, '0');
        elapsedDisplay.innerText = `${m}:${s}`;
    }
    
    const speedDisplay = document.getElementById("scanSpeedDisplay");
    if (speedDisplay) speedDisplay.innerText = summary.speed_per_sec || 0;
    
    // Progress Bar & Counts
    const progressText = document.getElementById("scanProgressText");
    if (progressText) progressText.innerText = `${summary.scanned} / ${summary.total}`;
    
    const progressPercent = document.getElementById("scanProgressPercent");
    if (progressPercent) progressPercent.innerText = `${summary.progress_percent}%`;
    
    const progressBar = document.getElementById("scanProgressBar");
    if (progressBar) progressBar.style.width = `${summary.progress_percent}%`;
    
    // 5 Counters
    const validCount = document.getElementById("statValidCount");
    if (validCount) validCount.innerText = summary.valid_count;
    
    const invalidCount = document.getElementById("statInvalidCount");
    if (invalidCount) invalidCount.innerText = summary.invalid_count;
    
    const duplicateCount = document.getElementById("statDuplicateCount");
    if (duplicateCount) duplicateCount.innerText = summary.duplicate_count;
    
    const skipCount = document.getElementById("statSkipCount");
    if (skipCount) skipCount.innerText = summary.skip_count;
    
    const errorCount = document.getElementById("statErrorCount");
    if (errorCount) errorCount.innerText = summary.error_count;
    
    // Filter chip counter texts
    const fcAll = document.getElementById("filterCountAll");
    if (fcAll) fcAll.innerText = summary.total;
    const fcValid = document.getElementById("filterCountValid");
    if (fcValid) fcValid.innerText = summary.valid_count;
    const fcInvalid = document.getElementById("filterCountInvalid");
    if (fcInvalid) fcInvalid.innerText = summary.invalid_count;
    const fcDuplicate = document.getElementById("filterCountDuplicate");
    if (fcDuplicate) fcDuplicate.innerText = summary.duplicate_count;
    const fcSkip = document.getElementById("filterCountSkip");
    if (fcSkip) fcSkip.innerText = summary.skip_count;
    const fcError = document.getElementById("filterCountError");
    if (fcError) fcError.innerText = summary.error_count;
}

async function stopActiveScan() {
    if (!scanState.activeJobId) return;
    const btnStop = document.getElementById("btnStopScan");
    if (btnStop) {
        btnStop.disabled = true;
        btnStop.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>Menghentikan...`;
    }
    try {
        const res = await fetch(`/api/scan/stop/${scanState.activeJobId}`, { method: "POST" });
        const data = await res.json();
        if (data.success) {
            showToast("Permintaan stop scan terkirim", "warning");
        }
    } catch (err) {
        showToast("Error stop scan: " + err.message, "danger");
    }
}

function setScanResultsFilter(filter) {
    scanState.activeFilter = filter;
    scanState.currentPage = 1;
    
    // Update active filter chip UI
    document.querySelectorAll("#scanFilterChips .scan-filter-chip").forEach(chip => {
        if (chip.getAttribute("data-filter") === filter) {
            chip.classList.add("active");
        } else {
            chip.classList.remove("active");
        }
    });
    
    if (scanState.activeJobId) {
        loadScanResults(scanState.activeJobId, filter, 1);
    }
}

function onScanSearchInput(query) {
    scanState.searchQuery = (query || "").toLowerCase().trim();
    renderFilteredResultsList();
}

function changeScanPage(delta) {
    const newPage = scanState.currentPage + delta;
    if (newPage >= 1 && newPage <= scanState.totalPages) {
        scanState.currentPage = newPage;
        if (scanState.activeJobId) {
            loadScanResults(scanState.activeJobId, scanState.activeFilter, newPage);
        }
    }
}

async function loadScanResults(jobId, filter = "all", page = 1) {
    if (!jobId) return;
    const resultsSec = document.getElementById("scanResultsSection");
    const container = document.getElementById("scanResultsList");
    
    if (resultsSec) resultsSec.classList.remove("d-none");
    if (container) container.innerHTML = `<div class="col-12 text-center p-4 text-muted"><div class="spinner-border spinner-border-sm me-2"></div>Memuat hasil scan...</div>`;
    
    try {
        const res = await fetch(`/api/scan/results/${jobId}?filter=${filter}&page=${page}&limit=${scanState.limitPerPage}`);
        const data = await res.json();
        
        if (!res.ok || !data.success) {
            if (container) container.innerHTML = `<div class="col-12 text-center p-4 text-danger">${data.error || "Gagal memuat hasil"}</div>`;
            return;
        }
        
        scanState.cachedRawResults = data.items || [];
        scanState.totalPages = data.total_pages || 1;
        scanState.totalFiltered = data.total_filtered || 0;
        scanState.currentPage = data.page || 1;
        
        renderFilteredResultsList();
        
        // Update pagination controls
        const pagInfo = document.getElementById("scanPaginationInfo");
        if (pagInfo) {
            pagInfo.innerText = `Menampilkan ${data.items.length} dari ${data.total_filtered} hasil (Filter: ${filter.toUpperCase()})`;
        }
        
        const curPageText = document.getElementById("scanCurrentPageText");
        if (curPageText) curPageText.innerText = `Hal ${scanState.currentPage} / ${scanState.totalPages}`;
        
        const btnPrev = document.getElementById("btnScanPrevPage");
        const btnNext = document.getElementById("btnScanNextPage");
        if (btnPrev) btnPrev.disabled = scanState.currentPage <= 1;
        if (btnNext) btnNext.disabled = scanState.currentPage >= scanState.totalPages;
        
    } catch (err) {
        if (container) container.innerHTML = `<div class="col-12 text-center p-4 text-danger">Error: ${err.message}</div>`;
    }
}

function renderFilteredResultsList() {
    const container = document.getElementById("scanResultsList");
    if (!container) return;
    
    let items = scanState.cachedRawResults || [];
    
    if (scanState.searchQuery) {
        items = items.filter(it => 
            (it.family_code && it.family_code.toLowerCase().includes(scanState.searchQuery)) ||
            (it.package_family_name && it.package_family_name.toLowerCase().includes(scanState.searchQuery)) ||
            (it.reason && it.reason.toLowerCase().includes(scanState.searchQuery))
        );
    }
    
    if (items.length === 0) {
        container.innerHTML = `
            <div class="col-12 text-center p-4 text-muted">
                <i class="bi bi-inbox fs-3 d-block mb-1"></i>
                Tidak ada data Family Code yang cocok dengan filter.
            </div>
        `;
        return;
    }
    
    let html = "";
    for (const item of items) {
        html += renderScanResultCard(item);
    }
    container.innerHTML = html;
}

function renderScanResultCard(item) {
    const st = (item.status || "unknown").toLowerCase();
    const isVal = st === "valid";
    const isInv = st === "invalid";
    const isDup = st === "duplicate";
    const isSkip = st === "skip";
    const isErr = st === "error";
    
    const cardClass = isVal ? "card-valid" : isInv ? "card-invalid" : isDup ? "card-duplicate" : isSkip ? "card-skip" : "card-error";
    const badgeClass = isVal ? "scan-badge-valid" : isInv ? "scan-badge-invalid" : isDup ? "scan-badge-duplicate" : isSkip ? "scan-badge-skip" : "scan-badge-error";
    
    const famCode = item.family_code || "-";
    const famName = item.package_family_name || "-";
    const variantsCount = item.variants_count || 0;
    const optionsCount = item.options_count || 0;
    const reason = item.reason || "";
    const indexNum = item.index || 1;
    
    return `
        <div class="col-12 col-md-6 col-lg-4">
            <div class="scan-result-card ${cardClass} h-100 d-flex flex-column justify-content-between">
                <div>
                    <!-- Card Top Header -->
                    <div class="d-flex align-items-center justify-content-between mb-2">
                        <span class="fs-9 font-monospace text-muted">#${indexNum}</span>
                        <span class="badge ${badgeClass} font-monospace fs-9 px-2 py-0.5">${(item.status_label || st).toUpperCase()}</span>
                    </div>

                    <!-- Family Code Display with Copy Button -->
                    <div class="d-flex align-items-center justify-content-between p-1.5 bg-darker rounded border border-secondary mb-2">
                        <span class="font-monospace text-light fs-9 text-truncate me-2" title="${famCode}">${famCode}</span>
                        <button class="btn btn-xs btn-link text-cyan p-0 text-decoration-none flex-shrink-0" onclick="copyScanCode('${famCode}')" title="Salin Family Code">
                            <i class="bi bi-clipboard"></i>
                        </button>
                    </div>

                    <!-- Package / Status Details -->
                    ${isVal ? `
                        <div class="mb-2">
                            <h6 class="fw-bold text-light mb-1 text-truncate" title="${famName}">${famName}</h6>
                            <div class="d-flex flex-wrap gap-1.5 align-items-center fs-9 text-muted font-monospace">
                                <span class="badge bg-dark border border-secondary text-info">${variantsCount} Varian</span>
                                <span class="badge bg-dark border border-secondary text-success">${optionsCount} Opsi Paket</span>
                            </div>
                        </div>
                    ` : `
                        <div class="mb-2">
                            <div class="fs-9 text-danger font-monospace text-truncate-2" title="${reason}">
                                <i class="bi bi-info-circle me-1"></i>${reason || 'Tidak ditemukan / Nonaktif'}
                            </div>
                        </div>
                    `}
                </div>

                <!-- Card Actions -->
                <div class="d-flex align-items-center justify-content-between pt-2 border-top border-secondary mt-2">
                    ${isVal ? `
                        <button class="btn btn-xs btn-outline-info" onclick="inspectFamilyFromScan('${famCode}')" title="Buka di Tab Family Code">
                            <i class="bi bi-search me-1"></i>Inspect
                        </button>
                        <button class="btn btn-xs btn-outline-warning" onclick="createPresetFromScan('${famCode}', '${famName}')" title="Simpan sebagai Preset 1-Klik">
                            <i class="bi bi-lightning-charge-fill me-1"></i>Preset
                        </button>
                    ` : `
                        <span class="fs-9 text-muted font-monospace">${isDup ? 'Skip duplicate' : isSkip ? 'Skip malformed' : 'Gagal'}</span>
                        <button class="btn btn-xs btn-outline-secondary" onclick="copyScanCode('${famCode}')">
                            <i class="bi bi-clipboard me-1"></i>Salin
                        </button>
                    `}
                </div>
            </div>
        </div>
    `;
}

function copyScanCode(code) {
    if (!code || code === "-") return;
    navigator.clipboard.writeText(code).then(() => {
        showToast(`Family Code disalin: ${code.substring(0, 12)}...`, "info");
    }).catch(() => {
        showToast(`Family Code: ${code}`, "info");
    });
}

function inspectFamilyFromScan(famCode) {
    if (!famCode) return;
    const input = document.getElementById("familyCodeInput");
    if (input) input.value = famCode;
    switchTab("family");
    if (typeof inspectFamilyCode === "function") {
        inspectFamilyCode();
    }
}

function createPresetFromScan(famCode, name) {
    if (!famCode) return;
    if (typeof openAddPresetModal === "function") {
        openAddPresetModal();
        const codeInput = document.getElementById("presetFamCodeInput");
        const labelInput = document.getElementById("presetLabelInput");
        if (codeInput) codeInput.value = famCode;
        if (labelInput && name && name !== "-") labelInput.value = name;
    }
}

function downloadCurrentScanFile(filename) {
    if (!scanState.activeJobId) {
        showToast("Belum ada job scan aktif", "warning");
        return;
    }
    const url = `/api/scan/download/${scanState.activeJobId}/${filename}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast(`Mengunduh ${filename}...`, "info");
}

async function updateScanFilesBadge() {
    try {
        const res = await fetch("/api/scan/files");
        const data = await res.json();
        if (data.success && data.files) {
            const badge = document.getElementById("scanFilesBadgeCount");
            if (badge) badge.innerText = data.files.length;
        }
    } catch (e) {}
}

async function loadScanFilesList() {
    const tbody = document.getElementById("scanFilesTableBody");
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5" class="text-center p-4 text-muted"><div class="spinner-border spinner-border-sm me-2"></div>Memuat daftar file...</td></tr>`;
    
    try {
        const res = await fetch("/api/scan/files");
        const data = await res.json();
        
        if (!res.ok || !data.success) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center p-4 text-danger">${data.error || "Gagal memuat file"}</td></tr>`;
            return;
        }
        
        const files = data.files || [];
        const badge = document.getElementById("scanFilesBadgeCount");
        if (badge) badge.innerText = files.length;
        
        if (files.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center p-4 text-muted">Belum ada file scanner yang dihasilkan. Jalankan scan terlebih dahulu.</td></tr>`;
            return;
        }
        
        let html = "";
        for (const file of files) {
            const isJson = file.filename.endsWith(".json");
            const isVal = file.filename.includes("valid");
            const icon = isJson ? "bi-file-code text-info" : isVal ? "bi-file-earmark-check text-success" : "bi-file-earmark-text text-secondary";
            
            html += `
                <tr>
                    <td class="ps-3">
                        <div class="d-flex align-items-center gap-2">
                            <i class="bi ${icon} fs-5"></i>
                            <span class="font-monospace text-light fw-semibold fs-8">${file.filename}</span>
                        </div>
                    </td>
                    <td>
                        <span class="badge bg-dark border border-secondary font-monospace fs-9 text-muted">${file.job_id}</span>
                    </td>
                    <td>
                        <span class="font-monospace text-muted fs-8">${file.size_formatted}</span>
                    </td>
                    <td>
                        <span class="text-muted fs-8">${file.created_formatted}</span>
                    </td>
                    <td class="pe-3 text-end">
                        <a href="${file.download_url}" download class="btn btn-xs btn-outline-info">
                            <i class="bi bi-download me-1"></i>Unduh
                        </a>
                    </td>
                </tr>
            `;
        }
        tbody.innerHTML = html;
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center p-4 text-danger">Error: ${err.message}</td></tr>`;
    }
}

async function loadScanHistoryList(silent = false) {
    const container = document.getElementById("scanHistoryListContainer");
    if (!silent && container) {
        container.innerHTML = `<div class="text-center p-4 text-muted"><div class="spinner-border spinner-border-sm me-2"></div>Memuat riwayat...</div>`;
    }
    
    try {
        const res = await fetch("/api/scan/history");
        const data = await res.json();
        
        if (!res.ok || !data.success) {
            if (!silent && container) container.innerHTML = `<div class="text-center p-4 text-danger">${data.error || "Gagal memuat riwayat"}</div>`;
            return;
        }
        
        const history = data.history || [];
        if (!container) return;
        
        if (history.length === 0) {
            container.innerHTML = `<div class="text-center p-4 text-muted">Belum ada riwayat pemindaian Family Code.</div>`;
            return;
        }
        
        let html = "";
        for (const item of history) {
            const st = (item.status || "completed").toLowerCase();
            const badgeClass = st === "completed" ? "bg-success" : st === "cancelled" ? "bg-warning text-dark" : "bg-danger";
            const dateStr = item.created_at ? new Date(item.created_at * 1000).toLocaleString('id-ID') : "-";
            
            html += `
                <div class="list-group-item bg-transparent border-secondary p-3">
                    <div class="d-flex justify-content-between align-items-start gap-2 mb-2 flex-wrap">
                        <div>
                            <div class="d-flex align-items-center gap-2 mb-1">
                                <span class="badge ${badgeClass} font-monospace fs-9">${st.toUpperCase()}</span>
                                <span class="fw-bold text-light fs-8 font-monospace">${item.job_id}</span>
                            </div>
                            <div class="text-muted fs-9">
                                <i class="bi bi-clock me-1"></i>${dateStr} • Durasi: ${item.elapsed_seconds || 0}s (${item.speed_per_sec || 0} code/s)
                            </div>
                        </div>
                        <div class="d-flex gap-1.5">
                            <button class="btn btn-xs btn-outline-info" onclick="viewHistoryScan('${item.job_id}')" title="Buka Hasil">
                                <i class="bi bi-eye me-1"></i>Lihat Hasil
                            </button>
                            <button class="btn btn-xs btn-outline-danger" onclick="deleteScanHistory('${item.job_id}', event)" title="Hapus Riwayat">
                                <i class="bi bi-trash"></i>
                            </button>
                        </div>
                    </div>
                    <div class="d-flex flex-wrap gap-2 fs-9 font-monospace">
                        <span class="badge bg-darker border border-secondary text-light">Total: <b>${item.total}</b></span>
                        <span class="badge bg-darker border border-success-subtle text-success">Valid: <b>${item.valid_count}</b></span>
                        <span class="badge bg-darker border border-danger-subtle text-danger">Invalid: <b>${item.invalid_count}</b></span>
                        <span class="badge bg-darker border border-warning-subtle text-warning">Duplicate: <b>${item.duplicate_count}</b></span>
                    </div>
                </div>
            `;
        }
        container.innerHTML = html;
    } catch (err) {
        if (!silent && container) container.innerHTML = `<div class="text-center p-4 text-danger">Error: ${err.message}</div>`;
    }
}

async function viewHistoryScan(jobId) {
    if (!jobId) return;
    scanState.activeJobId = jobId;
    switchScanSubView("scanner");
    
    const progBox = document.getElementById("scanProgressContainer");
    if (progBox) progBox.classList.remove("d-none");
    
    // Fetch summary
    try {
        const res = await fetch(`/api/scan/status/${jobId}`);
        const data = await res.json();
        if (data.success && data.summary) {
            renderScanProgressUI(data.summary);
        }
    } catch (e) {}
    
    loadScanResults(jobId, "all", 1);
    showToast(`Memuat hasil scan ${jobId}`, "info");
}

async function deleteScanHistory(jobId, event) {
    if (event) event.stopPropagation();
    if (!confirm(`Hapus riwayat scan ${jobId}?`)) return;
    
    try {
        const res = await fetch(`/api/scan/history/${jobId}`, { method: "DELETE" });
        const data = await res.json();
        if (data.success) {
            showToast("Riwayat berhasil dihapus", "info");
            loadScanHistoryList();
        } else {
            showToast(data.error || "Gagal menghapus riwayat", "danger");
        }
    } catch (err) {
        showToast("Error: " + err.message, "danger");
    }
}
// ----------------- GENERATE FAMCODE MODULE (TESTING & SIMULATION GENERATOR) -----------------

const genState = {
    count: 100,
    format: "standard", // standard | uppercase | nohyphen
    items: [],
    isGenerating: false
};

function initGenerateTab() {
    updateGenFormatPreview();
}

function updateGenFormatPreview() {
    const format = document.getElementById("genFormatSelect")?.value || "standard";
    const previewEl = document.getElementById("genFormatPreview");
    if (previewEl) {
        previewEl.textContent = generateSingleSecureUUID(format);
    }
}

function setGenPresetCount(count) {
    const c = parseInt(count, 10);
    if (isNaN(c) || c < 1) return;
    
    genState.count = c;
    
    const input = document.getElementById("genCountInput");
    if (input) input.value = c;
    
    const display = document.getElementById("genCountDisplay");
    if (display) display.textContent = c.toLocaleString("id-ID");
    
    // Update preset buttons active state
    document.querySelectorAll("#genPresetButtonsGroup .gen-preset-btn").forEach(btn => {
        const btnCount = parseInt(btn.textContent.replace(/\./g, ""), 10);
        if (btnCount === c) {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    });
}

function onGenCountInputChange(val) {
    let c = parseInt(val, 10);
    if (isNaN(c)) c = 0;
    
    const display = document.getElementById("genCountDisplay");
    if (display) display.textContent = c > 0 ? c.toLocaleString("id-ID") : "0";
    
    genState.count = c;
    
    // Update active preset buttons
    document.querySelectorAll("#genPresetButtonsGroup .gen-preset-btn").forEach(btn => {
        const btnCount = parseInt(btn.textContent.replace(/\./g, ""), 10);
        if (btnCount === c) {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    });
}

function onGenFormatChange() {
    const sel = document.getElementById("genFormatSelect");
    if (sel) {
        genState.format = sel.value;
    }
    updateGenFormatPreview();
}

/**
 * Generate a single cryptographically secure UUID v4 conforming to RFC 4122
 */
function generateSingleSecureUUID(format = "standard") {
    let uuidStr = "";
    
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        uuidStr = crypto.randomUUID();
    } else if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        // RFC 4122 version 4
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        // RFC 4122 variant
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        
        const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
        uuidStr = `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`;
    } else {
        // Fallback PRNG (RFC 4122 compliance)
        let d = new Date().getTime();
        let d2 = (typeof performance !== "undefined" && performance.now && (performance.now() * 1000)) || 0;
        uuidStr = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
            let r = Math.random() * 16;
            if (d > 0) {
                r = (d + r) % 16 | 0;
                d = Math.floor(d / 16);
            } else {
                r = (d2 + r) % 16 | 0;
                d2 = Math.floor(d2 / 16);
            }
            return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    if (format === "uppercase") {
        return uuidStr.toUpperCase();
    } else if (format === "nohyphen") {
        return uuidStr.replace(/-/g, "").toLowerCase();
    }
    return uuidStr.toLowerCase();
}

/**
 * Execute batch UUID generation asynchronously with responsive UI updates
 */
function executeGenerateFamcode() {
    if (genState.isGenerating) return;
    
    const countInput = document.getElementById("genCountInput");
    let count = parseInt(countInput?.value || "100", 10);
    if (isNaN(count) || count < 1) count = 1;
    if (count > 10000) count = 10000;
    if (countInput) countInput.value = count;
    
    const format = document.getElementById("genFormatSelect")?.value || "standard";
    genState.format = format;
    genState.count = count;
    
    const genBtn = document.getElementById("btnGenerateFamcode");
    const originalBtnHtml = genBtn ? genBtn.innerHTML : "";
    
    if (genBtn) {
        genState.isGenerating = true;
        genBtn.disabled = true;
        genBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-1.5" role="status" aria-hidden="true"></span>Membuat ${count.toLocaleString('id-ID')} UUID...`;
    }
    
    setTimeout(() => {
        try {
            const t0 = performance.now();
            const set = new Set();
            let iterations = 0;
            const maxIterations = count * 3;
            
            while (set.size < count && iterations < maxIterations) {
                set.add(generateSingleSecureUUID(format));
                iterations++;
            }
            
            const items = Array.from(set);
            const t1 = performance.now();
            const durationMs = Math.max(1, Math.round(t1 - t0));
            
            genState.items = items;
            
            const outEl = document.getElementById("genOutputText");
            if (outEl) {
                outEl.value = items.join("\n");
            }
            
            const countBadge = document.getElementById("genResultCountBadge");
            if (countBadge) {
                countBadge.textContent = `${items.length.toLocaleString("id-ID")} UUID`;
            }
            
            const durBadge = document.getElementById("genDurationBadge");
            if (durBadge) {
                durBadge.textContent = `${durationMs} ms`;
            }
            
            showToast(`Berhasil men-generate ${items.length.toLocaleString("id-ID")} UUID v4 acak (${durationMs} ms)`, "success");
        } catch (err) {
            showToast(`Error generator: ${err.message}`, "danger");
        } finally {
            genState.isGenerating = false;
            if (genBtn) {
                genBtn.disabled = false;
                genBtn.innerHTML = originalBtnHtml;
            }
        }
    }, 20);
}

function clearGeneratedFamcodes() {
    genState.items = [];
    
    const outEl = document.getElementById("genOutputText");
    if (outEl) outEl.value = "";
    
    const countBadge = document.getElementById("genResultCountBadge");
    if (countBadge) countBadge.textContent = "0 UUID";
    
    const durBadge = document.getElementById("genDurationBadge");
    if (durBadge) durBadge.textContent = "0 ms";
    
    showToast("Hasil generator dikosongkan", "info");
}

function copyAllGeneratedFamcodes() {
    const text = (document.getElementById("genOutputText")?.value || "").trim();
    if (!text || genState.items.length === 0) {
        showToast("Tidak ada UUID untuk disalin", "warning");
        return;
    }
    
    const copyBtn = document.getElementById("btnCopyAllGen");
    const origHtml = copyBtn ? copyBtn.innerHTML : "";
    
    const handleSuccess = () => {
        showToast(`${genState.items.length.toLocaleString("id-ID")} UUID berhasil disalin ke clipboard`, "success");
        if (copyBtn) {
            copyBtn.innerHTML = `<i class="bi bi-check2 me-1"></i>Tersalin!`;
            copyBtn.classList.replace("btn-outline-light", "btn-success");
            setTimeout(() => {
                copyBtn.innerHTML = origHtml;
                copyBtn.classList.replace("btn-success", "btn-outline-light");
            }, 2000);
        }
    };
    
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text)
            .then(handleSuccess)
            .catch(() => fallbackCopy(text, handleSuccess));
    } else {
        fallbackCopy(text, handleSuccess);
    }
}

function fallbackCopy(text, callback) {
    try {
        const temp = document.createElement("textarea");
        temp.value = text;
        temp.style.position = "fixed";
        temp.style.opacity = "0";
        document.body.appendChild(temp);
        temp.focus();
        temp.select();
        const successful = document.execCommand("copy");
        document.body.removeChild(temp);
        if (successful && typeof callback === "function") {
            callback();
        } else {
            showToast("Gagal menyalin ke clipboard", "danger");
        }
    } catch (err) {
        showToast("Gagal menyalin: " + err.message, "danger");
    }
}

function downloadGeneratedTxt() {
    if (!genState.items || genState.items.length === 0) {
        showToast("Generate UUID terlebih dahulu sebelum mengunduh", "warning");
        return;
    }
    
    const content = genState.items.join("\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `generated_famcodes_${genState.items.length}_${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showToast(`File TXT (${genState.items.length} UUID) berhasil diunduh`, "success");
}

function downloadGeneratedJson() {
    if (!genState.items || genState.items.length === 0) {
        showToast("Generate UUID terlebih dahulu sebelum mengunduh", "warning");
        return;
    }
    
    const exportData = {
        success: true,
        generated_at: new Date().toISOString(),
        count: genState.items.length,
        format: genState.format,
        items: genState.items
    };
    
    const content = JSON.stringify(exportData, null, 2);
    const blob = new Blob([content], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `generated_famcodes_${genState.items.length}_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showToast(`File JSON (${genState.items.length} UUID) berhasil diunduh`, "success");
}

function sendGeneratedToScanTab() {
    if (!genState.items || genState.items.length === 0) {
        showToast("Generate UUID terlebih dahulu sebelum mengirim ke Scanner", "warning");
        return;
    }
    
    const text = genState.items.join("\n");
    
    // Switch to scan tab
    switchTab("scan");
    
    // Switch to paste mode
    if (typeof switchScanInputMode === "function") {
        switchScanInputMode("paste");
    }
    
    const pasteArea = document.getElementById("scanPasteInput");
    if (pasteArea) {
        pasteArea.value = text;
    }
    
    if (typeof updateScanPasteCounter === "function") {
        updateScanPasteCounter();
    }
    
    showToast(`${genState.items.length.toLocaleString("id-ID")} UUID berhasil dipindahkan ke Tab Scan`, "info");
}

