# CONTEXT.md — Name Song engineering notes

Background, lab measurements and gotchas behind the backend. The design itself is in DESIGN.md; setup is in README.md.

---

## 1. The brief

- Mobile app with **one screen**: the user **speaks their name**, **selects a language**, and gets **a song with their name sung in it**.
- **The twist:** the backend must stay fast and not fail when **5,000 or 1,00,000 users** submit at once.
- **No genre selector.** The user gives only a name and a language; the system picks the song.
- **Assumptions (not specified in the brief):** third-party AI providers are allowed (with a self-hosted path for later); the deliverable is a working app plus a design doc.

---

## 2. Core idea

The singing provider is the bottleneck, not our servers, so users never talk to it directly. A **library of song templates** is generated once. For each user only the **name spots** of a template are re-sung, via ElevenLabs Music inpainting in **clip mode**, and stitched back into the template on our CPU. Every song is **content-addressed** (hash of template, version, language and name), so a name is sung once per template and reused. A **queue capped at the provider's concurrency** protects the provider, **batching** fits up to 5 names into one call when there is a line, and a **load-aware picker** steers rushes onto a small spike set so identical names collapse into one job. The app plays the template intro the moment the user taps and swaps in the sung song at the name spot.

An own-voice preview (template plus the user's own recording) was built and dropped: it sounded pasted in and cost too much CPU at scale. See DESIGN.md, "What I tried and rejected".

---

## 3. Lab measurements

### ElevenLabs Music (Creator plan)

| Metric                               | Value                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Concurrent generations allowed       | **2** (3rd → `429 concurrent_limit_exceeded`, message states "maximum of 2 concurrent requests") |
| Time per name (full mode, 21 names)  | p50 3.89 s, p95 4.48 s, range 3.33–4.55 s, TTFB ~3.2 s (little streaming benefit)                |
| Cost, full mode (27 s song returned) | **371 credits ≈ $0.067**                                                                         |
| Cost, clip mode (~12 s returned)     | **165 credits ≈ $0.03**; billing is per second of audio returned (~13.7 credits/s)               |
| Clip-mode quality                    | No audible seams (tested by ear), names sung naturally to the melody                             |
| Pronunciation                        | Devanagari lyrics give Indian pronunciation; Roman spelling drifts → send native script          |

Batched clip-mode numbers (1 vs 5 names per call, throughput, 30-section limit) are in DESIGN.md, "Measured numbers".

### ACE-Step 1.5 (free ACE Music cloud API)

| Metric                 | Value                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| Repaint works          | Yes: name section re-sung (hook_vs_source 0.05–0.46)                                                          |
| Rest of song preserved | Nearly exactly (rest_vs_source 0.996), better than ElevenLabs                                                 |
| Speed                  | 10.6 s alone, queued up to 27 s; effectively 1 at a time                                                      |
| Overload               | HTTP 502 + retry-after 60 beyond ~2–3 parallel                                                                |
| Throughput             | ~0.1 names/s                                                                                                  |
| Verdict                | Free demo service, not production. Proves the open-source model works → **phase 2: self-host ACE-Step (MIT)** |

### Template findings

- **Leak finding:** kept sections are copied exactly into every song. The first template sang the placeholder ("Rahul") in kept sections too, so every song said "Rahul". Fix: a neutral placeholder word that fits the genre, an instrumental intro and outro, a verse that forbids ad-libs, and an automatic speech-to-text leak check with retry.
- 34 templates exist; 25 of the 27 newest passed the leak check on the first attempt.

### Self-hosting estimate (unverified, from ACE-Step's own claims: <2 s/song on A100, batch 8)

- Assuming ~0.25 GPU-s per name: 10,000 names ≈ 42 min on 1 GPU, ≈ 2 min on ~20 GPUs; 1 lakh in ~10 min ≈ 40 GPUs. Must be benchmarked before it is claimed.

---

## 4. Architecture

```
 Phone app
   │ POST /v1/names/transcribe (audio)  → "Did we hear स्नेहिल?"
   │ POST /v1/songs {name, lang}        → 200 ready | 202 queued + wait band + intro
   │ GET  /v1/songs/:id                 → poll (Retry-After hint)
   │ GET  /v1/languages, /files/...
   ▼
 Caddy (HTTPS) → API (stateless, N copies) ──── Redis (songs, waiting line, pool, idempotency, rate limits, BullMQ)
                                                  │
                                                  ▼
                                   sing-worker (global concurrency = 2)
                                   claim 1–5 names → ElevenLabs clip plan → stitch (ffmpeg) → storage
                                                  │
                                                  ▼
                                   storage (local now; R2/S3 + CDN later)
```

### Request flows

- **Cache hit:** the song exists for (name, lang, template) → URL at once.
- **Joined:** the same song is already in progress → share that job (atomic Redis create-or-join, BullMQ jobId = songId). Songs with many waiters get priority bumps at 2, 4, 8… waiters.
- **New:** joins the waiting line with a ticket number → a worker claims it (alone when calm, with up to 4 others of the same template when busy) → ElevenLabs clip mode → stitch → storage → marked ready and added to the pool.
- **Spike (ETA > `SPIKE_ETA_SECONDS`):** the picker prefers templates where this name is already ready, else the small `spike: true` set so batches fill and identical names collapse.

### Load-aware picker

```
calm (eta < threshold) → random(all templates for lang)
busy → random(templates where this name is already ready) or random(spike set)
```

### What the app is told

- `wait: none`: ready (or failed, with a "try again" option).
- `wait: short`: the intro plays and the song lands soon; ETA comes from the user's own place in line.
- `wait: later`: the line is long; no countdown, "come back in a bit", polled once a minute.

### Failure handling

- 429 → `worker.rateLimit()` + `Worker.RateLimitError()` (the queue pauses, no retry spent).
- Repeated provider errors → the circuit breaker opens for 30 s and is treated like a rate limit.
- Final failure → the song is marked failed; the next request for it re-queues it.
- Duplicate taps → `Idempotency-Key` header.
- STT over budget → `needsTyping: true` (the user types the name).

### Honest limits

- 1 lakh **unique** names cannot be sung in minutes on a self-serve plan. Caching and dedupe shrink the work (the hit rate on Indian names is unknown). Everyone still gets an answer in seconds. Singing throughput scales only with provider capacity (a bigger plan or self-hosted ACE-Step): a cost dial, not a redesign.

---

## 5. Repo

### Stack

Node 22, **Express 5**, **BullMQ 6**, **ioredis 6**, **TypeScript** (strict, NodeNext ESM, so imports need `.js`), zod 4, pino, prom-client, multer, express-rate-limit + rate-limit-redis, @aws-sdk/client-s3, ffmpeg (system binary). Dev: tsx.

### Layout

```
src/
  apps/        api.ts · sing-worker.ts   (2 deployables, one codebase)
  modules/
    songs/      songs.routes · songs.service · songs.repo (Lua: create-or-join, claim, line) · songs.schema · songs.ids · eta
    singing/    singing.processor · plan (clip plan + splice math) · stitch (ffmpeg) · breaker
      providers/ provider (interface) · elevenlabs · mock
    names/      names.routes (transcribe) · normalize · blocklist
      stt/       stt (interface) · elevenlabs · sarvam · mock · stt.limiter
    templates/  catalog (zod-validated library) · picker
  shared/      redis · queues · storage/ (local, s3) · metrics · logger · ffmpeg · errors · keys · hash · tempfile · shutdown · metricsServer
  http/        app · rateLimit · errorHandler
  config/env.ts  (every setting validated at boot)
scripts/  create-template.ts (generate + leak-check templates) · import-template.ts (legacy) · deploy.sh
templates/ 34 templates (.json + .mp3): hi ×10, bn/gu/mr/pa ×6 each, 2 spike per language
test/     plan.test.ts · names.test.ts · picker.test.ts   (11 tests)
loadtest/ spike.js (k6) · names.json
experiments/ cpu-singing-synth (rejected idea, kept as evidence)
Dockerfile · docker-compose.yml · docker-compose.prod.yml · Caddyfile · .env.example · README.md · DESIGN.md
```

### Template format (`templates/<id>.json`)

```json
{ "id": "hi-love-01", "version": 1, "lang": "hi", "genre": "love", "spike": true,
  "providerSongId": "<ElevenLabs song-id>", "modelId": "music_v2_5",
  "audioFile": "hi-love-01.mp3", "durationMs": 27000,
  "slots": [ { "startMs": 6000, "endMs": 10000, "text": "[Hook]\nओ {name}, दिल कहे तेरा नाम", "styles": [...], "negativeStyles": [...] },
             { "startMs": 18000, "endMs": 22000, ... } ] }
```

Layout of every template: 0–6 s instrumental intro · 6–10 s name slot · 10–18 s verse · 18–22 s name slot · 22–27 s instrumental outro. Catalog validation: slots ≥ 3 s (provider minimum), room for context, no overlapping contexts.

### Key code facts

- **songId** = sha256(`templateId:vVersion:lang:nameKey`)[0..32]. **nameKey** = sha256(`lang:normalizedName`)[0..24].
- **normalizeName**: NFC, letters/marks/space/'- only (blocks lyric injection like `[Verse]`), ≤ 40 chars, Latin → Title Case lyric + lowercase key, other scripts unchanged.
- **Clip plan:** per slot `[ref ctx before] + [generated slot with name] + [ref ctx after]`, `CLIP_CONTEXT_MS=1000`. Up to 5 names per call (30-chunk provider limit, 6 chunks per name). Splice cuts at the middle of each context window with 40 ms crossfades; output length == template length (unit tested).
- **Global concurrency:** `queue.setGlobalConcurrency(PROVIDER_CONCURRENCY)` in sing-worker, enforced in Redis across all worker processes.
- **ETA:** per user, from their ticket number in the waiting line, counted in rounds of batches, with a 20% margin. Whole-line backlog cached 1 s in the API.
- **Mock provider:** simulates the measured latency, the 2-at-once limit with 429s and an optional failure rate; returns real audio so stitching cost is real.

---

## 6. Run locally

```bash
npm install
cp .env.example .env            # then set keys
redis-server                    # or a service; check `redis-cli ping` → PONG
# two terminals:
npm run dev:api                 # logs: api listening {"port":8080,"templates":34,...}
npm run dev:sing                # logs provider: mock | elevenlabs
```

Test:

```bash
curl -i localhost:8080/readyz   # {"redis":true,"templates":34}
curl -s -X POST localhost:8080/v1/songs -H 'content-type: application/json' -d '{"name":"स्नेहिल","lang":"hi"}'
curl -s localhost:8080/v1/songs/<songId>
curl -s -o /tmp/song.mp3 <url>  # bypasses browser cache
```

Templates:

```bash
npx tsx --env-file=.env scripts/create-template.ts --genre love --spike    # also: pop, bhangra, sufi, lofi; --id hi-love-02; --dry-run
```

Other: `npm run typecheck` · `npm test` · `npm run build` · `docker compose up --build`.

### Important env

`SINGING_PROVIDER` (mock|elevenlabs) · `ELEVENLABS_API_KEY` · `PROVIDER_CONCURRENCY=2` · `MAX_NAMES_PER_CALL=5` · `CLIP_CONTEXT_MS=1000` · `STT_PROVIDER` (mock|elevenlabs|sarvam) · `SARVAM_API_KEY` · `SPIKE_ETA_SECONDS=30` · `LATER_AFTER_SECONDS=60` · `STORAGE_DRIVER` (local|s3) · `LOADTEST_TOKEN` (skips rate limits for k6) · `PORT=8080`.

---

## 7. Gotchas

- **Switching mock ↔ elevenlabs:** clear Redis and the song files first (`redis-cli FLUSHALL && rm -rf data/files`). The same name and template give the same songId and URL, so old results would be served.
- **`tsx watch` does not reload `.env`.** Restart the process after env changes.
- **Songs are served `immutable` for 365 days.** Download with curl to a new path when re-testing.
- **Never load test the real provider.** Use `SINGING_PROVIDER=mock`; real measurements are small and deliberate.
- **Redis must use `maxmemory-policy noeviction`** in production (BullMQ requirement; the compose file sets it).
- **The template placeholder must be a natural lyric word** (सनम / यारा / दोस्त), so a rare leak still sounds normal.
