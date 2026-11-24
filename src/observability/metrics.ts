import type { ServiceMetrics } from "../service/monitorService.js";

const HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

export function normalizeHttpRoute(path: string): string {
  if (path === "/" || path === "") return "/";
  if (path === "/healthz") return "/healthz";
  if (path === "/readyz") return "/readyz";
  if (path === "/metrics") return "/metrics";
  if (path === "/docs") return "/docs";
  if (path === "/openapi.json") return "/openapi.json";
  if (path === "/webhooks/helius") return "/webhooks/helius";
  if (path === "/api/status") return "/api/status";
  if (path === "/api/events/stream") return "/api/events/stream";
  if (path === "/api/wallets") return "/api/wallets";
  if (path.startsWith("/api/wallets/")) return "/api/wallets/:address";
  if (path === "/api/rules") return "/api/rules";
  if (path === "/api/rules/denylist") return "/api/rules/denylist";
  if (path.startsWith("/api/rules/")) return "/api/rules/:id";
  if (path === "/api/alerts") return "/api/alerts";
  if (path === "/api/alerts/test") return "/api/alerts/test";

  return "other";
}

export interface RenderPrometheusOptions {
  readonly serviceMetrics: ServiceMetrics;
  readonly watchedWallets: number;
  readonly uptimeSeconds: number;
  readonly version?: string | undefined;
}

export class MetricsCollector {
  private readonly httpRequestsTotal = new Map<string, number>();
  private readonly httpDurationSums = new Map<string, number>();
  private readonly httpDurationCounts = new Map<string, number>();
  private readonly httpDurationBuckets = new Map<string, Map<number, number>>();

  recordHttpRequest(
    method: string,
    rawPath: string,
    status: number,
    durationSeconds: number,
  ): void {
    const safeMethod = method.toUpperCase();
    const route = normalizeHttpRoute(rawPath);
    const reqKey = `${safeMethod}|${route}|${status}`;

    const currentCount = this.httpRequestsTotal.get(reqKey) ?? 0;
    this.httpRequestsTotal.set(reqKey, currentCount + 1);

    const durKey = `${safeMethod}|${route}`;
    const currentSum = this.httpDurationSums.get(durKey) ?? 0;
    this.httpDurationSums.set(durKey, currentSum + durationSeconds);

    const currentDurCount = this.httpDurationCounts.get(durKey) ?? 0;
    this.httpDurationCounts.set(durKey, currentDurCount + 1);

    let bucketMap = this.httpDurationBuckets.get(durKey);
    if (!bucketMap) {
      bucketMap = new Map<number, number>();
      this.httpDurationBuckets.set(durKey, bucketMap);
    }

    for (const le of HISTOGRAM_BUCKETS) {
      if (durationSeconds <= le) {
        const bCount = bucketMap.get(le) ?? 0;
        bucketMap.set(le, bCount + 1);
      }
    }
  }

  renderPrometheusText(options: RenderPrometheusOptions): string {
    const lines: string[] = [];

    // Build and runtime info
    const version = options.version ?? "0.1.0";
    lines.push(
      "# HELP solwatch_build_info Build and runtime environment information",
      "# TYPE solwatch_build_info gauge",
      `solwatch_build_info{version="${version}",node_version="${process.version}"} 1`,
      "",
    );

    // Core operational gauges
    lines.push(
      "# HELP solwatch_uptime_seconds Process uptime in seconds",
      "# TYPE solwatch_uptime_seconds gauge",
      `solwatch_uptime_seconds ${options.uptimeSeconds}`,
      "",
      "# HELP solwatch_watched_wallets_total Number of currently watched wallets",
      "# TYPE solwatch_watched_wallets_total gauge",
      `solwatch_watched_wallets_total ${options.watchedWallets}`,
      "",
    );

    // Service metrics
    const sm = options.serviceMetrics;
    lines.push(
      "# HELP solwatch_processed_signatures_total Total Solana signatures processed by the monitor service",
      "# TYPE solwatch_processed_signatures_total counter",
      `solwatch_processed_signatures_total ${sm.processedTotal}`,
      "",
      "# HELP solwatch_dispatched_alerts_total Total alerts dispatched to outbound channels",
      "# TYPE solwatch_dispatched_alerts_total counter",
      `solwatch_dispatched_alerts_total ${sm.dispatchedTotal}`,
      "",
      "# HELP solwatch_delivery_success_total Total outbound alert deliveries that succeeded",
      "# TYPE solwatch_delivery_success_total counter",
      `solwatch_delivery_success_total ${sm.deliverySucceededTotal}`,
      "",
      "# HELP solwatch_delivery_failed_total Total outbound alert deliveries that failed",
      "# TYPE solwatch_delivery_failed_total counter",
      `solwatch_delivery_failed_total ${sm.deliveryFailedTotal}`,
      "",
      "# HELP solwatch_deduped_signatures_total Total signatures ignored because they were previously processed",
      "# TYPE solwatch_deduped_signatures_total counter",
      `solwatch_deduped_signatures_total ${sm.dedupedTotal}`,
      "",
      "# HELP solwatch_filtered_events_total Total events filtered out by rules (min amount, denylist, event type)",
      "# TYPE solwatch_filtered_events_total counter",
      `solwatch_filtered_events_total ${sm.filteredTotal}`,
      "",
      "# HELP solwatch_not_found_signatures_total Total signatures not found on RPC and enqueued for indexing retry",
      "# TYPE solwatch_not_found_signatures_total counter",
      `solwatch_not_found_signatures_total ${sm.notFoundTotal}`,
      "",
      "# HELP solwatch_direct_queue_depth Current number of webhook events in the direct queue",
      "# TYPE solwatch_direct_queue_depth gauge",
      `solwatch_direct_queue_depth ${sm.directQueueDepth}`,
      "",
      "# HELP solwatch_direct_queue_dropped_total Total webhook events dropped due to queue saturation",
      "# TYPE solwatch_direct_queue_dropped_total counter",
      `solwatch_direct_queue_dropped_total ${sm.directQueueDroppedTotal}`,
      "",
      "# HELP solwatch_outbox_pending_count Current number of pending retry deliveries in the SQLite outbox",
      "# TYPE solwatch_outbox_pending_count gauge",
      `solwatch_outbox_pending_count ${sm.outboxPendingCount}`,
      "",
      "# HELP solwatch_pending_signatures_count Current number of unindexed signatures waiting for RPC retry",
      "# TYPE solwatch_pending_signatures_count gauge",
      `solwatch_pending_signatures_count ${sm.pendingSignaturesCount}`,
      "",
    );

    // RED HTTP request metrics
    lines.push(
      "# HELP solwatch_http_requests_total Total HTTP requests handled by the REST API",
      "# TYPE solwatch_http_requests_total counter",
    );
    if (this.httpRequestsTotal.size === 0) {
      lines.push('solwatch_http_requests_total{method="GET",route="/healthz",status="200"} 0');
    } else {
      for (const [key, count] of this.httpRequestsTotal.entries()) {
        const [method, route, status] = key.split("|");
        lines.push(
          `solwatch_http_requests_total{method="${method}",route="${route}",status="${status}"} ${count}`,
        );
      }
    }
    lines.push("");

    // RED HTTP request duration histogram
    lines.push(
      "# HELP solwatch_http_request_duration_seconds HTTP request latencies in seconds",
      "# TYPE solwatch_http_request_duration_seconds histogram",
    );
    if (this.httpDurationCounts.size === 0) {
      lines.push(
        'solwatch_http_request_duration_seconds_bucket{method="GET",route="/healthz",le="+Inf"} 0',
        'solwatch_http_request_duration_seconds_sum{method="GET",route="/healthz"} 0',
        'solwatch_http_request_duration_seconds_count{method="GET",route="/healthz"} 0',
      );
    } else {
      for (const [durKey, totalCount] of this.httpDurationCounts.entries()) {
        const [method, route] = durKey.split("|");
        const bucketMap = this.httpDurationBuckets.get(durKey);
        for (const le of HISTOGRAM_BUCKETS) {
          const count = bucketMap?.get(le) ?? 0;
          lines.push(
            `solwatch_http_request_duration_seconds_bucket{method="${method}",route="${route}",le="${le}"} ${count}`,
          );
        }
        lines.push(
          `solwatch_http_request_duration_seconds_bucket{method="${method}",route="${route}",le="+Inf"} ${totalCount}`,
        );
        const sum = this.httpDurationSums.get(durKey) ?? 0;
        lines.push(
          `solwatch_http_request_duration_seconds_sum{method="${method}",route="${route}"} ${sum.toFixed(6)}`,
          `solwatch_http_request_duration_seconds_count{method="${method}",route="${route}"} ${totalCount}`,
        );
      }
    }
    lines.push("");

    return lines.join("\n");
  }

  resetForTesting(): void {
    this.httpRequestsTotal.clear();
    this.httpDurationSums.clear();
    this.httpDurationCounts.clear();
    this.httpDurationBuckets.clear();
  }
}
