/**
 * MYnyak Engsel Web Client — Terminal & Command Runner Logic
 */

// Command Definitions & Schema
const COMMAND_SCHEMAS = {
    "get-profile": {
        name: "get-profile",
        description: "Ambil informasi profil pengguna, subscriber_id, nomor, dan tipe langganan aktif.",
        args: [],
        options: []
    },
    "get-balance": {
        name: "get-balance",
        description: "Ambil sisa pulsa reguler dan masa berlaku aktif kartu.",
        args: [],
        options: []
    },
    "my-packages": {
        name: "my-packages",
        description: "Ambil daftar paket aktif, sisa kuota (Data/Voice/SMS), dan detail kuota.",
        args: [],
        options: []
    },
    "hot-packages": {
        name: "hot-packages",
        description: "Ambil katalog paket promo Hot Promo dari database lokal.",
        args: [],
        options: []
    },
    "hot2-packages": {
        name: "hot2-packages",
        description: "Ambil katalog paket promo Hot-2 dari database lokal.",
        args: [],
        options: []
    },
    "package-detail": {
        name: "package-detail",
        description: "Lihat detail paket, harga, benefits kuota, dan token konfirmasi berdasarkan Option Code.",
        args: [
            { name: "option_code", label: "Option Code", type: "text", required: true, placeholder: "U0NfX..." }
        ],
        options: []
    },
    "family-packages": {
        name: "family-packages",
        description: "Lihat daftar varian dan seluruh paket di dalam Family Code tertentu.",
        args: [
            { name: "family_code", label: "Family Code (UUID)", type: "text", required: true, placeholder: "23ddccc0-ac04-4e80-a939-5f5d76f4bc64" }
        ],
        options: [
            { name: "is_enterprise", label: "Enterprise Store", type: "boolean", default: false }
        ]
    },
    "purchase-package": {
        name: "purchase-package",
        description: "Beli paket berdasarkan Option Code menggunakan metode pembayaran tertentu.",
        args: [
            { name: "option_code", label: "Option Code", type: "text", required: true, placeholder: "U0NfX..." }
        ],
        options: [
            {
                name: "method",
                label: "Metode Bayar",
                type: "select",
                default: "balance",
                options: [
                    { value: "balance", label: "Pulsa Reguler" },
                    { value: "balance_decoy_v2", label: "Pulsa + Decoy V2" },
                    { value: "balance_decoy", label: "Pulsa + Decoy V1" },
                    { value: "qris", label: "QRIS Direct" },
                    { value: "qris_decoy", label: "QRIS + Decoy (+1k)" },
                    { value: "qris_decoy0", label: "QRIS + Decoy (Rp0)" },
                    { value: "redeem_loyalty", label: "Tukar Poin / Loyalty" }
                ]
            },
            { name: "overwrite_amount", label: "Overwrite Amount (Opsional)", type: "number", placeholder: "Contoh: 0" }
        ]
    },
    "purchase-family-loop": {
        name: "purchase-family-loop",
        description: "Beli berulang semua opsi paket yang tersedia di dalam suatu Family Code.",
        args: [
            { name: "family_code", label: "Family Code (UUID)", type: "text", required: true, placeholder: "23ddccc0-ac04-4e80-a939-5f5d76f4bc64" }
        ],
        options: [
            { name: "start_from_option", label: "Mulai dari Opsi No.", type: "number", default: 1 },
            { name: "delay_seconds", label: "Delay antar transaksi (detik)", type: "number", default: 0 },
            { name: "use_decoy", label: "Gunakan Decoy Package", type: "boolean", default: true }
        ]
    },
    "transaction-history": {
        name: "transaction-history",
        description: "Ambil riwayat transaksi pembelian dan status pembayaran akun.",
        args: [],
        options: []
    },
    "family-plan-info": {
        name: "family-plan-info",
        description: "Lihat rincian anggota dan kuota bersama Paket Akrab / Family Plan.",
        args: [],
        options: []
    },
    "circle-info": {
        name: "circle-info",
        description: "Lihat data grup Circle, target pengeluaran bersama, dan anggota Circle.",
        args: [],
        options: []
    },
    "validate-msisdn": {
        name: "validate-msisdn",
        description: "Validasi apakah nomor MSISDN valid di jaringan operator.",
        args: [
            { name: "msisdn", label: "Nomor MSISDN (628xxxx)", type: "text", required: true, placeholder: "6281234567890" }
        ],
        options: []
    },
    "dukcapil-register": {
        name: "dukcapil-register",
        description: "Registrasi prabayar menggunakan NIK dan Nomor KK.",
        args: [
            { name: "msisdn", label: "Nomor MSISDN (628xxxx)", type: "text", required: true, placeholder: "6281234567890" },
            { name: "kk", label: "Nomor KK (16 digit)", type: "text", required: true, placeholder: "3201xxxxxxxxxxxx" },
            { name: "nik", label: "Nomor NIK (16 digit)", type: "text", required: true, placeholder: "3201xxxxxxxxxxxx" }
        ],
        options: []
    },
    "store-segments": {
        name: "store-segments",
        description: "Ambil kategori segmen store dari API XL.",
        args: [],
        options: [
            { name: "is_enterprise", label: "Enterprise Store", type: "boolean", default: false }
        ]
    },
    "store-families": {
        name: "store-families",
        description: "Cari daftar family paket di katalog store.",
        args: [],
        options: [
            { name: "subs_type", label: "Tipe Pelanggan", type: "select", default: "PREPAID", options: [{ value: "PREPAID", label: "PREPAID" }, { value: "POSTPAID", label: "POSTPAID" }] },
            { name: "is_enterprise", label: "Enterprise Store", type: "boolean", default: false }
        ]
    },
    "store-packages": {
        name: "store-packages",
        description: "Cari paket di katalog store.",
        args: [],
        options: [
            { name: "subs_type", label: "Tipe Pelanggan", type: "select", default: "PREPAID", options: [{ value: "PREPAID", label: "PREPAID" }, { value: "POSTPAID", label: "POSTPAID" }] },
            { name: "is_enterprise", label: "Enterprise Store", type: "boolean", default: false }
        ]
    },
    "store-redeemables": {
        name: "store-redeemables",
        description: "Ambil daftar voucher/hadiah redeemable dari personalisasi akun.",
        args: [],
        options: [
            { name: "is_enterprise", label: "Enterprise Store", type: "boolean", default: false }
        ]
    },
    "get-notifications": {
        name: "get-notifications",
        description: "Ambil daftar pesan notifikasi akun.",
        args: [],
        options: []
    },
    "list-bookmarks": {
        name: "list-bookmarks",
        description: "Ambil daftar bookmark paket tersimpan.",
        args: [],
        options: []
    }
};

let terminalInitialized = false;

function initTerminalRunner() {
    if (terminalInitialized) return;
    terminalInitialized = true;

    const select = document.getElementById("cliCommandSelect");
    if (!select) return;

    select.innerHTML = `<option value="">-- Pilih Command --</option>`;
    Object.keys(COMMAND_SCHEMAS).forEach(cmdKey => {
        const cmd = COMMAND_SCHEMAS[cmdKey];
        select.innerHTML += `<option value="${cmd.name}">${cmd.name} — ${cmd.description.substring(0, 38)}...</option>`;
    });

    renderCommandHistory();
}

function onCliCommandChange() {
    const select = document.getElementById("cliCommandSelect");
    const cmdKey = select.value;
    const descElem = document.getElementById("cliCommandDescription");
    const argsContainer = document.getElementById("cliArgsContainer");

    if (!cmdKey || !COMMAND_SCHEMAS[cmdKey]) {
        descElem.classList.add("d-none");
        argsContainer.innerHTML = "";
        updateCommandPreview();
        return;
    }

    const schema = COMMAND_SCHEMAS[cmdKey];
    descElem.textContent = schema.description;
    descElem.classList.remove("d-none");

    let formHtml = "";

    // Render Arguments
    (schema.args || []).forEach(arg => {
        formHtml += `
            <div class="mb-2">
                <label class="form-label fs-8 text-muted">${arg.label} ${arg.required ? '<span class="text-danger">*</span>' : ''}</label>
                <input type="${arg.type || 'text'}" class="form-control form-control-sm font-monospace cli-arg-input" 
                    data-arg-name="${arg.name}" placeholder="${arg.placeholder || ''}" oninput="updateCommandPreview()">
            </div>
        `;
    });

    // Render Options
    (schema.options || []).forEach(opt => {
        if (opt.type === "boolean") {
            formHtml += `
                <div class="form-check form-switch mb-2">
                    <input class="form-check-input cli-opt-input" type="checkbox" data-opt-name="${opt.name}" ${opt.default ? 'checked' : ''} onchange="updateCommandPreview()">
                    <label class="form-check-label fs-8 text-muted">${opt.label}</label>
                </div>
            `;
        } else if (opt.type === "select") {
            let optOptionsHtml = "";
            (opt.options || []).forEach(o => {
                optOptionsHtml += `<option value="${o.value}" ${o.value === opt.default ? 'selected' : ''}>${o.label}</option>`;
            });
            formHtml += `
                <div class="mb-2">
                    <label class="form-label fs-8 text-muted">${opt.label}</label>
                    <select class="form-select form-select-sm font-monospace cli-opt-input" data-opt-name="${opt.name}" onchange="updateCommandPreview()">
                        ${optOptionsHtml}
                    </select>
                </div>
            `;
        } else {
            formHtml += `
                <div class="mb-2">
                    <label class="form-label fs-8 text-muted">${opt.label}</label>
                    <input type="${opt.type || 'text'}" class="form-control form-control-sm font-monospace cli-opt-input" 
                        data-opt-name="${opt.name}" value="${opt.default !== undefined ? opt.default : ''}" placeholder="${opt.placeholder || ''}" oninput="updateCommandPreview()">
                </div>
            `;
        }
    });

    argsContainer.innerHTML = formHtml;
    updateCommandPreview();
}

function updateCommandPreview() {
    const cmdKey = document.getElementById("cliCommandSelect").value;
    const preview = document.getElementById("cliCommandPreview");

    if (!cmdKey) {
        preview.textContent = "me-cli";
        return;
    }

    let cmdStr = `me-cli ${cmdKey}`;

    // Read Args
    document.querySelectorAll(".cli-arg-input").forEach(input => {
        const val = input.value.trim();
        const name = input.getAttribute("data-arg-name");
        if (val) {
            cmdStr += ` --${name}="${val}"`;
        }
    });

    // Read Options
    document.querySelectorAll(".cli-opt-input").forEach(input => {
        const name = input.getAttribute("data-opt-name");
        if (input.type === "checkbox") {
            if (input.checked) {
                cmdStr += ` --${name}`;
            }
        } else {
            const val = input.value.trim();
            if (val) {
                cmdStr += ` --${name}="${val}"`;
            }
        }
    });

    preview.textContent = cmdStr;
}

function resetCommandForm() {
    document.getElementById("cliCommandSelect").value = "";
    onCliCommandChange();
}

async function runSelectedCommand() {
    const cmdKey = document.getElementById("cliCommandSelect").value;
    if (!cmdKey) {
        showToast("Pilih command terlebih dahulu", "warning");
        return;
    }

    const args = {};
    document.querySelectorAll(".cli-arg-input").forEach(input => {
        const name = input.getAttribute("data-arg-name");
        const val = input.value.trim();
        if (val) args[name] = val;
    });

    const options = {};
    document.querySelectorAll(".cli-opt-input").forEach(input => {
        const name = input.getAttribute("data-opt-name");
        if (input.type === "checkbox") {
            options[name] = input.checked;
        } else {
            const val = input.value.trim();
            if (val) options[name] = val;
        }
    });

    const btn = document.getElementById("btnRunCommand");
    const statusBadge = document.getElementById("terminalStatusBadge");
    const consoleElem = document.getElementById("terminalConsole");

    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Running...`;
    statusBadge.className = "badge bg-warning text-dark font-monospace fs-8";
    statusBadge.textContent = "RUNNING";

    const cmdStr = document.getElementById("cliCommandPreview").textContent.trim();
    consoleElem.textContent = `> ${cmdStr}\n[Executing command in isolated runner...]\n\n`;

    try {
        const res = await fetch("/api/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                command: cmdKey,
                args: args,
                options: options
            })
        });
        const data = await res.json();

        document.getElementById("terminalExecTime").textContent = `Duration: ${data.duration || '0.00'}s`;
        document.getElementById("terminalExitCode").textContent = `Exit Code: ${data.exitCode !== undefined ? data.exitCode : 0}`;

        if (data.success) {
            statusBadge.className = "badge bg-success font-monospace fs-8";
            statusBadge.textContent = "SUCCESS (0)";
            consoleElem.textContent = data.stdout || "[Process completed with no output]";
            showToast(`Command ${cmdKey} selesai`, "success");
        } else {
            statusBadge.className = "badge bg-danger font-monospace fs-8";
            statusBadge.textContent = `FAILED (${data.exitCode || 1})`;
            consoleElem.textContent = (data.stdout ? data.stdout + "\n" : "") + (data.stderr || data.error || "Execution failed");
            showToast(`Command ${cmdKey} gagal`, "danger");
        }

        // Save to history
        saveCommandHistory(cmdKey, cmdStr, data.success, data.duration);

    } catch (e) {
        statusBadge.className = "badge bg-danger font-monospace fs-8";
        statusBadge.textContent = "ERROR";
        consoleElem.textContent = `Network / Execution Error: ${e.message}`;
        showToast("Error: " + e.message, "danger");
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="bi bi-play-fill me-1"></i> Run Command`;
        consoleElem.scrollTop = consoleElem.scrollHeight;
    }
}

// ----------------- COMMAND HISTORY -----------------
function saveCommandHistory(command, cmdStr, success, duration) {
    let history = [];
    try {
        history = JSON.parse(localStorage.getItem("me_cli_history") || "[]");
    } catch (e) { history = []; }

    history.unshift({
        command,
        cmdStr,
        success,
        duration,
        time: new Date().toLocaleTimeString()
    });

    if (history.length > 20) history = history.slice(0, 20);
    localStorage.setItem("me_cli_history", JSON.stringify(history));

    renderCommandHistory();
}

function renderCommandHistory() {
    const listElem = document.getElementById("cliHistoryList");
    if (!listElem) return;

    let history = [];
    try {
        history = JSON.parse(localStorage.getItem("me_cli_history") || "[]");
    } catch (e) { history = []; }

    if (history.length === 0) {
        listElem.innerHTML = `<div class="p-3 text-center text-muted">Belum ada riwayat command.</div>`;
        return;
    }

    let html = "";
    history.forEach((h, idx) => {
        const badge = h.success ? `<span class="badge bg-success-subtle text-success fs-9">OK</span>` : `<span class="badge bg-danger-subtle text-danger fs-9">ERR</span>`;
        html += `
            <div class="list-group-item bg-dark border-secondary d-flex justify-content-between align-items-center py-1 px-2" style="cursor: pointer;" onclick="loadHistoryItem('${h.command}')">
                <div class="text-truncate me-2" title="${h.cmdStr}">
                    <span class="text-cyan">${h.command}</span>
                    <span class="text-muted fs-9 ms-1">${h.time}</span>
                </div>
                ${badge}
            </div>
        `;
    });

    listElem.innerHTML = html;
}

function loadHistoryItem(cmdName) {
    const select = document.getElementById("cliCommandSelect");
    if (select) {
        select.value = cmdName;
        onCliCommandChange();
        showToast(`Command ${cmdName} dimuat ke form`, "info");
    }
}

function clearCommandHistory() {
    localStorage.removeItem("me_cli_history");
    renderCommandHistory();
    showToast("Riwayat command dibersihkan", "info");
}

function copyConsoleOutput() {
    const text = document.getElementById("terminalConsole").textContent;
    navigator.clipboard.writeText(text).then(() => {
        showToast("Output console disalin ke clipboard", "info");
    }).catch(() => {
        showToast("Gagal menyalin output", "warning");
    });
}

function clearConsoleOutput() {
    document.getElementById("terminalConsole").textContent = `console cleared.`;
    document.getElementById("terminalStatusBadge").className = "badge bg-secondary font-monospace fs-8";
    document.getElementById("terminalStatusBadge").textContent = "IDLE";
    document.getElementById("terminalExecTime").textContent = "Duration: 0.00s";
    document.getElementById("terminalExitCode").textContent = "Exit Code: -";
}
