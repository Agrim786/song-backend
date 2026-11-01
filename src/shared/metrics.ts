import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "API latency",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2],
  registers: [registry],
});

export const songRequests = new Counter({
  name: "song_requests_total",
  help: "Song requests by outcome (cache hit, joined in-flight job, newly queued)",
  labelNames: ["outcome", "pick"],
  registers: [registry],
});

export const songsRequeued = new Counter({
  name: "songs_requeued_total",
  help: "Songs whose job had vanished and was re-added (should stay near zero)",
  labelNames: ["reason"],
  registers: [registry],
});

export const providerCalls = new Counter({
  name: "provider_calls_total",
  help: "Singing provider calls by result",
  labelNames: ["provider", "result"],
  registers: [registry],
});

export const providerLatency = new Histogram({
  name: "provider_latency_seconds",
  help: "Singing provider latency",
  labelNames: ["provider"],
  buckets: [1, 2, 3, 4, 5, 7, 10, 20, 40],
  registers: [registry],
});

export const namesPerCall = new Histogram({
  name: "provider_names_per_call",
  help: "Names sung per provider call (1 when calm, up to 5 when busy)",
  buckets: [1, 2, 3, 4, 5],
  registers: [registry],
});

export const queueJobs = new Gauge({
  name: "queue_jobs",
  help: "Jobs per queue and state",
  labelNames: ["queue", "state"],
  registers: [registry],
});
