# Solwatch Operational Runbook

This guide covers deployment, day-to-day operations, monitoring, backup procedures, and disaster recovery for `solwatch` in production environments.

---

## 1. System Requirements & Hardware Sizing

`solwatch` is engineered for extreme resource efficiency, utilizing Node 24 native `node:sqlite` and asynchronous event streaming.

| Workload Size           | Watched Wallets | Min CPU  | Min RAM | Disk Space | Recommended Deployment                    |
| :---------------------- | :-------------: | :------: | :-----: | :--------: | :---------------------------------------- |
| **Small / Personal**    |     1 – 25      | 0.5 vCPU | 512 MB  |  5 GB SSD  | Single Docker container or VPS ($4–$5/mo) |
| **Medium / Treasury**   |    25 – 100     |  1 vCPU  |  1 GB   | 15 GB SSD  | Docker Compose with local volume          |
| **Large / Whale Radar** |    100 – 500    |  2 vCPU  |  2 GB   | 50 GB SSD  | Dedicated VPS + Dedicated RPC Endpoint    |

---

## 2. Production Deployment (Docker Compose)

### 2.1 Initial Setup

1. Clone the repository and configure production environment variables:

   ```bash
   git clone https://github.com/oscarbol09/solwatch.git /opt/solwatch
   cd /opt/solwatch
   cp .env.example .env
   ```

2. Generate secure secrets (minimum 32 characters) for `API_TOKEN` and `WEBHOOK_SECRET`:

   ```bash
   # Generate 32+ char secrets using openssl
   openssl rand -hex 24
   ```

3. Ensure `./data` directory exists with correct non-root permissions (container runs as UID `10001:10001`):

   ```bash
   mkdir -p ./data
   chown -R 10001:10001 ./data
   chmod 700 ./data
   ```

4. Launch with Docker Compose:

   ```bash
   docker compose up -d --build
   ```

### 2.2 Verifying Deployment Health

Check system liveness, readiness, and metrics:

```bash
# 1. Liveness check (shallow process health)
curl http://127.0.0.1:3000/healthz
# Expected output: {"status":"ok"}

# 2. Readiness check (verifies SQLite WAL ping and watcher connectivity)
curl http://127.0.0.1:3000/readyz
# Expected output: {"status":"ready","database":"healthy","watcher":"healthy","watchedCount":1,"connectedCount":1}

# 3. Prometheus metrics
curl http://127.0.0.1:3000/metrics | grep solwatch_
```

---

## 3. Database Maintenance & Backups

`solwatch` uses SQLite in WAL (`Write-Ahead Logging`) mode. Never copy `solwatch.db` directly while the process is active without a hot backup command, as WAL journal buffers will be missing from raw file copies.

### 3.1 Hot Online Backup (`VACUUM INTO ?`)

`solwatch` provides an online backup utility that creates a hermetic, single-file snapshot without locking read/write transactions:

```bash
# Run backup inside Docker container:
docker compose exec solwatch node dist/scripts/backup.js ./data/backups/solwatch-$(date +%Y%m%d%H%M%S).db

# Or run directly on host:
npm run backup -- ./data/backups/solwatch-backup.db
```

### 3.2 Automated Daily Cron Backup

Add the following entry to your host crontab (`crontab -e`):

```cron
# Run an online SQLite backup daily at 02:00 UTC and retain 14 days of history
0 2 * * * cd /opt/solwatch && docker compose exec -T solwatch node dist/scripts/backup.js /app/data/backups/backup-$(date +\%F).db && find /opt/solwatch/data/backups -type f -name "*.db" -mtime +14 -delete
```

### 3.3 Disaster Recovery / Restoring from Snapshot

1. Stop the application:

   ```bash
   docker compose down
   ```

2. Replace the active database file with the target backup snapshot:

   ```bash
   # Remove active DB and WAL journals
   rm -f ./data/solwatch.db ./data/solwatch.db-wal ./data/solwatch.db-shm

   # Copy snapshot to active path
   cp ./data/backups/backup-2026-11-23.db ./data/solwatch.db
   chown 10001:10001 ./data/solwatch.db
   chmod 600 ./data/solwatch.db
   ```

3. Restart the service:

   ```bash
   docker compose up -d
   ```

4. Verify integrity in logs:

   ```bash
   docker compose logs -f solwatch
   ```

---

## 4. Monitoring & Alerting (Prometheus RED)

`solwatch` exposes Prometheus metrics at `GET /metrics`. Scrape configuration for `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: "solwatch"
    scrape_interval: 15s
    static_configs:
      - targets: ["127.0.0.1:3000"]
    metrics_path: "/metrics"
```

### Recommended Alerting Rules

- **Service Down:** `up{job="solwatch"} == 0` for > 1 minute.
- **WebSocket Disconnection:** `solwatch_watcher_connected_total == 0 and solwatch_watched_wallets_total > 0` for > 2 minutes.
- **Elevated Delivery Failures:** `rate(solwatch_delivery_total{status="failed"}[5m]) > 0.05`.
- **Outbox Backlog:** `solwatch_outbox_pending_count > 50` for > 5 minutes.
- **Queue Dropped Items:** `increase(solwatch_queue_dropped_total[5m]) > 0`.

---

## 5. Troubleshooting & Diagnostics

### Problem: WebSocket Connection Closes Frequently

- **Cause:** Public Solana RPC endpoints (`api.mainnet-beta.solana.com`) aggressively terminate idle WebSocket connections.
- **Resolution:**
  - `solwatch` automatically catches up chronologically on reconnect using `getSignaturesForAddress`.
  - For zero dropped latency, point `SOLANA_WS_URL` to a dedicated RPC provider (e.g. Helius, QuickNode, Triton) or configure `POST /webhooks/helius`.

### Problem: HTTP API Returns 401 Unauthorized or 403 Forbidden

- **Cause:** `API_TOKEN` is unset or shorter than 32 characters when binding `HOST` to non-loopback addresses (`0.0.0.0`).
- **Resolution:** Set `API_TOKEN` to a cryptographically secure random string with at least 32 characters in `.env`.

### Problem: `SQLITE_BUSY` or Database Locked

- **Cause:** Concurrent processes attempting exclusive locks on the database file without `busy_timeout`.
- **Resolution:** `solwatch` configures `PRAGMA busy_timeout = 5000` and executes outbox updates within atomic transactions. Avoid running external `sqlite3` CLI processes with write transactions on the active database file while the service is running; use `npm run backup` instead.
