/**
 * CloudStorage — Google Drive AppData Cloud Storage Layer for DUAR
 * Stores user-specific settings, bookmarks, presets, history in the user's personal Google Drive appDataFolder
 */

class CloudStorageLayer {
    constructor() {
        this.currentUser = null;
        this.accessToken = null;
        this.driveFileId = null;
        this.status = "synced"; // 'synced' | 'syncing' | 'offline' | 'error' | 'local_only'
        this.lastSyncTime = null;
        this.listeners = [];
        this.syncDebounceTimer = null;
        this.cacheKeyPrefix = "duar_user_cloud_";
        this.defaultData = {
            version: 1,
            appName: "DUAR",
            updatedAt: new Date().toISOString(),
            user: {
                id: "",
                email: "",
                name: "",
                picture: ""
            },
            settings: {
                theme: "dark",
                defaultPaymentMethod: "balance_decoy_v2",
                autoRefreshInterval: 0,
                compactView: false,
                notifyOnSuccess: true
            },
            xl_accounts: [],
            active_xl_number: null,
            active_decoy: "main",
            bookmarks: [],
            presets: [],
            history: [],
            preferences: {}
        };
    }

    /**
     * Subscribe to sync status updates
     * @param {Function} callback 
     */
    onStatusChange(callback) {
        if (typeof callback === "function") {
            this.listeners.push(callback);
        }
    }

    _setStatus(status, message = "") {
        this.status = status;
        const statusInfo = this.getStatus();
        statusInfo.message = message;
        this.listeners.forEach(cb => {
            try { cb(statusInfo); } catch (e) { console.error("Listener error:", e); }
        });
    }

    getStatus() {
        return {
            status: this.status,
            lastSyncTime: this.lastSyncTime,
            formattedLastSync: this.lastSyncTime ? new Date(this.lastSyncTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : "-",
            isOnline: navigator.onLine,
            driveFileId: this.driveFileId,
            user: this.currentUser ? { id: this.currentUser.id, email: this.currentUser.email } : null
        };
    }

    /**
     * Initialize storage layer with active user and Google access token
     */
    async initialize(user, accessToken = null) {
        this.currentUser = user;
        this.accessToken = accessToken;
        this.driveFileId = null;

        if (!user || !user.id) {
            this._setStatus("offline", "Tidak ada akun aktif");
            return null;
        }

        const cacheKey = this.cacheKeyPrefix + user.id;
        let data = this.getLocalCache(user.id);

        if (!data) {
            data = JSON.parse(JSON.stringify(this.defaultData));
            data.user = {
                id: user.id,
                email: user.email,
                name: user.name,
                picture: user.picture || ""
            };
            this.setLocalCache(user.id, data);
        }

        // If online & we have Google access token, load from Google Drive appDataFolder
        if (this.accessToken && navigator.onLine) {
            try {
                this._setStatus("syncing", "Menghubungkan ke Google Drive...");
                const driveData = await this._loadFromGoogleDrive();
                if (driveData) {
                    // Safe merge
                    data = this._mergeData(data, driveData);
                    this.setLocalCache(user.id, data);
                    this.lastSyncTime = Date.now();
                    this._setStatus("synced", "Tersinkron dengan Google Drive");
                } else {
                    // Cloud file doesn't exist yet -> upload initial data
                    await this._createGoogleDriveFile(data);
                    this.lastSyncTime = Date.now();
                    this._setStatus("synced", "Data awal disimpan ke Google Drive");
                }
            } catch (err) {
                console.warn("Google Drive initial load failed, using local cache:", err);
                this._setStatus("local_only", "Menggunakan cache lokal");
            }
        } else {
            this._setStatus("local_only", "Mode offline / cache lokal");
        }

        // Sync loaded cloud/cache data with backend isolated session
        await this.syncToBackendSession(data);

        return data;
    }

    /**
     * Sync user data to backend isolated session
     */
    async syncToBackendSession(customData = null) {
        if (!this.currentUser || !this.currentUser.id) return;
        const data = customData || this.getLocalCache(this.currentUser.id);
        if (!data) return;

        try {
            await fetch("/api/auth/google/sync-session", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-User-Id": String(this.currentUser.id)
                },
                body: JSON.stringify({
                    user_id: String(this.currentUser.id),
                    accounts: data.xl_accounts || [],
                    active_number: data.active_xl_number || null,
                    bookmarks: data.bookmarks || [],
                    active_decoy: data.active_decoy || null
                })
            });
        } catch (e) {
            console.warn("Could not sync session to backend:", e);
        }
    }

    /**
     * Save active Decoy choice to user cloud storage
     */
    async saveActiveDecoy(decoyId) {
        if (!this.currentUser || !this.currentUser.id) return;
        const data = this.getLocalCache(this.currentUser.id) || JSON.parse(JSON.stringify(this.defaultData));
        data.active_decoy = decoyId || "main";
        this.setLocalCache(this.currentUser.id, data);
        this.save(data);
    }

    /**
     * Save XL accounts list to user cloud storage
     */
    async saveXlAccounts(accountsList, activeNumber = null) {
        if (!this.currentUser || !this.currentUser.id) return;
        const data = this.getLocalCache(this.currentUser.id) || JSON.parse(JSON.stringify(this.defaultData));
        data.xl_accounts = accountsList || [];
        if (activeNumber !== undefined && activeNumber !== null) {
            data.active_xl_number = activeNumber;
        }
        this.setLocalCache(this.currentUser.id, data);
        this.save(data);
    }

    /**
     * Save Bookmarks list to user cloud storage
     */
    async saveBookmarks(bookmarksList) {
        if (!this.currentUser || !this.currentUser.id) return;
        const data = this.getLocalCache(this.currentUser.id) || JSON.parse(JSON.stringify(this.defaultData));
        data.bookmarks = bookmarksList || [];
        this.setLocalCache(this.currentUser.id, data);
        this.save(data);
    }

    /**
     * Get data from localStorage cache for specific user
     */
    getLocalCache(userId) {
        if (!userId) return null;
        try {
            const raw = localStorage.getItem(this.cacheKeyPrefix + userId);
            if (raw) return JSON.parse(raw);
        } catch (e) {
            console.error("Failed to read local cache:", e);
        }
        return null;
    }

    /**
     * Save data to localStorage cache for specific user
     */
    setLocalCache(userId, data) {
        if (!userId || !data) return;
        try {
            data.updatedAt = new Date().toISOString();
            localStorage.setItem(this.cacheKeyPrefix + userId, JSON.stringify(data));
        } catch (e) {
            console.error("Failed to write local cache:", e);
        }
    }

    /**
     * Load current user data (cached first, then cloud synced)
     */
    async load() {
        if (!this.currentUser) return null;
        const cached = this.getLocalCache(this.currentUser.id);
        if (cached) return cached;
        return this.initialize(this.currentUser, this.accessToken);
    }

    /**
     * Save user data: updates local cache immediately, then debounces sync to Google Drive
     */
    save(data, immediate = false) {
        if (!this.currentUser || !this.currentUser.id) return;

        data.updatedAt = new Date().toISOString();
        this.setLocalCache(this.currentUser.id, data);

        if (this.syncDebounceTimer) {
            clearTimeout(this.syncDebounceTimer);
            this.syncDebounceTimer = null;
        }

        if (immediate) {
            this.sync();
        } else {
            this._setStatus("syncing", "Menyiapkan sinkronisasi...");
            this.syncDebounceTimer = setTimeout(() => {
                this.sync();
            }, 2500); // 2.5s debounce to protect quota & battery
        }
    }

    /**
     * Update partial user data
     */
    async update(partial) {
        const current = await this.load() || JSON.parse(JSON.stringify(this.defaultData));
        const updated = {
            ...current,
            ...partial,
            user: { ...current.user, ...(partial.user || {}) },
            settings: { ...current.settings, ...(partial.settings || {}) },
            preferences: { ...current.preferences, ...(partial.preferences || {}) },
            updatedAt: new Date().toISOString()
        };
        this.save(updated);
        return updated;
    }

    /**
     * Immediate synchronization to Google Drive
     */
    async sync() {
        if (!this.currentUser || !this.currentUser.id) return;
        const data = this.getLocalCache(this.currentUser.id);
        if (!data) return;

        if (!navigator.onLine) {
            this._setStatus("offline", "Koneksi offline, data tersimpan di perangkat");
            return;
        }

        if (!this.accessToken) {
            this._setStatus("local_only", "Tersimpan secara lokal di browser");
            return;
        }

        try {
            this._setStatus("syncing", "Menyinkronkan ke Google Drive...");
            if (this.driveFileId) {
                await this._updateGoogleDriveFile(this.driveFileId, data);
            } else {
                const existingFileId = await this._findGoogleDriveFile();
                if (existingFileId) {
                    this.driveFileId = existingFileId;
                    await this._updateGoogleDriveFile(existingFileId, data);
                } else {
                    const newId = await this._createGoogleDriveFile(data);
                    this.driveFileId = newId;
                }
            }
            this.lastSyncTime = Date.now();
            this._setStatus("synced", "Tersinkron");
        } catch (err) {
            console.error("Cloud sync error:", err);
            this._setStatus("error", "Gagal sinkronisasi cloud: " + (err.message || "Error"));
        }
    }

    // ---------------- Google Drive API v3 Helpers ----------------

    async _findGoogleDriveFile() {
        const query = encodeURIComponent("name = 'duar-user-data.json' and trashed = false");
        const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&fields=files(id,name,modifiedTime)`;
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${this.accessToken}` }
        });
        if (!res.ok) {
            throw new Error(`Drive search failed (${res.status})`);
        }
        const json = await res.json();
        if (json.files && json.files.length > 0) {
            return json.files[0].id;
        }
        return null;
    }

    async _loadFromGoogleDrive() {
        const fileId = await this._findGoogleDriveFile();
        if (!fileId) return null;
        this.driveFileId = fileId;

        const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${this.accessToken}` }
        });
        if (!res.ok) {
            throw new Error(`Failed to download file (${res.status})`);
        }
        return await res.json();
    }

    async _createGoogleDriveFile(data) {
        const boundary = "-------314159265358979323846";
        const delimiter = "\r\n--" + boundary + "\r\n";
        const close_delim = "\r\n--" + boundary + "--";

        const metadata = {
            name: "duar-user-data.json",
            parents: ["appDataFolder"],
            mimeType: "application/json"
        };

        const multipartRequestBody =
            delimiter +
            "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
            JSON.stringify(metadata) +
            delimiter +
            "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
            JSON.stringify(data, null, 2) +
            close_delim;

        const url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
        const res = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.accessToken}`,
                "Content-Type": `multipart/related; boundary=${boundary}`
            },
            body: multipartRequestBody
        });

        if (!res.ok) {
            throw new Error(`Failed to create cloud file (${res.status})`);
        }
        const created = await res.json();
        this.driveFileId = created.id;
        return created.id;
    }

    async _updateGoogleDriveFile(fileId, data) {
        const url = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`;
        const res = await fetch(url, {
            method: "PATCH",
            headers: {
                Authorization: `Bearer ${this.accessToken}`,
                "Content-Type": "application/json; charset=UTF-8"
            },
            body: JSON.stringify(data, null, 2)
        });

        if (!res.ok) {
            throw new Error(`Failed to update cloud file (${res.status})`);
        }
        return await res.json();
    }

    _mergeData(local, cloud) {
        if (!cloud) return local;
        if (!local) return cloud;

        const merged = { ...local, ...cloud };
        merged.settings = { ...(local.settings || {}), ...(cloud.settings || {}) };
        merged.preferences = { ...(local.preferences || {}), ...(cloud.preferences || {}) };

        // Merge arrays uniquely (bookmarks by id/family_code, presets by id)
        const bmMap = new Map();
        (local.bookmarks || []).forEach(b => { if (b.id || b.family_code) bmMap.set(b.id || b.family_code, b); });
        (cloud.bookmarks || []).forEach(b => { if (b.id || b.family_code) bmMap.set(b.id || b.family_code, b); });
        merged.bookmarks = Array.from(bmMap.values());

        const presetMap = new Map();
        (local.presets || []).forEach(p => { if (p.id) presetMap.set(p.id, p); });
        (cloud.presets || []).forEach(p => { if (p.id) presetMap.set(p.id, p); });
        merged.presets = Array.from(presetMap.values());

        // History: combine and sort recent
        const historySet = new Set();
        const combinedHist = [];
        [...(cloud.history || []), ...(local.history || [])].forEach(h => {
            const key = h.cmdStr || h.command || JSON.stringify(h);
            if (!historySet.has(key)) {
                historySet.add(key);
                combinedHist.push(h);
            }
        });
        merged.history = combinedHist.slice(0, 30);

        return merged;
    }
}

// Global Singleton
window.CloudStorage = new CloudStorageLayer();
