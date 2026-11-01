// k6 spike test for POST /v1/songs. Run against MOCK provider only (never the real one).
//   k6 run -e BASE_URL=https://api.example.com -e PEAK_RPS=100 -e LOADTEST_TOKEN=... loadtest/spike.js
// 5,000 users in a minute ~= 83 req/s. 1 lakh in a minute ~= 1,667 req/s.
import http from "k6/http";
import { check } from "k6";
import { SharedArray } from "k6/data";
import { Counter } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:8080";
const PEAK = Number(__ENV.PEAK_RPS || 100);
const HOLD = __ENV.HOLD || "60s";
const TOKEN = __ENV.LOADTEST_TOKEN || "";
const names = new SharedArray("names", () => JSON.parse(open("./names.json")));
const instant = new Counter("songs_ready_instantly");
const queued = new Counter("songs_queued");

export const options = {
  scenarios: {
    spike: {
      executor: "ramping-arrival-rate",
      startRate: Math.max(1, Math.floor(PEAK / 10)),
      timeUnit: "1s",
      preAllocatedVUs: Math.min(2000, PEAK * 2),
      maxVUs: Math.min(5000, PEAK * 5),
      stages: [
        { target: PEAK, duration: "10s" },
        { target: PEAK, duration: HOLD },
        { target: 0, duration: "5s" },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.001"],
    "http_req_duration{endpoint:create}": ["p(95)<200"],
  },
};

// Skewed like real names: a few are very common, most are rare.
const pickName = () =>
  names[Math.floor(Math.pow(Math.random(), 3) * names.length)];

export default function () {
  const res = http.post(
    `${BASE}/v1/songs`,
    JSON.stringify({ name: pickName(), lang: "hi" }),
    {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `${__VU}-${__ITER}`,
        "X-Loadtest-Token": TOKEN,
      },
      tags: { endpoint: "create" },
    },
  );
  check(res, { accepted: (r) => r.status === 200 || r.status === 202 });
  if (res.status === 200) instant.add(1);
  else if (res.status === 202) queued.add(1);
}
