/**
 * Metrics without an agent.
 *
 * CloudWatch reads structured log lines in Embedded Metric Format directly, so
 * emitting one JSON line per request gives real metrics with no sidecar, no
 * StatsD, and nothing extra to run or patch. The same line is also the log
 * entry, so a spike on a graph and the requests that caused it are the same
 * records rather than two systems you have to correlate by eye.
 */
const NAMESPACE = process.env.METRICS_NAMESPACE ?? 'ZenovateBooks';

export interface RequestMetric {
  route: string;
  method: string;
  status: number;
  durationMs: number;
  dbMs?: number;
  userId?: string | null;
  businessId?: string | null;
  requestId?: string;
  err?: string;
}

// Kept in memory so the in-app status page can answer without querying
// CloudWatch, which would need AWS credentials in the browser's request path.
const WINDOW_MS = 15 * 60 * 1000;
const recent: { at: number; status: number; durationMs: number; route: string }[] = [];
let started = Date.now();

export function record(m: RequestMetric): void {
  const now = Date.now();
  recent.push({ at: now, status: m.status, durationMs: m.durationMs, route: m.route });
  while (recent.length && now - recent[0]!.at > WINDOW_MS) recent.shift();
}

export function emit(m: RequestMetric, log: (line: string) => void): void {
  record(m);
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: NAMESPACE,
          Dimensions: [['Route'], ['Route', 'Method']],
          Metrics: [
            { Name: 'RequestCount', Unit: 'Count' },
            { Name: 'Latency', Unit: 'Milliseconds' },
            { Name: 'Errors', Unit: 'Count' },
            { Name: 'DbLatency', Unit: 'Milliseconds' },
          ],
        },
      ],
    },
    Route: m.route,
    Method: m.method,
    RequestCount: 1,
    Latency: m.durationMs,
    DbLatency: m.dbMs ?? 0,
    Errors: m.status >= 500 ? 1 : 0,
    status: m.status,
    requestId: m.requestId,
    // Ids, never names or amounts. A log line should be enough to trace a
    // request and never enough to reconstruct someone's books.
    userId: m.userId ?? undefined,
    businessId: m.businessId ?? undefined,
    err: m.err,
  };
  log(JSON.stringify(emf));
}

export function snapshot() {
  const now = Date.now();
  const win = recent.filter((r) => now - r.at <= WINDOW_MS);
  const total = win.length;
  const errors = win.filter((r) => r.status >= 500).length;
  const clientErrors = win.filter((r) => r.status >= 400 && r.status < 500).length;
  const sorted = win.map((r) => r.durationMs).sort((a, b) => a - b);
  const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0);
  const slowest = [...win].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)
    .map((r) => ({ route: r.route, durationMs: Math.round(r.durationMs) }));
  return {
    windowMinutes: WINDOW_MS / 60000,
    uptimeSeconds: Math.round((now - started) / 1000),
    requests: total,
    errors,
    clientErrors,
    errorRate: total ? Number((errors / total).toFixed(4)) : 0,
    p50Ms: Math.round(pct(50)),
    p95Ms: Math.round(pct(95)),
    p99Ms: Math.round(pct(99)),
    slowest,
  };
}

export function resetForTests(): void {
  recent.length = 0;
  started = Date.now();
}
