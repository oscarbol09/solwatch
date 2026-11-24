import { describe, expect, it } from "vitest";
import { MetricsCollector, normalizeHttpRoute } from "../../src/observability/metrics.js";
import type { ServiceMetrics } from "../../src/service/monitorService.js";

describe("Observability & Prometheus Metrics", () => {
  describe("normalizeHttpRoute", () => {
    it("normalizes known system routes", () => {
      expect(normalizeHttpRoute("/")).toBe("/");
      expect(normalizeHttpRoute("")).toBe("/");
      expect(normalizeHttpRoute("/healthz")).toBe("/healthz");
      expect(normalizeHttpRoute("/readyz")).toBe("/readyz");
      expect(normalizeHttpRoute("/metrics")).toBe("/metrics");
      expect(normalizeHttpRoute("/docs")).toBe("/docs");
      expect(normalizeHttpRoute("/openapi.json")).toBe("/openapi.json");
      expect(normalizeHttpRoute("/webhooks/helius")).toBe("/webhooks/helius");
    });

    it("normalizes REST API endpoints and parameter patterns", () => {
      expect(normalizeHttpRoute("/api/status")).toBe("/api/status");
      expect(normalizeHttpRoute("/api/events/stream")).toBe("/api/events/stream");
      expect(normalizeHttpRoute("/api/wallets")).toBe("/api/wallets");
      expect(normalizeHttpRoute("/api/wallets/9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")).toBe(
        "/api/wallets/:address",
      );
      expect(normalizeHttpRoute("/api/rules")).toBe("/api/rules");
      expect(normalizeHttpRoute("/api/rules/denylist")).toBe("/api/rules/denylist");
      expect(normalizeHttpRoute("/api/rules/rule-abc-123")).toBe("/api/rules/:id");
      expect(normalizeHttpRoute("/api/alerts")).toBe("/api/alerts");
      expect(normalizeHttpRoute("/api/alerts/test")).toBe("/api/alerts/test");
    });

    it("maps unknown routes to bounded 'other' label", () => {
      expect(normalizeHttpRoute("/admin/debug")).toBe("other");
      expect(normalizeHttpRoute("/v1/random")).toBe("other");
    });
  });

  describe("MetricsCollector", () => {
    const dummyServiceMetrics: ServiceMetrics = {
      processedTotal: 100,
      dispatchedTotal: 40,
      deliverySucceededTotal: 35,
      deliveryFailedTotal: 5,
      dedupedTotal: 12,
      filteredTotal: 18,
      notFoundTotal: 2,
      directQueueDepth: 1,
      directQueueDroppedTotal: 0,
      outboxPendingCount: 3,
      pendingSignaturesCount: 2,
    };

    it("renders zero-state prometheus metrics cleanly", () => {
      const collector = new MetricsCollector();
      const output = collector.renderPrometheusText({
        serviceMetrics: dummyServiceMetrics,
        watchedWallets: 4,
        uptimeSeconds: 120,
        version: "0.1.0",
      });

      expect(output).toContain('solwatch_build_info{version="0.1.0"');
      expect(output).toContain("solwatch_uptime_seconds 120");
      expect(output).toContain("solwatch_watched_wallets_total 4");
      expect(output).toContain("solwatch_processed_signatures_total 100");
      expect(output).toContain("solwatch_dispatched_alerts_total 40");
      expect(output).toContain("solwatch_delivery_success_total 35");
      expect(output).toContain("solwatch_delivery_failed_total 5");
      expect(output).toContain("solwatch_deduped_signatures_total 12");
      expect(output).toContain("solwatch_filtered_events_total 18");
      expect(output).toContain("solwatch_not_found_signatures_total 2");
      expect(output).toContain("solwatch_direct_queue_depth 1");
      expect(output).toContain("solwatch_outbox_pending_count 3");
      expect(output).toContain(
        'solwatch_http_requests_total{method="GET",route="/healthz",status="200"} 0',
      );
      expect(output).toContain(
        'solwatch_http_request_duration_seconds_bucket{method="GET",route="/healthz",le="+Inf"} 0',
      );
    });

    it("records HTTP requests and duration histograms correctly", () => {
      const collector = new MetricsCollector();
      collector.recordHttpRequest("get", "/healthz", 200, 0.002);
      collector.recordHttpRequest("get", "/healthz", 200, 0.008);
      collector.recordHttpRequest("post", "/api/wallets", 201, 0.035);
      collector.recordHttpRequest(
        "get",
        "/api/wallets/9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
        404,
        0.001,
      );

      const output = collector.renderPrometheusText({
        serviceMetrics: dummyServiceMetrics,
        watchedWallets: 5,
        uptimeSeconds: 300,
      });

      expect(output).toContain(
        'solwatch_http_requests_total{method="GET",route="/healthz",status="200"} 2',
      );
      expect(output).toContain(
        'solwatch_http_requests_total{method="POST",route="/api/wallets",status="201"} 1',
      );
      expect(output).toContain(
        'solwatch_http_requests_total{method="GET",route="/api/wallets/:address",status="404"} 1',
      );

      // Duration histogram check
      expect(output).toContain(
        'solwatch_http_request_duration_seconds_bucket{method="GET",route="/healthz",le="0.005"} 1',
      );
      expect(output).toContain(
        'solwatch_http_request_duration_seconds_bucket{method="GET",route="/healthz",le="0.01"} 2',
      );
      expect(output).toContain(
        'solwatch_http_request_duration_seconds_count{method="GET",route="/healthz"} 2',
      );

      // Reset works
      collector.resetForTesting();
      const resetOutput = collector.renderPrometheusText({
        serviceMetrics: dummyServiceMetrics,
        watchedWallets: 0,
        uptimeSeconds: 0,
      });
      expect(resetOutput).toContain(
        'solwatch_http_requests_total{method="GET",route="/healthz",status="200"} 0',
      );
    });
  });
});
