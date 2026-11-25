# Solwatch API & Webhook Reference

The `solwatch` HTTP service provides REST control endpoints, Server-Sent Events (SSE) streaming, health diagnostics, Prometheus metrics, and HMAC-signed webhook delivery.

---

## 1. Authentication & Security

All `/api/*` endpoints require Bearer Token authentication via the standard `Authorization` header:

```http
Authorization: Bearer <API_TOKEN>
```

- When `HOST` is bound beyond loopback (e.g. `0.0.0.0`), `API_TOKEN` must be at least **32 characters long**.
- Unauthenticated requests receive `401 Unauthorized` (`{"error": "Unauthorized"}`).
- The embedded console (`GET /`) and interactive documentation (`GET /docs`, `GET /openapi.json`) are accessible in browsers without authentication, prompting for the API token client-side.

---

## 2. System & Health Endpoints

### `GET /healthz`

Container and process liveness probe.

- **Auth:** None
- **Response (200 OK):**

  ```json
  {
    "status": "ok"
  }
  ```

### `GET /readyz`

Service readiness probe. Validates that the SQLite WAL storage engine is responsive (`ping()`) and the Solana WebSocket watcher is connected.

- **Auth:** None
- **Response (200 OK):**

  ```json
  {
    "status": "ready",
    "database": "healthy",
    "watcher": "healthy",
    "watchedCount": 3,
    "connectedCount": 3
  }
  ```
- **Error (503 Service Unavailable):** Returns 503 if the database is unreachable or all watcher connections have stalled.

### `GET /metrics`

Prometheus metrics export implementing the RED method.

- **Auth:** None
- **Content-Type:** `text/plain; version=0.0.4; charset=utf-8`

### `GET /api/status`

Operational status summary, cluster, active channels, and counters.

- **Auth:** Bearer Token
- **Response (200 OK):**

  ```json
  {
    "cluster": "mainnet-beta",
    "uptimeSec": 1420,
    "channels": ["telegram", "discord", "webhook"],
    "watcher": {
      "running": true,
      "watchedCount": 3,
      "connectedCount": 3,
      "queueDepth": 0,
      "reconnectsTotal": 1
    },
    "metrics": {
      "processedTotal": 125,
      "dispatchedTotal": 48,
      "filteredTotal": 72,
      "dedupedTotal": 5,
      "outboxPendingCount": 0
    }
  }
  ```

---

## 3. Wallets Management API

### `GET /api/wallets`

List all tracked wallets.

- **Auth:** Bearer Token
- **Response (200 OK):**

  ```json
  [
    {
      "address": "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      "label": "Main Treasury",
      "enabled": true,
      "lastSignature": "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
      "lastSlot": "312500110",
      "createdAt": "2026-11-23T10:00:00.000Z",
      "updatedAt": "2026-11-23T10:00:00.000Z"
    }
  ]
  ```

### `POST /api/wallets`

Register a new wallet address for real-time monitoring.

- **Auth:** Bearer Token
- **Request Body:**

  ```json
  {
    "address": "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    "label": "Main Treasury"
  }
  ```
- **Response (201 Created):** Returns the created wallet object.

### `PATCH /api/wallets/:address`

Update wallet label or pause/resume monitoring.

- **Auth:** Bearer Token
- **Request Body:**

  ```json
  {
    "label": "Cold Storage Vault",
    "enabled": false
  }
  ```
- **Response (200 OK):** Returns updated wallet.

### `DELETE /api/wallets/:address`

Remove wallet from watchlist and terminate its WebSocket subscription loop.

- **Auth:** Bearer Token
- **Response (200 OK):**

  ```json
  {
    "deleted": true
  }
  ```

---

## 4. Alert Rules Engine API

### `GET /api/rules`

List all active filtering rules.

- **Auth:** Bearer Token
- **Response (200 OK):**

  ```json
  [
    {
      "id": "global-default",
      "walletAddress": null,
      "minSolLamports": "100000000",
      "minUsd": 50,
      "eventTypes": ["sol_transfer", "spl_transfer", "dex_swap"],
      "mintAllowlist": [],
      "mintDenylist": ["4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"],
      "includeFailed": false,
      "cooldownSeconds": 30,
      "enabled": true
    }
  ]
  ```

### `POST /api/rules`

Create a new filtering rule.

- **Auth:** Bearer Token
- **Request Body:**

  ```json
  {
    "id": "whale-transfer-rule",
    "walletAddress": "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    "minSolLamports": "1000000000",
    "minUsd": 1000,
    "eventTypes": ["sol_transfer", "dex_swap"],
    "mintAllowlist": [],
    "mintDenylist": [],
    "includeFailed": false,
    "cooldownSeconds": 60,
    "enabled": true
  }
  ```

### `POST /api/rules/denylist`

Convenience endpoint to block a token mint across all rules.

- **Auth:** Bearer Token
- **Request Body:**

  ```json
  {
    "mint": "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"
  }
  ```

---

## 5. Server-Sent Events (SSE) Stream

### `GET /api/events/stream`

Establishes a real-time event stream push for live browser dashboards and terminal tailers.

- **Auth:** Bearer Token (or `?token=<API_TOKEN>` query parameter for EventSource compatibility)
- **Headers:** `Content-Type: text/event-stream`
- **Payload Format:**

  ```text
  event: alert
  data: {"deliveryId":"del_12345","summary":"Swap on Jupiter: 1.5 SOL -> 240 USDC ($240.00)","cluster":"mainnet-beta","timestamp":1760000000}
  ```

---

## 6. Webhooks Specification

### 6.1 Inbound: Helius Enhanced Webhook (`POST /webhooks/helius`)

Receives webhook payloads from Helius.

- **Header:** `Authorization: <HELIUS_WEBHOOK_SECRET>`
- **Response:** `202 Accepted` (`{"accepted": true, "events": 4}`)

### 6.2 Outbound: HMAC-SHA256 Signed Webhooks

When `WEBHOOK_URL` is configured, `solwatch` POSTs JSON payloads accompanied by tamper-proof cryptographic signatures:

#### Headers:

- `Content-Type: application/json`
- `X-Solwatch-Delivery: <delivery-uuid>`
- `X-Solwatch-Event: <sol_transfer | spl_transfer | dex_swap | program_interaction>`
- `X-Solwatch-Timestamp: <unix-epoch-seconds>`
- `X-Solwatch-Signature: sha256=<hex-digest>`

#### Signature Verification (Node.js Reference Implementation):

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySolwatchWebhook(params: {
  rawBody: string;
  signatureHeader: string;
  timestampHeader: string;
  deliveryIdHeader: string;
  eventHeader: string;
  secret: string;
  maxClockSkewSeconds?: number;
}): boolean {
  const {
    rawBody,
    signatureHeader,
    timestampHeader,
    deliveryIdHeader,
    eventHeader,
    secret,
    maxClockSkewSeconds = 300,
  } = params;

  // 1. Guard against non-numeric timestamps and replay attacks
  if (!/^\d{1,12}$/.test(timestampHeader)) return false;
  const now = Math.floor(Date.now() / 1000);
  const ts = Number.parseInt(timestampHeader, 10);
  if (Math.abs(now - ts) > maxClockSkewSeconds) return false;

  // 2. Recompute expected HMAC-SHA256 over canonical string:
  //    `${timestamp}.${deliveryId}.${eventKind}.${rawBody}`
  const canonicalPayload = `${timestampHeader}.${deliveryIdHeader}.${eventHeader}.${rawBody}`;
  const expectedSignature = `sha256=${createHmac("sha256", secret).update(canonicalPayload).digest("hex")}`;

  // 3. Constant-time comparison to prevent timing side-channel attacks
  const receivedBuffer = Buffer.from(signatureHeader);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (receivedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(receivedBuffer, expectedBuffer);
}
```
