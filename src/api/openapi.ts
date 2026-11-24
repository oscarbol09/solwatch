import type { SolanaCluster } from "../domain/types.js";

export type OpenApiBuildOptions = {
  readonly cluster: SolanaCluster;
  readonly authRequired: boolean;
};

export function buildOpenApiSpec(options: OpenApiBuildOptions): Record<string, unknown> {
  const bearerSecurity = options.authRequired ? [{ bearerAuth: [] }] : [];

  return {
    openapi: "3.1.0",
    info: {
      title: "solwatch HTTP API",
      version: "0.2.0",
      description: `Real-time Solana wallet monitoring API and event stream (${options.cluster}).`,
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Set via API_TOKEN environment variable.",
        },
        heliusSecret: {
          type: "apiKey",
          in: "header",
          name: "Authorization",
          description: "Bearer or raw HELIUS_WEBHOOK_SECRET.",
        },
      },
      schemas: {
        ErrorResponse: {
          type: "object",
          required: ["error", "message"],
          properties: {
            error: { type: "string" },
            message: { type: "string" },
            details: { type: "object" },
          },
        },
        CreateWalletRequest: {
          type: "object",
          required: ["address"],
          properties: {
            address: { type: "string", description: "Solana Base58 wallet public key" },
            label: { type: "string", maxLength: 80 },
          },
        },
        UpdateWalletRequest: {
          type: "object",
          properties: {
            label: { type: ["string", "null"], maxLength: 80 },
            enabled: { type: "boolean" },
          },
        },
        UpsertRuleRequest: {
          type: "object",
          properties: {
            id: { type: "string" },
            walletAddress: { type: ["string", "null"] },
            minSol: { type: "string", default: "0.1" },
            minUsd: { type: ["number", "null"] },
            eventTypes: {
              type: "array",
              items: {
                type: "string",
                enum: ["sol_transfer", "spl_transfer", "dex_swap", "program_interaction"],
              },
            },
            mintAllowlist: { type: "array", items: { type: "string" } },
            mintDenylist: { type: "array", items: { type: "string" } },
            includeFailed: { type: "boolean" },
            cooldownSeconds: { type: "integer", minimum: 0, maximum: 86400 },
            enabled: { type: "boolean" },
          },
        },
      },
    },
    paths: {
      "/healthz": {
        get: {
          summary: "Minimal container liveness probe",
          responses: { "200": { description: "Service alive" } },
        },
      },
      "/readyz": {
        get: {
          summary: "Readiness probe verifying SQLite WAL and watcher connectivity",
          responses: {
            "200": { description: "Service ready to process transactions" },
            "503": { description: "Service not ready" },
          },
        },
      },
      "/metrics": {
        get: {
          summary: "Prometheus text format metrics (RED method, queue depths, delivery counts)",
          security: bearerSecurity,
          responses: {
            "200": {
              description: "Prometheus metrics in text/plain 0.0.4 format",
              content: { "text/plain": { schema: { type: "string" } } },
            },
          },
        },
      },
      "/api/status": {
        get: {
          summary: "Operational cluster, channel, and pipeline metrics",
          security: bearerSecurity,
          responses: { "200": { description: "Operational metrics payload" } },
        },
      },
      "/api/wallets": {
        get: {
          summary: "List tracked wallets and cursors",
          security: bearerSecurity,
          responses: { "200": { description: "Tracked wallet list" } },
        },
        post: {
          summary: "Add a Solana wallet to live tracking",
          security: bearerSecurity,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateWalletRequest" },
              },
            },
          },
          responses: { "201": { description: "Wallet created" } },
        },
      },
      "/api/wallets/{address}": {
        get: {
          summary: "Get wallet details and scoped alert rules",
          security: bearerSecurity,
          parameters: [{ name: "address", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Wallet and rules" } },
        },
        patch: {
          summary: "Update wallet label or pause/resume tracking",
          security: bearerSecurity,
          parameters: [{ name: "address", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UpdateWalletRequest" },
              },
            },
          },
          responses: { "200": { description: "Updated wallet" } },
        },
        delete: {
          summary: "Stop tracking and remove a wallet",
          security: bearerSecurity,
          parameters: [{ name: "address", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Deleted wallet" } },
        },
      },
      "/api/rules": {
        get: {
          summary: "List configured alert rules",
          security: bearerSecurity,
          parameters: [{ name: "wallet", in: "query", schema: { type: "string" } }],
          responses: { "200": { description: "Rules list" } },
        },
        post: {
          summary: "Create or replace an alert rule",
          security: bearerSecurity,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UpsertRuleRequest" },
              },
            },
          },
          responses: { "201": { description: "Rule saved" } },
        },
      },
      "/api/rules/{id}": {
        put: {
          summary: "Upsert rule by ID",
          security: bearerSecurity,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Rule updated" } },
        },
        patch: {
          summary: "Partially update an existing rule",
          security: bearerSecurity,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Rule patched" } },
        },
        delete: {
          summary: "Delete a rule by ID",
          security: bearerSecurity,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Rule deleted" } },
        },
      },
      "/api/rules/denylist": {
        post: {
          summary: "Append a mint to the global denylist",
          security: bearerSecurity,
          responses: { "200": { description: "Updated global rule" } },
        },
      },
      "/api/alerts": {
        get: {
          summary: "Paginated alert delivery audit log",
          security: bearerSecurity,
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } },
            { name: "wallet", in: "query", schema: { type: "string" } },
            { name: "beforeId", in: "query", schema: { type: "integer", minimum: 1 } },
            { name: "status", in: "query", schema: { type: "string", enum: ["sent", "failed"] } },
            { name: "channel", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Alert delivery records and nextCursor" } },
        },
      },
      "/api/alerts/test": {
        post: {
          summary: "Dispatch a synthetic test alert across configured notifiers",
          security: bearerSecurity,
          responses: { "200": { description: "Channel delivery results" } },
        },
      },
      "/api/events/stream": {
        get: {
          summary: "Real-time Server-Sent Events feed of detections and state changes",
          security: bearerSecurity,
          responses: { "200": { description: "text/event-stream feed" } },
        },
      },
      "/webhooks/helius": {
        post: {
          summary: "Ingest Helius Enhanced Webhook transaction batches",
          security: [{ heliusSecret: [] }],
          responses: { "202": { description: "Accepted for asynchronous processing" } },
        },
      },
    },
  };
}

export function renderApiDocsHtml(nonce: string, authRequired: boolean): string {
  const safeNonce = nonce.replace(/[^A-Za-z0-9+/=_-]/g, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>solwatch API Reference</title>
  <style nonce="${safeNonce}">
    :root {
      color-scheme: dark;
      --bg: #0b0d10;
      --surface: #12151a;
      --border: rgba(255, 255, 255, 0.08);
      --text: #f1f5f9;
      --muted: #94a3b8;
      --accent: #14f195;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --sans: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--sans); line-height: 1.5; }
    header { padding: 1rem 1.5rem; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--surface); }
    header a { color: var(--accent); text-decoration: none; font-size: 0.875rem; font-weight: 500; }
    main { max-width: 960px; margin: 0 auto; padding: 1.5rem; display: grid; gap: 1rem; }
    .endpoint { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.25rem; }
    .endpoint-head { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
    .method { font-family: var(--mono); font-size: 0.75rem; font-weight: 700; padding: 0.2rem 0.5rem; border-radius: 4px; background: rgba(20, 241, 149, 0.14); color: var(--accent); text-transform: uppercase; }
    .path { font-family: var(--mono); font-size: 0.95rem; font-weight: 600; }
    .summary { color: var(--muted); font-size: 0.875rem; margin: 0.4rem 0 0; }
    .params { margin-top: 0.5rem; font-family: var(--mono); font-size: 0.78rem; color: var(--muted); }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  </style>
</head>
<body>
  <header>
    <div><strong>solwatch</strong> <span style="color:var(--muted);font-size:0.875rem">OpenAPI 3.1 Reference${authRequired ? " (Bearer auth enabled)" : ""}</span></div>
    <nav style="display:flex;gap:1rem">
      <a href="/openapi.json">openapi.json</a>
      <a href="/">Console</a>
    </nav>
  </header>
  <main id="routes-root">
    <p style="color:var(--muted)">Loading OpenAPI schema...</p>
  </main>
  <script nonce="${safeNonce}">
    (function () {
      const root = document.getElementById("routes-root");
      fetch("/openapi.json")
        .then(function (res) { return res.json(); })
        .then(function (spec) {
          root.textContent = "";
          const paths = spec.paths || {};
          Object.keys(paths).forEach(function (pathKey) {
            const ops = paths[pathKey] || {};
            Object.keys(ops).forEach(function (method) {
              const op = ops[method];
              const card = document.createElement("article");
              card.className = "endpoint";
              const head = document.createElement("div");
              head.className = "endpoint-head";
              const badge = document.createElement("span");
              badge.className = "method";
              badge.textContent = method;
              const pathEl = document.createElement("span");
              pathEl.className = "path";
              pathEl.textContent = pathKey;
              head.appendChild(badge);
              head.appendChild(pathEl);
              card.appendChild(head);
              if (op && op.summary) {
                const p = document.createElement("p");
                p.className = "summary";
                p.textContent = op.summary;
                card.appendChild(p);
              }
              if (op && Array.isArray(op.parameters) && op.parameters.length > 0) {
                const paramsEl = document.createElement("div");
                paramsEl.className = "params";
                paramsEl.textContent = "Params: " + op.parameters.map(function (pr) { return pr.name + " (" + pr.in + ")"; }).join(", ");
                card.appendChild(paramsEl);
              }
              root.appendChild(card);
            });
          });
        })
        .catch(function (err) {
          root.textContent = "Failed to load /openapi.json: " + String(err);
        });
    })();
  </script>
</body>
</html>`;
}
