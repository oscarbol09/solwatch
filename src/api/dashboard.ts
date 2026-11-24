import type { SolanaCluster } from "../domain/types.js";

export type DashboardRenderOptions = {
  readonly nonce: string;
  readonly cluster: SolanaCluster;
  readonly authRequired: boolean;
};

export function renderDashboardHtml(options: DashboardRenderOptions): string {
  const safeNonce = options.nonce.replace(/[^A-Za-z0-9+/=_-]/g, "");
  const authFlag = options.authRequired ? "true" : "false";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>solwatch Console</title>
  <style nonce="${safeNonce}">
    :root {
      color-scheme: dark;
      --bg: #0b0d10;
      --surface: #12151a;
      --surface-alt: #171b22;
      --border: rgba(255, 255, 255, 0.08);
      --border-strong: rgba(255, 255, 255, 0.16);
      --text: #f1f5f9;
      --muted: #94a3b8;
      --accent: #14f195;
      --accent-ink: #041d11;
      --amber: #f59e0b;
      --coral: #ef4444;
      --violet: #a78bfa;
      --sans: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --radius: 8px;
    }
    * { box-sizing: border-box; }
    ::selection { background: rgba(20, 241, 149, 0.25); color: var(--text); }
    input, textarea, select { caret-color: var(--accent); }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 0.9375rem;
      line-height: 1.45;
    }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 20;
      background: rgba(18, 21, 26, 0.94);
      backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--border);
      padding: 0.75rem 1.25rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
    }
    .brand { display: flex; align-items: center; gap: 0.65rem; font-weight: 600; letter-spacing: -0.01em; }
    .brand-meta { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-family: var(--mono);
      font-size: 0.75rem;
      padding: 0.2rem 0.55rem;
      border-radius: 999px;
      background: var(--surface-alt);
      border: 1px solid var(--border);
      color: var(--muted);
    }
    .pill-live { color: var(--accent); border-color: rgba(20, 241, 149, 0.32); background: rgba(20, 241, 149, 0.1); }
    .pill-warn { color: var(--amber); border-color: rgba(245, 158, 11, 0.32); background: rgba(245, 158, 11, 0.1); }
    .pill-err { color: var(--coral); border-color: rgba(239, 68, 68, 0.35); background: rgba(239, 68, 68, 0.12); }
    .pill-swap { color: var(--violet); border-color: rgba(167, 139, 250, 0.35); background: rgba(167, 139, 250, 0.12); }
    .top-actions { display: flex; align-items: center; gap: 0.5rem; }
    main { max-width: 1380px; margin: 0 auto; padding: 1.25rem; display: grid; gap: 1rem; }
    .kpi-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 0.75rem;
    }
    .kpi {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 0.75rem 0.9rem;
    }
    .kpi-label { font-size: 0.75rem; color: var(--muted); display: block; }
    .kpi-value { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 1.25rem; font-weight: 600; margin-top: 0.15rem; }
    .workspace {
      display: grid;
      grid-template-columns: minmax(0, 1.05fr) minmax(0, 1.15fr);
      gap: 1rem;
      align-items: start;
    }
    @media (max-width: 980px) {
      .workspace { grid-template-columns: minmax(0, 1fr); }
    }
    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }
    .panel-head {
      padding: 0.85rem 1rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      flex-wrap: wrap;
    }
    .panel-title { margin: 0; font-size: 0.95rem; font-weight: 600; }
    .panel-body { padding: 0.9rem 1rem; }
    .btn {
      font-family: var(--sans);
      font-size: 0.8125rem;
      font-weight: 500;
      border-radius: 6px;
      border: 1px solid var(--border-strong);
      background: var(--surface-alt);
      color: var(--text);
      padding: 0.42rem 0.75rem;
      cursor: pointer;
      transition: transform 150ms cubic-bezier(0.16, 1, 0.3, 1), border-color 150ms ease;
    }
    .btn:hover { border-color: rgba(255, 255, 255, 0.32); }
    .btn:active { transform: scale(0.98); }
    .btn-primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
    .btn-danger { color: var(--coral); border-color: rgba(239, 68, 68, 0.35); }
    .btn-sm { padding: 0.25rem 0.55rem; font-size: 0.75rem; }
    .form-row { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: end; margin-bottom: 0.85rem; }
    .field { display: flex; flex-direction: column; gap: 0.25rem; flex: 1 1 160px; }
    label { font-size: 0.75rem; color: var(--muted); }
    input[type="text"], input[type="number"], input[type="password"], select, textarea {
      width: 100%;
      background: var(--surface-alt);
      border: 1px solid var(--border-strong);
      border-radius: 6px;
      color: var(--text);
      padding: 0.45rem 0.65rem;
      font-size: 0.8125rem;
      font-family: var(--sans);
    }
    .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
    .feed-list { display: grid; gap: 0.6rem; max-height: 520px; overflow-y: auto; }
    .feed-card {
      background: var(--surface-alt);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.65rem 0.8rem;
      display: grid;
      gap: 0.35rem;
    }
    .feed-top { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    .feed-summary { font-size: 0.875rem; font-weight: 500; word-break: break-word; }
    .feed-meta { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; font-size: 0.75rem; color: var(--muted); flex-wrap: wrap; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
    th { text-align: left; color: var(--muted); font-weight: 500; font-size: 0.75rem; padding: 0.5rem 0.4rem; border-bottom: 1px solid var(--border); }
    td { padding: 0.55rem 0.4rem; border-bottom: 1px solid var(--border); vertical-align: top; }
    .table-wrap { overflow-x: auto; }
    .stack { display: grid; gap: 1rem; }
    .actions-cell { display: flex; gap: 0.35rem; flex-wrap: wrap; }
    .empty { color: var(--muted); font-size: 0.85rem; padding: 1.2rem 0; text-align: center; }
    .toast-bar { min-height: 1.25rem; font-size: 0.8125rem; color: var(--accent); }
    .toast-err { color: var(--coral); }
    dialog {
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius);
      padding: 1.15rem;
      max-width: 520px;
      width: calc(100% - 2rem);
    }
    dialog::backdrop { background: rgba(0, 0, 0, 0.7); }
    .check-grid { display: flex; flex-wrap: wrap; gap: 0.65rem; }
    .check-label { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.8125rem; color: var(--text); }
    @media (prefers-reduced-motion: reduce) {
      .btn { transition: none; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3" y="4" width="18" height="3.5" rx="1.5" fill="#14f195"/>
        <rect x="3" y="10.25" width="18" height="3.5" rx="1.5" fill="#14f195" fill-opacity="0.72"/>
        <rect x="3" y="16.5" width="12" height="3.5" rx="1.5" fill="#14f195" fill-opacity="0.45"/>
      </svg>
      <span>solwatch</span>
      <div class="brand-meta">
        <span class="pill">${options.cluster}</span>
        <span id="sse-badge" class="pill pill-warn">Connecting</span>
        <span id="channels-badge" class="pill">channels: --</span>
      </div>
    </div>
    <div class="top-actions">
      <div id="status-toast" class="toast-bar" role="status" aria-live="polite"></div>
      <a href="/docs" class="btn btn-sm">API Docs</a>
      <button id="auth-btn" type="button" class="btn btn-sm">API Token</button>
    </div>
  </header>

  <main>
    <section aria-label="Service telemetry" class="kpi-strip">
      <div class="kpi"><span class="kpi-label">Watched Wallets</span><div id="kpi-wallets" class="kpi-value">--</div></div>
      <div class="kpi"><span class="kpi-label">Processed</span><div id="kpi-processed" class="kpi-value">--</div></div>
      <div class="kpi"><span class="kpi-label">Dispatched</span><div id="kpi-dispatched" class="kpi-value">--</div></div>
      <div class="kpi"><span class="kpi-label">Filtered</span><div id="kpi-filtered" class="kpi-value">--</div></div>
      <div class="kpi"><span class="kpi-label">Deduped</span><div id="kpi-deduped" class="kpi-value">--</div></div>
      <div class="kpi"><span class="kpi-label">Outbox / Failed</span><div id="kpi-outbox" class="kpi-value">--</div></div>
    </section>

    <div class="workspace">
      <section class="panel" aria-labelledby="feed-heading">
        <div class="panel-head">
          <h1 id="feed-heading" class="panel-title">Live Activity Stream</h1>
          <span class="pill mono" id="uptime-pill">uptime: --</span>
        </div>
        <div class="panel-body">
          <div id="feed-list" class="feed-list">
            <div class="empty">Waiting for live transactions or replay events...</div>
          </div>
        </div>
      </section>

      <div class="stack">
        <section class="panel" aria-labelledby="wallets-heading">
          <div class="panel-head">
            <h2 id="wallets-heading" class="panel-title">Watched Wallets</h2>
          </div>
          <div class="panel-body">
            <form id="add-wallet-form" class="form-row">
              <div class="field">
                <label for="wallet-address">Solana Address</label>
                <input id="wallet-address" type="text" required placeholder="Base58 public key" autocomplete="off">
              </div>
              <div class="field" style="max-width:190px">
                <label for="wallet-label">Label</label>
                <input id="wallet-label" type="text" maxlength="80" placeholder="Optional label" autocomplete="off">
              </div>
              <button type="submit" class="btn btn-primary">Add Wallet</button>
            </form>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr><th>Wallet</th><th>State</th><th>Last Slot</th><th>Actions</th></tr>
                </thead>
                <tbody id="wallets-tbody">
                  <tr><td colspan="4" class="empty">Loading wallets...</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section class="panel" aria-labelledby="rules-heading">
          <div class="panel-head">
            <h2 id="rules-heading" class="panel-title">Alert Rules</h2>
            <button id="new-rule-btn" type="button" class="btn btn-sm">New Rule</button>
          </div>
          <div class="panel-body table-wrap">
            <table>
              <thead>
                <tr><th>Rule</th><th>Scope</th><th>Thresholds</th><th>Cooldown / State</th><th>Actions</th></tr>
              </thead>
              <tbody id="rules-tbody">
                <tr><td colspan="5" class="empty">Loading rules...</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>

    <section class="panel" aria-labelledby="deliveries-heading">
      <div class="panel-head">
        <h2 id="deliveries-heading" class="panel-title">Delivery Audit Log</h2>
        <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
          <label for="filter-status" style="position:absolute;left:-9999px">Status filter</label>
          <select id="filter-status" style="width:auto">
            <option value="">All statuses</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
          </select>
          <label for="filter-channel" style="position:absolute;left:-9999px">Channel filter</label>
          <select id="filter-channel" style="width:auto">
            <option value="">All channels</option>
            <option value="console">console</option>
            <option value="telegram">telegram</option>
            <option value="discord">discord</option>
            <option value="webhook">webhook</option>
          </select>
          <button id="refresh-alerts-btn" type="button" class="btn btn-sm">Refresh</button>
          <button id="test-alert-btn" type="button" class="btn btn-primary btn-sm">Send Test Alert</button>
        </div>
      </div>
      <div class="panel-body">
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Time</th><th>Wallet</th><th>Channel</th><th>Summary</th><th>Status</th></tr>
            </thead>
            <tbody id="alerts-tbody">
              <tr><td colspan="5" class="empty">Loading deliveries...</td></tr>
            </tbody>
          </table>
        </div>
        <div style="margin-top:0.75rem;display:flex;justify-content:flex-end">
          <button id="load-older-btn" type="button" class="btn btn-sm" hidden>Load older</button>
        </div>
      </div>
    </section>
  </main>

  <dialog id="auth-dialog" aria-labelledby="auth-dialog-title">
    <h2 id="auth-dialog-title" class="panel-title" style="margin-bottom:0.5rem">API Bearer Token</h2>
    <p style="font-size:0.8125rem;color:var(--muted);margin-top:0">Stored only in browser sessionStorage and sent via Authorization header.</p>
    <form id="auth-form" class="stack">
      <div class="field">
        <label for="token-input">API_TOKEN</label>
        <input id="token-input" type="password" autocomplete="off" placeholder="Paste bearer token">
      </div>
      <div style="display:flex;justify-content:flex-end;gap:0.5rem">
        <button id="auth-cancel-btn" type="button" class="btn">Cancel</button>
        <button type="submit" class="btn btn-primary">Save Token</button>
      </div>
    </form>
  </dialog>

  <dialog id="rule-dialog" aria-labelledby="rule-dialog-title">
    <h2 id="rule-dialog-title" class="panel-title" style="margin-bottom:0.65rem">Configure Alert Rule</h2>
    <form id="rule-form" class="stack">
      <div class="form-row" style="margin-bottom:0">
        <div class="field">
          <label for="rule-id-input">Rule ID</label>
          <input id="rule-id-input" type="text" required placeholder="global-default">
        </div>
        <div class="field">
          <label for="rule-wallet-input">Wallet Scope (optional Base58)</label>
          <input id="rule-wallet-input" type="text" placeholder="Blank = all wallets">
        </div>
      </div>
      <div class="form-row" style="margin-bottom:0">
        <div class="field">
          <label for="rule-min-sol">Min SOL</label>
          <input id="rule-min-sol" type="text" required value="0.1">
        </div>
        <div class="field">
          <label for="rule-min-usd">Min USD (optional)</label>
          <input id="rule-min-usd" type="number" min="0" step="0.01" placeholder="e.g. 25">
        </div>
        <div class="field">
          <label for="rule-cooldown">Cooldown (sec)</label>
          <input id="rule-cooldown" type="number" min="0" max="86400" value="0">
        </div>
      </div>
      <div>
        <span style="display:block;font-size:0.75rem;color:var(--muted);margin-bottom:0.3rem">Event Types</span>
        <div class="check-grid">
          <label class="check-label"><input type="checkbox" name="evtype" value="sol_transfer" checked> sol_transfer</label>
          <label class="check-label"><input type="checkbox" name="evtype" value="spl_transfer" checked> spl_transfer</label>
          <label class="check-label"><input type="checkbox" name="evtype" value="dex_swap" checked> dex_swap</label>
          <label class="check-label"><input type="checkbox" name="evtype" value="program_interaction" checked> program_interaction</label>
        </div>
      </div>
      <div class="field">
        <label for="rule-allowlist">Mint Allowlist (comma-separated, optional)</label>
        <input id="rule-allowlist" type="text" placeholder="Leave blank for any mint">
      </div>
      <div class="field">
        <label for="rule-denylist">Mint Denylist (comma-separated, optional)</label>
        <input id="rule-denylist" type="text" placeholder="Blocked spam mints">
      </div>
      <div class="check-grid">
        <label class="check-label"><input id="rule-include-failed" type="checkbox"> Include failed transactions</label>
        <label class="check-label"><input id="rule-enabled" type="checkbox" checked> Enabled</label>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:0.5rem">
        <button id="rule-cancel-btn" type="button" class="btn">Cancel</button>
        <button type="submit" class="btn btn-primary">Save Rule</button>
      </div>
    </form>
  </dialog>

  <script nonce="${safeNonce}">
    (function () {
      var authRequired = ${authFlag};
      var TOKEN_KEY = "solwatch_api_token";
      var nextAlertsCursor = null;
      var streamController = null;
      var reconnectDelayMs = 2000;
      var feedItems = [];
      var rulesCache = [];

      function getToken() {
        try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch (_) { return ""; }
      }
      function setToken(val) {
        try {
          if (val) sessionStorage.setItem(TOKEN_KEY, val);
          else sessionStorage.removeItem(TOKEN_KEY);
        } catch (_) {}
      }
      function showToast(msg, isError) {
        var el = document.getElementById("status-toast");
        el.textContent = msg;
        el.className = isError ? "toast-bar toast-err" : "toast-bar";
      }
      function shortAddr(addr) {
        if (!addr || addr.length <= 12) return addr || "";
        return addr.slice(0, 4) + "..." + addr.slice(-5);
      }
      function solFromLamports(str) {
        try {
          var n = Number(str || "0") / 1e9;
          return n.toFixed(4).replace(/0+$/, "").replace(/\\.$/, "") || "0";
        } catch (_) { return "0"; }
      }
      function apiFetch(url, opts) {
        var options = opts || {};
        var headers = Object.assign({}, options.headers || {});
        var token = getToken();
        if (token) headers["Authorization"] = "Bearer " + token;
        if (options.body && !headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
        }
        return fetch(url, Object.assign({}, options, { headers: headers })).then(function (res) {
          if (res.status === 401) {
            document.getElementById("auth-dialog").showModal();
            throw new Error("Authentication required (401)");
          }
          return res.json().then(function (data) {
            if (!res.ok) throw new Error(data.message || ("HTTP " + res.status));
            return data;
          });
        });
      }

      function renderFeed() {
        var container = document.getElementById("feed-list");
        container.textContent = "";
        if (feedItems.length === 0) {
          var empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "Waiting for live transactions or replay events...";
          container.appendChild(empty);
          return;
        }
        feedItems.slice(0, 30).forEach(function (ev) {
          var card = document.createElement("article");
          card.className = "feed-card";
          var top = document.createElement("div");
          top.className = "feed-top";
          var badge = document.createElement("span");
          badge.className =
            ev.kind === "tx_dispatched"
              ? (ev.eventKind === "dex_swap" ? "pill pill-swap" : "pill pill-live")
              : (ev.kind === "tx_filtered" ? "pill pill-warn" : "pill");
          badge.textContent = ev.kind === "tx_dispatched" ? ev.eventKind.toUpperCase() : ev.kind.replace("tx_", "").toUpperCase();
          var ts = document.createElement("span");
          ts.className = "mono";
          ts.style.fontSize = "0.72rem";
          ts.style.color = "var(--muted)";
          ts.textContent = (ev.timestampIso || "").slice(11, 19) + " UTC";
          top.appendChild(badge);
          top.appendChild(ts);
          card.appendChild(top);

          var sum = document.createElement("div");
          sum.className = "feed-summary";
          sum.textContent = ev.summary || (ev.reason ? ("Filtered: " + ev.reason) : ev.signature);
          card.appendChild(sum);

          var meta = document.createElement("div");
          meta.className = "feed-meta";
          var walletText = document.createElement("span");
          walletText.className = "mono";
          walletText.textContent = (ev.walletLabel ? ev.walletLabel + " • " : "") + shortAddr(ev.wallet);
          meta.appendChild(walletText);

          var actions = document.createElement("div");
          actions.style.display = "flex";
          actions.style.gap = "0.45rem";
          actions.style.alignItems = "center";
          if (ev.explorerUrl) {
            var link = document.createElement("a");
            link.href = ev.explorerUrl;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = "Solscan";
            actions.appendChild(link);
          }
          if (ev.mint) {
            var denyBtn = document.createElement("button");
            denyBtn.type = "button";
            denyBtn.className = "btn btn-sm btn-danger";
            denyBtn.textContent = "Denylist Mint";
            denyBtn.addEventListener("click", function () {
              apiFetch("/api/rules/denylist", {
                method: "POST",
                body: JSON.stringify({ mint: ev.mint }),
              }).then(function () {
                showToast("Added " + shortAddr(ev.mint) + " to global denylist", false);
                loadRules();
              }).catch(function (err) {
                showToast(err.message, true);
              });
            });
            actions.appendChild(denyBtn);
          }
          meta.appendChild(actions);
          card.appendChild(meta);
          container.appendChild(card);
        });
      }

      function applyStatus(status) {
        if (!status) return;
        document.getElementById("kpi-wallets").textContent = String(status.watchedWallets ?? "--");
        document.getElementById("channels-badge").textContent = "channels: " + ((status.channels || []).join(", ") || "none");
        document.getElementById("uptime-pill").textContent = "uptime: " + String(status.uptimeSec ?? 0) + "s";
        var m = status.metrics || {};
        document.getElementById("kpi-processed").textContent = String(m.processedTotal ?? 0);
        document.getElementById("kpi-dispatched").textContent = String(m.dispatchedTotal ?? 0);
        document.getElementById("kpi-filtered").textContent = String(m.filteredTotal ?? 0);
        document.getElementById("kpi-deduped").textContent = String(m.dedupedTotal ?? 0);
        document.getElementById("kpi-outbox").textContent = String(m.outboxPendingCount ?? 0) + " / " + String(m.deliveryFailedTotal ?? 0);
      }

      function loadStatus() {
        return apiFetch("/api/status").then(applyStatus).catch(function () {});
      }

      function loadWallets() {
        return apiFetch("/api/wallets").then(function (data) {
          var tbody = document.getElementById("wallets-tbody");
          tbody.textContent = "";
          var list = data.wallets || [];
          if (list.length === 0) {
            var tr = document.createElement("tr");
            var td = document.createElement("td");
            td.colSpan = 4;
            td.className = "empty";
            td.textContent = "No watched wallets registered.";
            tr.appendChild(td);
            tbody.appendChild(tr);
            return;
          }
          list.forEach(function (w) {
            var tr = document.createElement("tr");
            var tdWallet = document.createElement("td");
            var title = document.createElement("div");
            title.textContent = w.label || "Unlabeled";
            title.style.fontWeight = "500";
            var addrEl = document.createElement("div");
            addrEl.className = "mono";
            addrEl.style.fontSize = "0.75rem";
            addrEl.style.color = "var(--muted)";
            addrEl.textContent = shortAddr(w.address);
            tdWallet.appendChild(title);
            tdWallet.appendChild(addrEl);

            var tdState = document.createElement("td");
            var st = document.createElement("span");
            st.className = w.enabled ? "pill pill-live" : "pill pill-warn";
            st.textContent = w.enabled ? "active" : "paused";
            tdState.appendChild(st);

            var tdSlot = document.createElement("td");
            tdSlot.className = "mono";
            tdSlot.textContent = w.lastSlot !== null && w.lastSlot !== undefined ? String(w.lastSlot) : "--";

            var tdAct = document.createElement("td");
            tdAct.className = "actions-cell";
            var toggleBtn = document.createElement("button");
            toggleBtn.type = "button";
            toggleBtn.className = "btn btn-sm";
            toggleBtn.textContent = w.enabled ? "Pause" : "Resume";
            toggleBtn.addEventListener("click", function () {
              apiFetch("/api/wallets/" + encodeURIComponent(w.address), {
                method: "PATCH",
                body: JSON.stringify({ enabled: !w.enabled }),
              }).then(function () {
                showToast((w.enabled ? "Paused " : "Resumed ") + shortAddr(w.address), false);
                loadAll();
              }).catch(function (err) { showToast(err.message, true); });
            });
            var delBtn = document.createElement("button");
            delBtn.type = "button";
            delBtn.className = "btn btn-sm btn-danger";
            delBtn.textContent = "Remove";
            delBtn.addEventListener("click", function () {
              apiFetch("/api/wallets/" + encodeURIComponent(w.address), { method: "DELETE" })
                .then(function () {
                  showToast("Removed " + shortAddr(w.address), false);
                  loadAll();
                }).catch(function (err) { showToast(err.message, true); });
            });
            tdAct.appendChild(toggleBtn);
            tdAct.appendChild(delBtn);

            tr.appendChild(tdWallet);
            tr.appendChild(tdState);
            tr.appendChild(tdSlot);
            tr.appendChild(tdAct);
            tbody.appendChild(tr);
          });
        }).catch(function () {});
      }

      function openRuleDialog(rule) {
        var dlg = document.getElementById("rule-dialog");
        document.getElementById("rule-id-input").value = rule ? rule.id : ("rule-" + Date.now());
        document.getElementById("rule-wallet-input").value = (rule && rule.walletAddress) ? rule.walletAddress : "";
        document.getElementById("rule-min-sol").value = rule ? solFromLamports(rule.minSolLamports) : "0.1";
        document.getElementById("rule-min-usd").value = (rule && rule.minUsd !== null && rule.minUsd !== undefined) ? String(rule.minUsd) : "";
        document.getElementById("rule-cooldown").value = rule ? String(rule.cooldownSeconds) : "0";
        document.getElementById("rule-allowlist").value = (rule && rule.mintAllowlist) ? rule.mintAllowlist.join(", ") : "";
        document.getElementById("rule-denylist").value = (rule && rule.mintDenylist) ? rule.mintDenylist.join(", ") : "";
        document.getElementById("rule-include-failed").checked = Boolean(rule && rule.includeFailed);
        document.getElementById("rule-enabled").checked = rule ? Boolean(rule.enabled) : true;
        var activeTypes = (rule && rule.eventTypes && rule.eventTypes.length > 0)
          ? rule.eventTypes
          : ["sol_transfer", "spl_transfer", "dex_swap", "program_interaction"];
        document.querySelectorAll('input[name="evtype"]').forEach(function (cb) {
          cb.checked = activeTypes.indexOf(cb.value) >= 0;
        });
        dlg.showModal();
      }

      function loadRules() {
        return apiFetch("/api/rules").then(function (data) {
          rulesCache = data.rules || [];
          var tbody = document.getElementById("rules-tbody");
          tbody.textContent = "";
          if (rulesCache.length === 0) {
            var tr = document.createElement("tr");
            var td = document.createElement("td");
            td.colSpan = 5;
            td.className = "empty";
            td.textContent = "No rules configured.";
            tr.appendChild(td);
            tbody.appendChild(tr);
            return;
          }
          rulesCache.forEach(function (r) {
            var tr = document.createElement("tr");
            var tdId = document.createElement("td");
            tdId.className = "mono";
            tdId.textContent = r.id;

            var tdScope = document.createElement("td");
            tdScope.className = "mono";
            tdScope.textContent = r.walletAddress ? shortAddr(r.walletAddress) : "global";

            var tdThresh = document.createElement("td");
            tdThresh.className = "mono";
            tdThresh.textContent = solFromLamports(r.minSolLamports) + " SOL" + (r.minUsd ? (" / $" + r.minUsd) : "");

            var tdMeta = document.createElement("td");
            tdMeta.textContent = r.cooldownSeconds + "s • deny:" + (r.mintDenylist || []).length + (r.enabled ? "" : " (off)");

            var tdAct = document.createElement("td");
            tdAct.className = "actions-cell";
            var editBtn = document.createElement("button");
            editBtn.type = "button";
            editBtn.className = "btn btn-sm";
            editBtn.textContent = "Edit";
            editBtn.addEventListener("click", function () { openRuleDialog(r); });
            var delBtn = document.createElement("button");
            delBtn.type = "button";
            delBtn.className = "btn btn-sm btn-danger";
            delBtn.textContent = "Delete";
            delBtn.addEventListener("click", function () {
              apiFetch("/api/rules/" + encodeURIComponent(r.id), { method: "DELETE" })
                .then(function () {
                  showToast("Deleted rule " + r.id, false);
                  loadRules();
                }).catch(function (err) { showToast(err.message, true); });
            });
            tdAct.appendChild(editBtn);
            tdAct.appendChild(delBtn);

            tr.appendChild(tdId);
            tr.appendChild(tdScope);
            tr.appendChild(tdThresh);
            tr.appendChild(tdMeta);
            tr.appendChild(tdAct);
            tbody.appendChild(tr);
          });
        }).catch(function () {});
      }

      function renderAlertsRows(alerts, append) {
        var tbody = document.getElementById("alerts-tbody");
        if (!append) tbody.textContent = "";
        if (!append && alerts.length === 0) {
          var tr = document.createElement("tr");
          var td = document.createElement("td");
          td.colSpan = 5;
          td.className = "empty";
          td.textContent = "No delivery records match this filter.";
          tr.appendChild(td);
          tbody.appendChild(tr);
          return;
        }
        alerts.forEach(function (a) {
          var tr = document.createElement("tr");
          var tdTime = document.createElement("td");
          tdTime.className = "mono";
          tdTime.textContent = (a.deliveredAt || "").slice(11, 19);

          var tdWallet = document.createElement("td");
          tdWallet.className = "mono";
          tdWallet.textContent = shortAddr(a.walletAddress);

          var tdCh = document.createElement("td");
          tdCh.textContent = a.channel;

          var tdSum = document.createElement("td");
          tdSum.textContent = a.summary + (a.errorMessage ? (" — " + a.errorMessage) : "");

          var tdStatus = document.createElement("td");
          var badge = document.createElement("span");
          badge.className = a.status === "sent" ? "pill pill-live" : "pill pill-err";
          badge.textContent = a.status;
          tdStatus.appendChild(badge);

          tr.appendChild(tdTime);
          tr.appendChild(tdWallet);
          tr.appendChild(tdCh);
          tr.appendChild(tdSum);
          tr.appendChild(tdStatus);
          tbody.appendChild(tr);
        });
      }

      function loadAlerts(beforeId) {
        var params = new URLSearchParams({ limit: "25" });
        var status = document.getElementById("filter-status").value;
        var channel = document.getElementById("filter-channel").value;
        if (status) params.set("status", status);
        if (channel) params.set("channel", channel);
        if (beforeId) params.set("beforeId", String(beforeId));

        return apiFetch("/api/alerts?" + params.toString()).then(function (data) {
          var rows = data.alerts || [];
          renderAlertsRows(rows, Boolean(beforeId));
          nextAlertsCursor = data.nextCursor || null;
          document.getElementById("load-older-btn").hidden = nextAlertsCursor === null;
        }).catch(function () {});
      }

      function handleSseBlock(rawBlock) {
        var eventName = "message";
        var dataLines = [];
        rawBlock.split("\\n").forEach(function (line) {
          if (line.indexOf("event:") === 0) eventName = line.slice(6).trim();
          else if (line.indexOf("data:") === 0) dataLines.push(line.slice(5).trim());
        });
        if (dataLines.length === 0) return;
        var payload = JSON.parse(dataLines.join("\\n"));
        if (eventName === "snapshot") {
          feedItems = Array.isArray(payload.recentEvents) ? payload.recentEvents : [];
          renderFeed();
          applyStatus(payload.status);
        } else if (eventName === "activity") {
          if (payload.kind === "tx_dispatched" || payload.kind === "tx_filtered" || payload.kind === "tx_deduped") {
            feedItems.unshift(payload);
            if (feedItems.length > 50) feedItems.length = 50;
            renderFeed();
          }
          if (payload.kind === "wallet_updated") loadWallets();
          if (payload.kind === "rule_updated") loadRules();
          if (payload.kind === "tx_dispatched") loadAlerts();
          loadStatus();
        }
      }

      function connectSse() {
        if (streamController) streamController.abort();
        streamController = new AbortController();
        var badge = document.getElementById("sse-badge");
        badge.className = "pill pill-warn";
        badge.textContent = "Connecting";
        var headers = {};
        var token = getToken();
        if (token) headers["Authorization"] = "Bearer " + token;

        fetch("/api/events/stream", { headers: headers, signal: streamController.signal })
          .then(function (res) {
            if (res.status === 401) {
              badge.className = "pill pill-err";
              badge.textContent = "Auth required";
              return;
            }
            if (!res.ok || !res.body) throw new Error("SSE HTTP " + res.status);
            badge.className = "pill pill-live";
            badge.textContent = "Live SSE";
            reconnectDelayMs = 2000;
            var reader = res.body.getReader();
            var decoder = new TextDecoder();
            var buffer = "";
            function pump() {
              return reader.read().then(function (chunk) {
                if (chunk.done) throw new Error("Stream closed");
                buffer += decoder.decode(chunk.value, { stream: true });
                var sepIdx;
                while ((sepIdx = buffer.indexOf("\\n\\n")) >= 0) {
                  var rawEvent = buffer.slice(0, sepIdx);
                  buffer = buffer.slice(sepIdx + 2);
                  if (rawEvent.trim() && rawEvent.indexOf(":") !== 0) {
                    handleSseBlock(rawEvent);
                  }
                }
                return pump();
              });
            }
            return pump();
          })
          .catch(function (err) {
            if (err && err.name === "AbortError") return;
            badge.className = "pill pill-err";
            badge.textContent = "Reconnecting";
            setTimeout(connectSse, reconnectDelayMs);
            reconnectDelayMs = Math.min(15000, reconnectDelayMs * 2);
          });
      }

      function loadAll() {
        loadStatus();
        loadWallets();
        loadRules();
        loadAlerts();
      }

      document.getElementById("add-wallet-form").addEventListener("submit", function (e) {
        e.preventDefault();
        var address = document.getElementById("wallet-address").value.trim();
        var label = document.getElementById("wallet-label").value.trim();
        apiFetch("/api/wallets", {
          method: "POST",
          body: JSON.stringify(label ? { address: address, label: label } : { address: address }),
        }).then(function () {
          document.getElementById("add-wallet-form").reset();
          showToast("Added " + shortAddr(address), false);
          loadAll();
        }).catch(function (err) { showToast(err.message, true); });
      });

      document.getElementById("new-rule-btn").addEventListener("click", function () { openRuleDialog(null); });
      document.getElementById("rule-cancel-btn").addEventListener("click", function () {
        document.getElementById("rule-dialog").close();
      });
      document.getElementById("rule-form").addEventListener("submit", function (e) {
        e.preventDefault();
        var id = document.getElementById("rule-id-input").value.trim();
        var walletAddr = document.getElementById("rule-wallet-input").value.trim();
        var minSol = document.getElementById("rule-min-sol").value.trim();
        var minUsdRaw = document.getElementById("rule-min-usd").value.trim();
        var cooldownSeconds = Number(document.getElementById("rule-cooldown").value || "0");
        var allowRaw = document.getElementById("rule-allowlist").value.trim();
        var denyRaw = document.getElementById("rule-denylist").value.trim();
        var eventTypes = [];
        document.querySelectorAll('input[name="evtype"]:checked').forEach(function (cb) {
          eventTypes.push(cb.value);
        });
        var payload = {
          id: id,
          walletAddress: walletAddr ? walletAddr : null,
          minSol: minSol,
          minUsd: minUsdRaw ? Number(minUsdRaw) : null,
          eventTypes: eventTypes,
          mintAllowlist: allowRaw ? allowRaw.split(",").map(function (s) { return s.trim(); }).filter(Boolean) : [],
          mintDenylist: denyRaw ? denyRaw.split(",").map(function (s) { return s.trim(); }).filter(Boolean) : [],
          includeFailed: document.getElementById("rule-include-failed").checked,
          cooldownSeconds: cooldownSeconds,
          enabled: document.getElementById("rule-enabled").checked,
        };
        apiFetch("/api/rules/" + encodeURIComponent(id), {
          method: "PUT",
          body: JSON.stringify(payload),
        }).then(function () {
          document.getElementById("rule-dialog").close();
          showToast("Saved rule " + id, false);
          loadRules();
        }).catch(function (err) { showToast(err.message, true); });
      });

      document.getElementById("filter-status").addEventListener("change", function () { loadAlerts(); });
      document.getElementById("filter-channel").addEventListener("change", function () { loadAlerts(); });
      document.getElementById("refresh-alerts-btn").addEventListener("click", function () { loadAlerts(); });
      document.getElementById("load-older-btn").addEventListener("click", function () {
        if (nextAlertsCursor) loadAlerts(nextAlertsCursor);
      });
      document.getElementById("test-alert-btn").addEventListener("click", function () {
        apiFetch("/api/alerts/test", { method: "POST", body: "{}" }).then(function (res) {
          showToast("Dispatched test alert (" + (res.results || []).length + " channel(s))", false);
          loadAlerts();
          loadStatus();
        }).catch(function (err) { showToast(err.message, true); });
      });

      document.getElementById("auth-btn").addEventListener("click", function () {
        document.getElementById("token-input").value = getToken();
        document.getElementById("auth-dialog").showModal();
      });
      document.getElementById("auth-cancel-btn").addEventListener("click", function () {
        document.getElementById("auth-dialog").close();
      });
      document.getElementById("auth-form").addEventListener("submit", function (e) {
        e.preventDefault();
        setToken(document.getElementById("token-input").value.trim());
        document.getElementById("auth-dialog").close();
        loadAll();
        connectSse();
      });

      if (authRequired && !getToken()) {
        showToast("Click API Token to authenticate console requests", false);
      }
      loadAll();
      connectSse();
    })();
  </script>
</body>
</html>`;
}
