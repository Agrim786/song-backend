# CONTEXT.md — Name Song (GumboTech take-home)

Handover for Claude Code. Read fully before changing anything.

---

## 1. The assignment

- **From:** Rahul Kumar (CTO, Whitelight Ventures; ex-AVP Engineering, Teachmint; IIT Bombay). Hiring for a new entity linked to GumboTech. Contact via the email thread (hiring@gumbotech.in is CC'd).
- **Deadline:** Monday, 2 Nov 2026 (submit Monday morning).
- **Brief (as given verbally):**
  - Mobile app with **one screen**.
  - User **speaks their name**, **selects a language**.
  - App **generates a song with the name in it**.
  - **Twist:** backend must work flawlessly and stay fast if **5,000 or 1,00,000 users** submit at once.
- **What he is judging:** original engineering reasoning ("I've seen you can copy things, not yet that you can create"). He dislikes obvious jugaad. Honest limits + measured numbers > big claims.
- **Not specified (we chose, state as assumptions in the doc):** third-party providers allowed (with a self-hosted path), deliverable = working app + design doc.
- **No genre selector.** User gives only name + language. The system picks the song.

---

## 2. Core idea (the design in one paragraph)

The singing provider is the bottleneck, not our servers. So users never talk to it directly. We pre-generate a **library of song templates** (love, pop, bhangra, …) once. For each user we only re-sing the **name spots** of a template via ElevenLabs Music **inpainting in "clip mode"** and stitch them back into the template on our CPU. Every song is **content-addressed** (hash of template, version, language, name), so the same name never generates twice (cache + dedupe). A **queue capped at the provider's concurrency** protects the provider. A **load-aware template picker** reuses existing songs during spikes. If the wait is long, the user instantly gets an **own-voice preview** (template + their recorded name, ffmpeg only), replaced by the sung version later.

---

## 3. Measured numbers (real tests, keep them in the doc)

### ElevenLabs Music (Creator plan, $22/mo, 121,000 credits, $0.00018/credit)
| Metric | Value |
|---|---|
| Concurrent generations allowed | **2** (3rd → `429 concurrent_limit_exceeded`, message states "maximum of 2 concurrent requests") |
| Time per name (full mode, 21 names) | p50 3.89 s, p95 4.48 s, range 3.33–4.55 s, TTFB ~3.2 s (little streaming benefit) |
| Throughput | ~0.57 names/s max (2 slots) → 1 lakh unique names ≈ 49 h |
| Cost, full mode (27 s song returned) | **371 credits ≈ $0.067** |
| Cost, clip mode (~12 s returned) | **165 credits ≈ $0.03** — billing is per second of audio returned (~13.7 credits/s) |
| Clip-mode quality | No audible seams (tested by ear), names sung naturally to the melody |
| Pronunciation | Devanagari lyrics give Indian pronunciation; Roman spelling drifts → send native script |

### ACE-Step 1.5 (free ACE Music cloud API, api.acemusic.ai)
| Metric | Value |
|---|---|
| Repaint works | Yes — name section re-sung (hook_vs_source 0.05–0.46) |
| Rest of song preserved | **Exactly** (rest_vs_source 0.996) — better than ElevenLabs |
| Speed | 10.6 s alone, queued up to 27 s; effectively 1 at a time |
| Overload | HTTP 502 + retry-after 60 beyond ~2–3 parallel |
| Throughput | ~0.1 names/s |
| Verdict | Free demo service, not production. Proves the open-source model works → **phase 2: self-host ACE-Step (MIT)** |

### Template findings
- **Leak finding:** kept sections are copied exactly into every song. The first template sang the placeholder ("Rahul") in kept sections too → every song said "Rahul". Fix: neutral placeholder word that fits the genre + instrumental intro/outro + verse forbids ad-libs + automatic speech-to-text leak check with retry.
- All 3 current templates passed the leak check on the first attempt.

### Self-hosting estimate (unverified, from ACE-Step's own claims: <2 s/song on A100, batch 8)
- Assuming ~0.25 GPU-s per name: 10,000 names ≈ 42 min on 1 GPU, ≈ 2 min on ~20 GPUs; 1 lakh in ~10 min ≈ 40 GPUs. Must be benchmarked before claiming.

---

## 4. Architecture

```
 Phone app
   │ POST /v1/names/transcribe (audio)         → "Did we hear स्नेहिल?"
   │ POST /v1/songs {name, lang, recordingId}  → 200 ready | 202 queued + ETA (+ previewId)
   │ GET  /v1/songs/:id, /v1/previews/:id      → poll
   ▼
 API (stateless, N copies) ──── Redis (songs, pool, idempotency, rate limits, BullMQ)
                                   │
          ┌────────────────────────┴───────────────────────┐
          ▼                                                ▼
 sing-worker (global concurrency = 2)            preview-worker (CPU/ffmpeg)
 ElevenLabs clip plan → stitch → storage          template + user's own voice
          └──────────────► storage (local now; R2/S3 + CDN later) ◄──┘
```

### Request flows
- **Cache hit:** song exists for (name, lang, template) → URL instantly.
- **Joined:** same song already in progress → share that job (atomic Redis create-or-join + BullMQ jobId = songId). Songs with many waiters get priority bumps (only at 2, 4, 8… waiters).
- **New:** queue → worker → ElevenLabs clip mode → stitch → storage → mark ready, add to pool.
- **Spike (ETA > SPIKE_ETA_SECONDS):** picker prefers templates where this name already exists, else the small `spike: true` set so dedupe still works. If ETA > PREVIEW_ETA_SECONDS and a recording exists → instant own-voice preview.

### Load-aware picker
```
calm (eta < threshold) → random(all templates for lang)
busy → random(templates where this name is already ready) or random(spike set)
```

### Failure handling
- 429 → `worker.rateLimit()` + `Worker.RateLimitError()` (job waits, no retry spent).
- Repeated provider errors → circuit breaker opens 30 s, treated like a rate limit.
- Final failure → song marked failed; next request for it re-queues.
- Duplicate taps → `Idempotency-Key` header.
- STT over budget → `needsTyping: true` (user types name).

### Honest limits (state in the doc)
- 1 lakh **unique** names cannot be sung in minutes on a self-serve plan. Caching/dedupe shrink the work (hit rate unknown; Indian names are spread out). Everyone still gets something in seconds. Throughput scales only with provider capacity (Enterprise concurrency or self-hosted ACE-Step) — a cost dial, not a redesign.

---

## 5. Repo

Location on Agrim's Mac: `~/Projects/gumbo-assingment/song-backend` (note the folder spelling).
Parent folder also has Python lab scripts (not part of the backend):
- `name_song_lab_v3.py` — ElevenLabs inpainting experiments (template/name/batch/concurrency).
- `ace_lab.py` — ACE-Step repaint experiments.
- `lab_v3/`, `lab_out/`, `ace_out/` — experiment outputs.

### Stack
Node 20.6+ (tested on 22), **Express 5**, **BullMQ 6**, **ioredis 6**, **TypeScript 7** (strict, NodeNext ESM — imports need `.js`), zod 4, pino, prom-client, multer, express-rate-limit + rate-limit-redis, @aws-sdk/client-s3, ffmpeg (system binary). Dev: tsx.

### Layout (component-based, like Immich / Novu / Node.js Best Practices)
```
src/
  apps/        api.ts · sing-worker.ts · preview-worker.ts   (3 deployables, one codebase)
  modules/
    songs/      songs.routes · songs.service · songs.repo (Lua create-or-join) · songs.schema · songs.ids · eta
    singing/    singing.processor · plan (clip plan + splice math) · stitch (ffmpeg) · breaker
      providers/ provider (interface) · elevenlabs · mock
    previews/   previews.service · previews.processor · previews.repo · stitch
    names/      names.routes (transcribe) · normalize · blocklist · recordings.repo
      stt/       stt (interface) · sarvam · mock · stt.limiter
    templates/  catalog (zod-validated library) · picker
  shared/      redis · queues · storage/ (local, s3) · metrics · logger · ffmpeg · errors · keys · hash · tempfile · shutdown · metricsServer
  http/        app · rateLimit · errorHandler
  config/env.ts  (every setting validated at boot)
scripts/  create-template.ts (generate + leak-check templates) · import-template.ts (from lab_v3, legacy)
templates/ hi-love-01, hi-pop-01, hi-bhangra-01 (.json + .mp3)
test/     plan.test.ts · names.test.ts · picker.test.ts   (8 tests)
loadtest/ spike.js (k6) · names.json
Dockerfile · docker-compose.yml · .env.example · README.md
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
- **normalizeName**: NFC, letters/marks/space/'- only (blocks lyric injection like `[Verse]`), ≤ 40 chars, Latin → Title Case lyric + lowercase key, Devanagari unchanged.
- **Clip plan:** per slot `[ref ctx before] + [generated slot with name] + [ref ctx after]`, `CLIP_CONTEXT_MS=1000`. Splice cuts at the middle of each context window with 40 ms crossfades; output length == template length (unit tested).
- **Global concurrency:** `queue.setGlobalConcurrency(PROVIDER_CONCURRENCY)` in sing-worker — holds across all worker processes.
- **ETA** = backlog × EWMA(seconds per song) / slots, cached 1 s in the API.
- **Mock provider:** simulates measured latency, a hard concurrency limit with 429s, optional failure rate; returns real audio so stitching cost is real.

---

## 6. Run locally

```bash
cd ~/Projects/gumbo-assingment/song-backend
npm install
cp .env.example .env            # then set keys
brew services start redis       # or run `redis-server` in its own tab; check `redis-cli ping` → PONG
# three tabs:
npm run dev:api                 # must log: api listening {"port":8080,"templates":3,...}
npm run dev:sing                # logs provider: mock | elevenlabs
npm run dev:preview
```
Test:
```bash
curl -i localhost:8080/readyz   # {"redis":true,"templates":3}
curl -s -X POST localhost:8080/v1/songs -H 'content-type: application/json' -d '{"name":"स्नेहिल","lang":"hi"}'
curl -s localhost:8080/v1/songs/<songId>
curl -s -o /tmp/song.mp3 <url> && open /tmp/song.mp3   # bypass browser cache
```
Templates:
```bash
npx tsx --env-file=.env scripts/create-template.ts --genre love --spike    # also: pop, bhangra, sufi, lofi; --id hi-love-02; --dry-run
```
Other: `npm run typecheck` · `npm test` · `npm run build` · `docker compose up --build`.

### Important env
`SINGING_PROVIDER` (mock|elevenlabs) · `ELEVENLABS_API_KEY` · `PROVIDER_CONCURRENCY=2` · `CLIP_CONTEXT_MS=1000` · `STT_PROVIDER` (mock|sarvam) · `SARVAM_API_KEY` · `SPIKE_ETA_SECONDS=30` · `PREVIEW_ETA_SECONDS=30` · `STORAGE_DRIVER` (local|s3) · `LOADTEST_TOKEN` (bypasses per-IP limiter for k6) · `PORT=8080`.

---

## 7. Current status (31 Oct 2026, night)

- ✅ Backend runs end to end locally. Real ElevenLabs run: "स्नेहिल" sung inside `hi-love-01`, stitched, cached, served.
- ✅ 3 templates generated with the leak check: hi-love-01 (spike), hi-pop-01 (spike), hi-bhangra-01. Bhangra transcript read "लच्च ले आजे" — listen once to confirm it's just STT.
- ✅ Dev-box k6 smoke (mock, 1 API process, ~120 req/s, 35 s): 4,199 requests, 0 failures, p95 41 ms, 1,835 instant from pool, 2,258 joined, 100 provider jobs, never > 2 concurrent provider calls.
- ✅ Unit tests (8) + typecheck pass.

### Patches given in chat — VERIFY they are applied locally
1. **Express 5 listen bug** (`src/apps/api.ts`): Express 5 calls the listen callback with an error (e.g. EADDRINUSE), and the old code logged "api listening" anyway. Fix: `app.listen(PORT, (err?: Error) => { if (err) { logger.fatal(...); process.exit(1); } logger.info(...) })`.
2. **Mock render** (`src/modules/singing/providers/mock.ts`): generated chunks now reuse the template audio at the same position (placeholder sung) instead of a near-silent sine, so a correct mock song sounds exactly like the template. Remove the unused `sha256` import.

---

## 8. Gotchas (learned the hard way)

- **Switching mock ↔ elevenlabs:** run `redis-cli FLUSHALL && rm -rf data/files` first. Same name+template = same songId/URL, so old results get served.
- **`tsx watch` does not reload `.env`.** Restart the process after env changes.
- **Browser/QuickTime caches songs** (served `immutable`, 365 d). Download with curl to a new path when re-testing.
- **Port 8080 was taken** by another local Node app once. Check `lsof -iTCP -sTCP:LISTEN -P | grep node`.
- **zsh:** don't paste commands with trailing `# comments`.
- **Never load test the real provider.** Use `SINGING_PROVIDER=mock`. Small real measurements only.
- **Redis must use `maxmemory-policy noeviction`** in production (BullMQ requirement; compose file sets it).
- **Template placeholder must be a natural lyric word** (सनम / यारा / दोस्त) so a rare leak still sounds normal.

---

## 9. TODO (priority order, deadline Monday morning)

1. **Apply/verify the two patches** in section 7.
2. **Remove `genre` from the public request schema** (`songs.schema.ts`) — no genre selector; keep it only for internal/testing if needed (e.g. a dev-only flag).
3. **One-screen app** (Expo / React Native):
   - Record name (expo-audio or similar) → `POST /v1/names/transcribe` (multipart `audio`, `lang`) → show "Did we hear X?" with editable text (if `needsTyping`, show a text field).
   - Language picker (hi, en for now).
   - Generate → `POST /v1/songs` with `Idempotency-Key` (uuid per tap) and `recordingId`.
   - `200` → play. `202` → show honest ETA; if `previewId`, poll `/v1/previews/:id` and play it immediately; poll `/v1/songs/:id` and swap to the sung version.
   - Deliver: Android APK via EAS + web export (works on any phone incl. iPhone over HTTPS).
4. **Deploy** on Agrim's VPS (docker compose or pm2), HTTPS domain, `PUBLIC_BASE_URL` set, `/metrics` blocked publicly.
5. **k6 on the VPS** (mock provider, `LOADTEST_TOKEN` set): `PEAK_RPS=83` (5k/min) and push toward `1667` (1 lakh/min) to find the ceiling. Also: outage test (`MOCK_FAIL_RATE=1` for 2 min), duplicate taps, kill a worker mid-job.
6. **More templates:** 3–5 per genre, similar counts per genre (picker is uniform). Mark 2–3 as `spike`. Add sufi/lofi presets already in the script; new genres = new preset entries.
7. **create-template.ts:** auto-bump `version` if the id already exists (or never overwrite an id that has served songs).
8. **The design doc** (short, ~2 pages + diagram):
   - Assumptions (providers allowed + self-hosted path; output = personalized song from generated components).
   - Why the naive design fails (per-user full generation; 2-slot limit; 49 h math).
   - Architecture + diagram, request flows, picker, fallback ladder (AI-sung → own-voice preview).
   - **Measured numbers** (section 3) clearly labeled measured vs estimated.
   - Scaling table, failure handling, cost per user (clip vs full).
   - Original ideas: clip-mode billing trick, content-addressed songs, load-aware picker, own-voice instant preview, leak-checked templates.
   - Honest limits + phase 2 (self-hosted ACE-Step repaint, tested).
   - "What I haven't verified" list.
9. **Before anything public:** rotate the ElevenLabs and ACE Music keys (both appeared in chat/screenshots). Fill `config/blocklist.txt`.

Nice to have: OpenAPI docs from zod schemas, e2e tests against HTTP, swap prom-client (deprecated warning) later.

---

## 10. Agrim's engineering conventions (follow these)

- Strict TypeScript, `.env` + `.env.example`, README on day one.
- Feature/module folders, **one job per file**, design system separate from UI (app side).
- Comments explain **why**, not what.
- Install packages only when the importing code exists (Expo: `npx expo install`).
- Workflow: install → `npx tsc --noEmit` → run.
- Tests only where a silent wrong number would destroy trust.
- Keep correct logic; rebuild bad scaffolding. Write the feature list before starting.
- If it can be done in two days, don't spend two weeks. Execution over theory.
- Credentials that appear in chat are treated as public and rotated.
- Ask before big rewrites; Agrim wants to understand and own what ships (he will be questioned on it by a senior CTO).
