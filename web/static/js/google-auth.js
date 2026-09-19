/**
 * GoogleAuth — Official Google OAuth & Multi-Account Manager for DUAR
 * Handles Google Identity Services (GIS), Account Picker UI, Profile Loading, and Multi-Account switching
 */

class GoogleAuthManager {
    constructor() {
        this.clientId = "";
        this.tokenClient = null;
        this.activeUser = null;
        this.accessToken = null;
        this.tokenExpiry = 0;
        this.storageKey = "duar_google_accounts_list";
        this.sessionKey = "duar_active_google_user_id";
        this.tokenKeyPrefix = "duar_google_token_";
        this.scopes = "openid email profile https://www.googleapis.com/auth/drive.appdata";
        this.onAuthSuccessCallbacks = [];
        this.onLogoutCallbacks = [];
        this.initialized = false;
    }

    /**
     * Subscribe to successful login / account switch
     */
    onAuthSuccess(cb) {
        if (typeof cb === "function") this.onAuthSuccessCallbacks.push(cb);
    }

    /**
     * Get the active Google user ID
     */
    getActiveUserId() {
        if (this.activeUser && this.activeUser.id) return String(this.activeUser.id);
        return sessionStorage.getItem(this.sessionKey) || localStorage.getItem(this.sessionKey) || "";
    }

    /**
     * Get active Google user object
     */
    getActiveUser() {
        return this.activeUser;
    }

    /**
     * Subscribe to logout / account switch to picker
     */
    onLogout(cb) {
        if (typeof cb === "function") this.onLogoutCallbacks.push(cb);
    }

    /**
     * Initialize Google Auth Manager
     */
    async initialize() {
        if (this.initialized) return;

        // Fetch client ID configuration from backend
        try {
            const res = await fetch("/api/auth/google/config");
            const data = await res.json();
            if (data && data.client_id) {
                this.clientId = data.client_id.trim();
            }
        } catch (e) {
            console.warn("Could not fetch Google auth config from server:", e);
        }

        // Check localStorage for manually configured client ID if backend is empty
        if (!this.clientId) {
            this.clientId = (localStorage.getItem("duar_google_client_id") || "").trim();
        }

        this.initGisClient();

        // Check if there is an active session in session/localStorage
        const savedUserId = sessionStorage.getItem(this.sessionKey) || localStorage.getItem(this.sessionKey);
        const accounts = this.getSavedAccounts();

        if (savedUserId && accounts.length > 0) {
            const user = accounts.find(a => a.id === savedUserId);
            if (user) {
                // Restore session
                this.activeUser = user;
                this.accessToken = this.getStoredToken(user.id);
                
                // Initialize cloud storage for this active user
                if (window.CloudStorage) {
                    await window.CloudStorage.initialize(this.activeUser, this.accessToken);
                }

                this._notifyAuthSuccess(user, false);
                this.hideAccountPicker();
                this.initialized = true;
                return;
            }
        }

        // If no active session, show Account Picker Screen
        this.showAccountPicker();
        this.initialized = true;
    }

    /**
     * Initialize Google Identity Services token client
     */
    initGisClient() {
        if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
            // GIS script might still be loading, retry after brief delay
            setTimeout(() => this.initGisClient(), 500);
            return;
        }

        if (!this.clientId) return;

        try {
            this.tokenClient = window.google.accounts.oauth2.initTokenClient({
                client_id: this.clientId,
                scope: this.scopes,
                callback: (tokenResponse) => this.handleTokenResponse(tokenResponse),
                error_callback: (err) => {
                    console.error("Google OAuth error:", err);
                    this.showErrorToast("Google OAuth Error: " + (err.message || "Gagal membuka login Google"));
                    this.renderAccountList();
                }
            });
        } catch (e) {
            console.error("Failed to initialize GIS token client:", e);
        }
    }

    /**
     * Get list of saved Google accounts from local storage
     */
    getSavedAccounts() {
        try {
            const raw = localStorage.getItem(this.storageKey);
            return raw ? JSON.parse(raw) : [];
        } catch (e) {
            return [];
        }
    }

    /**
     * Save account to registry
     */
    saveAccount(account) {
        if (!account || !account.id) return;
        const accounts = this.getSavedAccounts();
        const existingIdx = accounts.findIndex(a => a.id === account.id || a.email === account.email);
        
        account.lastActive = Date.now();

        if (existingIdx >= 0) {
            accounts[existingIdx] = { ...accounts[existingIdx], ...account };
        } else {
            accounts.push(account);
        }

        localStorage.setItem(this.storageKey, JSON.stringify(accounts));
        this.renderAccountList();
    }

    /**
     * Remove account from registry
     */
    removeAccount(accountId, event) {
        if (event) event.stopPropagation();
        
        let accounts = this.getSavedAccounts();
        accounts = accounts.filter(a => a.id !== accountId);
        localStorage.setItem(this.storageKey, JSON.stringify(accounts));
        localStorage.removeItem(this.tokenKeyPrefix + accountId);

        if (this.activeUser && this.activeUser.id === accountId) {
            this.activeUser = null;
            this.accessToken = null;
            sessionStorage.removeItem(this.sessionKey);
            localStorage.removeItem(this.sessionKey);
        }

        this.renderAccountList();
        this.showToast("Akun telah dihapus dari perangkat ini", "info");
    }

    /**
     * Store and retrieve access tokens with expiry
     */
    storeToken(userId, token, expiresIn) {
        if (!userId || !token) return;
        const data = {
            token: token,
            expiresAt: Date.now() + ((expiresIn || 3500) * 1000)
        };
        try {
            sessionStorage.setItem(this.tokenKeyPrefix + userId, JSON.stringify(data));
        } catch (e) {}
    }

    getStoredToken(userId) {
        if (!userId) return null;
        try {
            const raw = sessionStorage.getItem(this.tokenKeyPrefix + userId);
            if (!raw) return null;
            const data = JSON.parse(raw);
            if (data.expiresAt > Date.now() + 60000) { // 1 min buffer
                return data.token;
            }
        } catch (e) {}
        return null;
    }

    /**
     * Trigger Google OAuth Login (Official GIS)
     */
    requestGoogleLogin() {
        // If client ID is configured and GIS is available, use official Google Identity Services
        if (this.clientId && window.google && window.google.accounts && window.google.accounts.oauth2) {
            if (!this.tokenClient) {
                this.initGisClient();
            }
            if (this.tokenClient) {
                this.showLoadingOverlay("Membuka Google Sign-In...");
                this.tokenClient.requestAccessToken({ prompt: "select_account" });
                return;
            }
        }

        // If Google Client ID is not configured yet, open Config / Demo Modal
        this.showClientIdModal();
    }

    /**
     * Handle OAuth Token Response from Google Identity Services
     */
    async handleTokenResponse(response) {
        this.hideLoadingOverlay();

        if (response.error) {
            console.error("OAuth token response error:", response);
            this.showErrorToast("Login Google gagal: " + (response.error_description || response.error));
            this.renderAccountList();
            return;
        }

        if (!response.access_token) {
            this.showErrorToast("Tidak menerima access token dari Google");
            return;
        }

        this.showLoadingOverlay("Memuat profil Google & data akun...");

        try {
            // Fetch user profile from official Google userinfo endpoint
            const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
                headers: { Authorization: `Bearer ${response.access_token}` }
            });

            if (!userInfoRes.ok) {
                throw new Error("Gagal mengambil data profil Google");
            }

            const profile = await userInfoRes.json();
            
            const userObj = {
                id: profile.sub,
                email: profile.email,
                name: profile.name || profile.email.split("@")[0],
                picture: profile.picture || "",
                isGoogle: true
            };

            this.accessToken = response.access_token;
            this.storeToken(userObj.id, this.accessToken, response.expires_in);
            
            // Save to account registry
            this.saveAccount(userObj);

            // Select active user & enter dashboard
            await this.selectAccount(userObj.id);

        } catch (err) {
            console.error("Failed to load Google profile:", err);
            this.showErrorToast("Gagal memuat profil: " + err.message);
            this.hideLoadingOverlay();
            this.showAccountPicker();
        }
    }

    /**
     * User clicks an account in the Account Picker
     */
    async selectAccount(accountId) {
        const accounts = this.getSavedAccounts();
        const user = accounts.find(a => a.id === accountId);

        if (!user) {
            this.showErrorToast("Akun tidak ditemukan");
            return;
        }

        // Highlight selection UI
        const itemElem = document.getElementById(`acc-item-${accountId}`);
        if (itemElem) {
            itemElem.classList.add("account-item-selected");
        }

        this.showLoadingOverlay(`Menyiapkan sesi ${user.name}...`);

        this.activeUser = user;
        sessionStorage.setItem(this.sessionKey, user.id);
        localStorage.setItem(this.sessionKey, user.id);

        this.accessToken = this.getStoredToken(user.id);

        // Notify server session if desired
        try {
            await fetch("/api/auth/google/session", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user })
            });
        } catch (e) {}

        // Initialize user-specific cloud storage
        if (window.CloudStorage) {
            await window.CloudStorage.initialize(user, this.accessToken);
        }

        setTimeout(() => {
            this.hideLoadingOverlay();
            this.hideAccountPicker();
            this._notifyAuthSuccess(user, true);
            this.updateHeaderUI();
        }, 400);
    }

    /**
     * Switch Account (returns to Account Picker)
     */
    switchAccount() {
        this.showAccountPicker();
        // Close modal if open
        const menuModal = bootstrap.Modal.getInstance(document.getElementById("googleAccountModal"));
        if (menuModal) menuModal.hide();
    }

    /**
     * Logout from active session
     */
    async logout() {
        this.activeUser = null;
        this.accessToken = null;
        sessionStorage.removeItem(this.sessionKey);
        localStorage.removeItem(this.sessionKey);

        try {
            await fetch("/api/auth/google/logout", { method: "POST" });
        } catch (e) {}

        // Close dropdown / modal
        const menuModal = bootstrap.Modal.getInstance(document.getElementById("googleAccountModal"));
        if (menuModal) menuModal.hide();

        this.onLogoutCallbacks.forEach(cb => {
            try { cb(); } catch (e) {}
        });

        this.showAccountPicker();
        this.showToast("Anda telah keluar dari akun", "info");
    }

    _notifyAuthSuccess(user, isUserAction = false) {
        this.onAuthSuccessCallbacks.forEach(cb => {
            try { cb(user, isUserAction); } catch (e) { console.error("Callback error:", e); }
        });
        this.updateHeaderUI();
    }

    // ---------------- UI Rendering ----------------

    showAccountPicker() {
        const overlay = document.getElementById("accountPickerOverlay");
        if (overlay) {
            overlay.classList.remove("d-none");
            overlay.classList.add("d-flex");
            document.body.classList.add("picker-active");
            this.renderAccountList();
        }
    }

    hideAccountPicker() {
        const overlay = document.getElementById("accountPickerOverlay");
        if (overlay) {
            overlay.classList.add("d-none");
            overlay.classList.remove("d-flex");
            document.body.classList.remove("picker-active");
        }
    }

    renderAccountList() {
        const listElem = document.getElementById("accountPickerList");
        if (!listElem) return;

        const accounts = this.getSavedAccounts();

        if (accounts.length === 0) {
            listElem.innerHTML = `
                <div class="empty-account-state py-4 text-center">
                    <div class="empty-icon-circle mx-auto mb-2.5">
                        <i class="bi bi-shield-lock text-cyan fs-3"></i>
                    </div>
                    <div class="text-light fw-medium fs-7 mb-1">Belum ada akun tersimpan</div>
                    <div class="text-muted fs-8 px-3">Masuk dengan Akun Google untuk mengakses dashboard dan mengaktifkan cloud backup pribadi.</div>
                </div>
            `;
            return;
        }

        let html = "";
        accounts.forEach(acc => {
            const isActive = this.activeUser && this.activeUser.id === acc.id;
            const avatarHtml = this.getAvatarHtml(acc, 44);
            const activeBadge = isActive ? `<span class="badge bg-success-subtle text-success border border-success-subtle fs-9 px-2 py-0.5 rounded-pill"><i class="bi bi-check-circle-fill me-1"></i>Aktif</span>` : '';

            html += `
                <div class="account-picker-item d-flex align-items-center justify-content-between p-2.5 mb-2 rounded-3 ${isActive ? 'active-account' : ''}" 
                     id="acc-item-${acc.id}" 
                     onclick="window.GoogleAuth.selectAccount('${acc.id}')"
                     role="button"
                     tabindex="0">
                    <div class="d-flex align-items-center gap-3 min-w-0 flex-grow-1">
                        ${avatarHtml}
                        <div class="account-item-details text-start min-w-0 flex-grow-1">
                            <div class="account-item-name text-light fw-semibold text-truncate fs-7">${this.escapeHtml(acc.name)}</div>
                            <div class="account-item-email text-muted text-truncate fs-8">${this.escapeHtml(acc.email)}</div>
                        </div>
                    </div>
                    <div class="d-flex align-items-center gap-1.5 flex-shrink-0 ms-2">
                        ${activeBadge}
                        <button type="button" class="btn-remove-acc" onclick="window.GoogleAuth.removeAccount('${acc.id}', event)" title="Hapus dari daftar">
                            <i class="bi bi-x-lg"></i>
                        </button>
                    </div>
                </div>
            `;
        });

        listElem.innerHTML = html;
    }

    getAvatarHtml(acc, size = 42) {
        if (acc.picture) {
            return `
                <div class="account-avatar-wrapper flex-shrink-0 position-relative" style="width: ${size}px; height: ${size}px;">
                    <img src="${acc.picture}" alt="${this.escapeHtml(acc.name)}" class="rounded-circle object-fit-cover w-100 h-100 border border-secondary" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                    <div class="account-avatar-fallback rounded-circle d-none align-items-center justify-content-center text-white fw-bold" style="width: ${size}px; height: ${size}px; font-size: ${size * 0.4}px; background: ${this.getAvatarGradient(acc.email)};">
                        ${(acc.name || acc.email || "U").charAt(0).toUpperCase()}
                    </div>
                </div>
            `;
        } else {
            const initial = (acc.name || acc.email || "U").charAt(0).toUpperCase();
            return `
                <div class="account-avatar-fallback flex-shrink-0 rounded-circle d-flex align-items-center justify-content-center text-white fw-bold shadow-sm" style="width: ${size}px; height: ${size}px; font-size: ${size * 0.42}px; background: ${this.getAvatarGradient(acc.email)};">
                    ${initial}
                </div>
            `;
        }
    }

    getAvatarGradient(seed = "") {
        const colors = [
            "linear-gradient(135deg, #4285F4 0%, #2b6cb0 100%)",
            "linear-gradient(135deg, #EA4335 0%, #c53030 100%)",
            "linear-gradient(135deg, #34A853 0%, #22543d 100%)",
            "linear-gradient(135deg, #FBBC05 0%, #b7791f 100%)",
            "linear-gradient(135deg, #8E24AA 0%, #581c87 100%)",
            "linear-gradient(135deg, #00ACC1 0%, #0e7490 100%)",
            "linear-gradient(135deg, #E91E63 0%, #9d174d 100%)"
        ];
        let hash = 0;
        for (let i = 0; i < seed.length; i++) {
            hash = seed.charCodeAt(i) + ((hash << 5) - hash);
        }
        const index = Math.abs(hash) % colors.length;
        return colors[index];
    }

    updateHeaderUI() {
        const badgeElem = document.getElementById("googleAccountHeaderBadge");
        if (!badgeElem) return;

        if (this.activeUser) {
            const avatarHtml = this.getAvatarHtml(this.activeUser, 28);
            badgeElem.innerHTML = `
                <div class="d-flex align-items-center gap-1.5 p-1 pe-2 rounded-pill bg-card border border-secondary" role="button" onclick="window.GoogleAuth.openAccountMenu()" title="Google Account: ${this.escapeHtml(this.activeUser.name)}">
                    ${avatarHtml}
                    <div class="d-none d-sm-flex flex-column text-start lh-1">
                        <span class="fs-8 fw-semibold text-light text-truncate" style="max-width: 100px;">${this.escapeHtml(this.activeUser.name)}</span>
                        <span class="fs-9 text-muted d-flex align-items-center gap-1">
                            <span class="status-indicator-dot online"></span> Google
                        </span>
                    </div>
                    <i class="bi bi-chevron-down text-muted fs-9 ms-0.5"></i>
                </div>
            `;
        } else {
            badgeElem.innerHTML = `
                <button class="btn btn-xs btn-outline-primary rounded-pill py-1 px-2.5 d-flex align-items-center gap-1" onclick="window.GoogleAuth.showAccountPicker()">
                    <i class="bi bi-google fs-9"></i>
                    <span class="fs-8 fw-medium">Masuk</span>
                </button>
            `;
        }
    }

    openAccountMenu() {
        if (!this.activeUser) {
            this.showAccountPicker();
            return;
        }

        const modalElem = document.getElementById("googleAccountModal");
        if (!modalElem) return;

        // Populate modal with active user details
        const avatarContainer = document.getElementById("menuModalAvatar");
        if (avatarContainer) avatarContainer.innerHTML = this.getAvatarHtml(this.activeUser, 64);

        const nameElem = document.getElementById("menuModalName");
        if (nameElem) nameElem.textContent = this.activeUser.name;

        const emailElem = document.getElementById("menuModalEmail");
        if (emailElem) emailElem.textContent = this.activeUser.email;

        // Sync status
        const syncStatusElem = document.getElementById("menuModalSyncStatus");
        if (syncStatusElem && window.CloudStorage) {
            const st = window.CloudStorage.getStatus();
            syncStatusElem.innerHTML = `
                <div class="d-flex justify-content-between align-items-center py-2 px-3 bg-darker rounded border border-secondary mb-2">
                    <div class="d-flex align-items-center gap-2">
                        <i class="bi bi-cloud-check text-success fs-5"></i>
                        <div class="text-start">
                            <div class="fs-8 fw-semibold text-light">Google Drive AppData</div>
                            <div class="fs-9 text-muted">Sinkron: ${st.formattedLastSync}</div>
                        </div>
                    </div>
                    <button class="btn btn-xs btn-outline-primary rounded-pill px-2.5" onclick="window.CloudStorage.sync(); window.GoogleAuth.showToast('Sinkronisasi cloud dimulai...', 'info');">
                        <i class="bi bi-arrow-repeat me-1"></i> Sinkron
                    </button>
                </div>
            `;
        }

        const modal = new bootstrap.Modal(modalElem);
        modal.show();
    }

    // ---------------- Setup / Fallback Dialog ----------------

    showClientIdModal() {
        let modalElem = document.getElementById("googleConfigModal");
        if (!modalElem) {
            this.createGoogleConfigModal();
            modalElem = document.getElementById("googleConfigModal");
        }
        const input = document.getElementById("inputGoogleClientId");
        if (input) input.value = this.clientId || "";
        const modal = new bootstrap.Modal(modalElem);
        modal.show();
    }

    createGoogleConfigModal() {
        const html = `
            <div class="modal fade" id="googleConfigModal" tabindex="-1" aria-labelledby="googleConfigModalLabel" aria-hidden="true">
                <div class="modal-dialog modal-dialog-centered">
                    <div class="modal-content bg-card border border-secondary shadow-lg">
                        <div class="modal-header border-bottom border-secondary py-2.5 px-3">
                            <div class="d-flex align-items-center gap-2">
                                <span class="brand-badge" style="background: #4285F4;"><i class="bi bi-google"></i></span>
                                <h6 class="modal-title fw-bold text-light m-0" id="googleConfigModalLabel">Setup Google OAuth / Client ID</h6>
                            </div>
                            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
                        </div>
                        <div class="modal-body p-3">
                            <div class="alert alert-info py-2 px-3 fs-8 mb-3">
                                <i class="bi bi-info-circle me-1.5"></i>
                                Untuk menghubungkan Google OAuth resmi & Google Drive AppData, masukkan <b>Google OAuth 2.0 Client ID</b> dari Google Cloud Console.
                            </div>

                            <div class="mb-3">
                                <label class="form-label fs-8 text-muted mb-1">Google OAuth Client ID</label>
                                <input type="text" id="inputGoogleClientId" class="form-control form-control-sm font-monospace" placeholder="xxxx.apps.googleusercontent.com">
                                <div class="form-text fs-9 text-muted mt-1">
                                    Authorized JavaScript origin: <code>http://localhost:4090</code> (atau domain hosting Anda)
                                </div>
                            </div>

                            <div class="d-flex flex-column gap-2 pt-1">
                                <button type="button" class="btn btn-primary btn-sm fw-semibold" onclick="window.GoogleAuth.saveConfigAndLogin()">
                                    <i class="bi bi-google me-1"></i> Simpan & Login Google
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML("beforeend", html);
    }

    saveConfigAndLogin() {
        const input = document.getElementById("inputGoogleClientId");
        if (!input) return;
        const val = input.value.trim();
        if (val) {
            this.clientId = val;
            localStorage.setItem("duar_google_client_id", val);
            this.initGisClient();
            
            const modal = bootstrap.Modal.getInstance(document.getElementById("googleConfigModal"));
            if (modal) modal.hide();

            this.showToast("Google Client ID disimpan", "success");
            setTimeout(() => {
                if (this.tokenClient) {
                    this.tokenClient.requestAccessToken({ prompt: "select_account" });
                }
            }, 300);
        } else {
            this.showErrorToast("Masukkan Client ID yang valid");
        }
    }

    // ---------------- Utilities ----------------

    showLoadingOverlay(text = "Memuat...") {
        let overlay = document.getElementById("googleAuthLoadingOverlay");
        if (!overlay) {
            const html = `
                <div id="googleAuthLoadingOverlay" class="position-fixed top-0 start-0 w-100 h-100 d-flex flex-column align-items-center justify-content-center" style="z-index: 99999; background: rgba(10, 14, 23, 0.88); backdrop-filter: blur(6px);">
                    <div class="spinner-border text-cyan mb-3" style="width: 3rem; height: 3rem;" role="status"></div>
                    <div class="text-light fw-medium fs-7" id="googleAuthLoadingText">${text}</div>
                </div>
            `;
            document.body.insertAdjacentHTML("beforeend", html);
            overlay = document.getElementById("googleAuthLoadingOverlay");
        } else {
            document.getElementById("googleAuthLoadingText").textContent = text;
            overlay.classList.remove("d-none");
            overlay.classList.add("d-flex");
        }
    }

    hideLoadingOverlay() {
        const overlay = document.getElementById("googleAuthLoadingOverlay");
        if (overlay) {
            overlay.classList.add("d-none");
            overlay.classList.remove("d-flex");
        }
    }

    showToast(message, type = "info") {
        if (typeof window.showToast === "function") {
            window.showToast(message, type);
        } else {
            console.log(`[${type.toUpperCase()}] ${message}`);
        }
    }

    showErrorToast(message) {
        this.showToast(message, "danger");
    }

    escapeHtml(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
}

// Global Singleton
window.GoogleAuth = new GoogleAuthManager();
