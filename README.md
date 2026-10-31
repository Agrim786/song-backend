# Name Song Backend

Say your name, pick a language, get a song with your name sung in it.
Built to stay fast when 5,000 or 1 lakh people tap "generate" at once.

## The core idea

The singing provider is the bottleneck, not our code. Measured on ElevenLabs Creator:

| Measured | Value |
|---|---|
| Parallel generations allowed | **2** (3rd gets `429`) |
| Time per name (clip mode) | ~3.5–5 s |
| Throughput | ~0.57 names/s |
| Cost per new name (clip mode) | 165 credits ≈ $0.03 |

So the system never lets users talk to the provider directly. It:

1. **Generates each name once** in each template. Song id = hash(template, version, language, name), so caching and dedupe are automatic.
2. **Joins duplicates.** 400 people named Rahul at the same moment create one job (atomic Redis create-or-join + BullMQ `jobId`).
3. **Queues behind the provider limit.** BullMQ global concurrency = provider limit, enforced across all worker processes. A `429` pauses the queue instead of spending retries.
4. **Picks templates by load.** Calm: random template for variety. Busy: reuse a song that already exists for this name, else steer into a small spike set so dedupe keeps working.
5. **Never leaves anyone empty-handed.** If the ETA is long, the user instantly gets a preview: the template with their *own recorded name*, built with ffmpeg, no provider involved. The sung version replaces it when ready.
6. **Sends only the name to the provider (clip mode).** Template context + name sections only, stitched back on our CPU. Measured 165 vs 371 credits for the full song, no audible seams.

## Architecture

```
 Phone app
   │  POST /v1/names/transcribe  (audio)        → "Did we hear ध्रुव?"
   │  POST /v1/songs {name, lang, recordingId}  → 200 ready | 202 queued + ETA (+ previewId)
   │  GET  /v1/songs/:id, /v1/previews/:id      → poll until ready
   ▼
 ┌─────────────┐   create-or-join, picker, ETA   ┌──────────┐
 │ API (N×)    │ ──────────────────────────────▶ │  Redis   │  songs, pool, idempotency,
 │ stateless   │                                 │          │  rate limits, BullMQ queues
 └─────────────┘                                 └────┬─────┘
                                                      │
              ┌───────────────────────────────────────┴─────────────┐
              ▼                                                     ▼
   sing-worker (global concurrency = 2)                  preview-worker (CPU only)
   provider: ElevenLabs | mock                           template + user's own voice
   clip plan → stitch (ffmpeg) → storage                 (ffmpeg) → storage
              │                                                     │
              └──────────────► S3 / R2 + CDN (immutable songs) ◄────┘
```

| Part | How it scales | Limit |
|---|---|---|
| API | Add replicas behind a load balancer (stateless) | CPU per instance |
| Redis | Single node handles this load; managed Redis for HA | Memory |
| sing-worker | More processes only add resilience, global cap stays = provider limit | **Provider plan** (buy Enterprise concurrency, or self-host ACE-Step later) |
| preview-worker | Add machines (pure ffmpeg) | CPU |
| Files | S3/R2 behind CDN, songs cached forever (content-addressed) | none practical |

## Layout

Same pattern as Immich, Novu and Node.js Best Practices: modules by business domain,
entry / logic / data-access inside each, outside services behind interfaces,
several deployables sharing one codebase.

```
src/
  apps/                 deployables: api, sing-worker, preview-worker
  modules/              business domains
    songs/              songs.routes (HTTP) · songs.service (logic) · songs.repo (Redis create-or-join) · songs.schema · songs.ids · eta
    singing/            singing.processor (queue consumer) · plan (clip plan + splice math) · stitch (ffmpeg) · breaker
      providers/        provider (interface) · elevenlabs · mock
    previews/           previews.service · previews.processor · previews.repo · stitch (own-voice preview)
    names/              names.routes (transcribe) · normalize · blocklist · recordings.repo
      stt/              stt (interface) · sarvam · mock · stt.limiter
    templates/          catalog (validated library) · picker (load-aware)
  shared/               redis · queues · storage/ (local, s3) · metrics · logger · ffmpeg · errors · keys · shutdown
  http/                 express app, Redis-backed rate limits, error handling
  config/env.ts         every setting, validated at boot
scripts/import-template.ts   lab template -> catalog entry
loadtest/spike.js            k6 spike test (mock provider only)
test/                        splice math, name keys, picker
```

## Run it

Needs Node 20.6+, Redis 7, ffmpeg.

```bash
npm install
cp .env.example .env                      # mock provider by default, no keys needed
npm run import-template -- --from ../lab_v3 --id hi-birthday-01 --genre birthday --spike
redis-server &                            # or: docker compose up redis
npm run dev:api
npm run dev:sing
npm run dev:preview
```

Try it:

```bash
curl -X POST localhost:8080/v1/songs -H 'content-type: application/json' \
  -H 'idempotency-key: tap-1' -d '{"name":"ध्रुव","lang":"hi"}'
curl localhost:8080/v1/songs/<songId>
```

Real provider: set `SINGING_PROVIDER=elevenlabs`, `ELEVENLABS_API_KEY`, `PROVIDER_CONCURRENCY=2`.
Real speech-to-text: `STT_PROVIDER=sarvam`, `SARVAM_API_KEY`.

Docker (single VPS): `docker compose up --build`.

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/names/transcribe` | multipart `audio` + `lang`. Returns `{recordingId, name, needsTyping}`. STT has its own per-minute budget; over budget → `needsTyping: true` instead of an error. |
| POST | `/v1/songs` | `{name, lang, genre?, recordingId?}` + optional `Idempotency-Key`. `200` ready, `202` queued with `etaSeconds` and maybe `previewId`. |
| GET | `/v1/songs/:id` | status, url when ready |
| GET | `/v1/previews/:id` | own-voice preview status/url |
| GET | `/healthz`, `/readyz`, `/metrics` | liveness, readiness, Prometheus (keep `/metrics` private) |

Send `X-Device-Id: <uuid>` on every `/v1` call (a random id the app makes once at install). Rate limits are per device, because Indian carriers put thousands of users behind one IP; without the header the limit falls back to the IP. A high per-IP ceiling (`RATE_LIMIT_IP_PER_MIN`) stays as a backstop.

## Load testing (never against the real provider)

The mock provider copies measured ElevenLabs behaviour: ~3.5 s latency, hard limit of 2, `429` beyond, and real audio so stitching cost is real. Load tests hit our system only.

```bash
# on the server: SINGING_PROVIDER=mock, LOADTEST_TOKEN=<random>
k6 run -e BASE_URL=https://your-api -e PEAK_RPS=83 -e LOADTEST_TOKEN=<token> loadtest/spike.js     # 5,000 users/min
k6 run -e BASE_URL=https://your-api -e PEAK_RPS=1667 -e LOADTEST_TOKEN=<token> loadtest/spike.js   # 1 lakh users/min
```

Dev-box smoke run (1 API process, mock provider, 100 distinct names, ~120 req/s for 35 s):
4,199 requests, **0 failures, p95 41 ms**, 1,835 served instantly from the pool, 2,258 joined in-flight jobs, only 100 provider jobs, never more than 2 provider calls at once. Re-run on the real VPS for the numbers that count.

Scenarios worth running: provider outage (`MOCK_FAIL_RATE=1` for 2 min → circuit breaker opens, jobs wait, nothing crashes), duplicate taps (same `Idempotency-Key` → one job), worker killed mid-job (BullMQ re-delivers).

## Tests

`npm test`. Only where a silent wrong number would hurt: splice offsets (name in the wrong place), name keys (cache misses / wrong song), picker (spike behaviour).

## Before production

- Rotate every key that was ever pasted into a chat or screenshot.
- `STORAGE_DRIVER=s3` (R2) once there is more than one machine. Keep recordings private (separate bucket or no public access on `recordings/`) with a 1-day lifecycle rule.
- Redis: `maxmemory-policy noeviction` (BullMQ requirement), persistence on.
- Fill `config/blocklist.txt`. Add app attestation (Play Integrity / App Attest) before public launch; IP limits alone won't stop scripted abuse.
- Pre-render popular names in quiet hours so the pool is warm before a spike.

## Known limits

- With 1 lakh *unique* names, sung versions still take hours on a self-serve provider plan. Everyone gets something in seconds (cached song or own-voice preview), but provider throughput only grows by buying concurrency or self-hosting (ACE-Step repaint was tested and keeps the rest of the song bit-for-bit).
- Clip stitching uses fixed offsets with 40 ms crossfades; tested by ear as seamless, not yet measured at scale across many templates.
- Pool hit rate depends on real name distribution; the load-test name skew is an assumption.
