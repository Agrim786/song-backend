# Name Song Backend

Say your name, pick a language, get a song with your name sung in it.
Built to stay up and honest when 5,000 or 1 lakh people tap "generate" at once.

## The core idea

The singing provider is the bottleneck, not our code. Measured on ElevenLabs Creator (31 Oct to 1 Nov 2026):

| Measured                      | Value                                       |
| ----------------------------- | ------------------------------------------- |
| Parallel generations allowed  | **2** (3rd gets `429`)                      |
| 1 name per call (clip mode)   | ~3.3 to 3.7 s                               |
| 5 names per call              | ~6.9 to 7.4 s, **2.3x throughput** per slot |
| Cost per new name (clip mode) | ~165 credits, about $0.03, same in a batch  |
| Returned clip length          | always planned length + 24 ms               |

So users never talk to the provider directly. The system:

1. **Sings each name once per template.** Song id = hash(template, version, language, name), so caching and dedupe are automatic.
2. **Joins duplicates.** 400 people named Rahul at the same moment share one job (atomic Redis create-or-join + BullMQ `jobId`). Names with many waiters jump the queue.
3. **Queues behind the provider limit.** At most 2 provider calls at once across all workers. A `429` pauses the queue instead of spending retries; a circuit breaker stops calls for 30 s after repeated failures.
4. **Batches when busy.** Calm: 1 name per call, back in ~3.4 s. Busy: up to 5 waiting names of the same template in one call, 2.3x the throughput.
5. **Picks templates by load.** Calm: random template for variety. Busy: a template this name already has, else a small spike set so duplicates collapse.
6. **Hides the wait.** Every response carries the template's audio URL; the app plays its 6 s instrumental intro at tap and swaps in the sung song before the music reaches the name.
7. **Never shows a countdown it can't keep.** Past 60 s of estimated wait, the response says `wait: "later"`: the app shows "come back in a bit", and the song waits under its id.
8. **Sends only the name to the provider (clip mode).** Template context + name sections only, stitched back on our CPU: 165 vs 371 credits for a full song.

The full design, measurements and trade-offs are in the design doc.

## Architecture

```
 Phone app
   |  GET  /v1/languages                    -> languages that have templates
   |  POST /v1/names/transcribe (audio,lang) -> "Did we hear Dhruv?"
   |  POST /v1/songs {name, lang}           -> 200 ready | 202 queued, with intro + wait
   |  GET  /v1/songs/:id                    -> poll (Retry-After says when)
   v
 API (N copies, stateless) ---- Redis: songs, pool, waiting sets per template,
                                       idempotency, rate limits, BullMQ queue
                                   |
                         sing-worker (2 provider calls at once, 1 to 5 names each)
                         provider: ElevenLabs | mock
                         batch clip -> length check -> stitch each song -> storage
                                   |
                         S3 / R2 + CDN (immutable songs; template audio for the intro)
```

| Part        | How it scales                                                           | Limit                                               |
| ----------- | ----------------------------------------------------------------------- | --------------------------------------------------- |
| API         | Add copies behind a load balancer (stateless)                           | CPU per copy                                        |
| Redis       | One node handles this load; managed Redis for failover                  | Memory                                              |
| sing-worker | More processes add resilience only; the cap stays at the provider limit | **Provider plan** (more slots, or self-hosted GPUs) |
| Files       | S3/R2 behind a CDN, songs cached forever (content-addressed)            | none in practice                                    |

### How batching works

Each song has one BullMQ job (`jobId = songId`) and sits in a waiting set for its template. When a job runs, it atomically claims its own song plus, if the line is long, up to 4 more waiting songs of the same template, and marks them processing. One provider call sings them all; each song is cut out and stitched separately. The other songs' jobs later find nothing to do and finish instantly. A retried job reuses exactly the batch it claimed.

## Layout

Modules by business domain, entry / logic / data-access inside each, outside services behind interfaces, two deployables sharing one codebase.

```
src/
  apps/                 deployables: api, sing-worker
  modules/
    songs/              songs.routes · songs.service · songs.repo (create-or-join, waiting sets, claim) · songs.schema · songs.ids · eta
    singing/            singing.processor (batch consumer) · plan (clip + batch plan, splice math) · stitch (ffmpeg) · breaker
      providers/        provider (interface) · elevenlabs · mock
    names/              names.routes (transcribe, languages) · normalize · blocklist
      stt/              stt (interface) · sarvam · mock · stt.limiter
    templates/          catalog (validated library) · picker (load-aware)
  shared/               redis · queues · storage/ (local, s3) · metrics · logger · ffmpeg · errors · keys · shutdown
  http/                 express app, Redis-backed rate limits, error handling
  config/env.ts         every setting, validated at boot
scripts/create-template.ts   generate a template with ElevenLabs + leak check
experiments/                 tried-and-rejected work, with audio and measurements
loadtest/spike.js            k6 spike test (mock provider only)
test/                        splice + batch math, name keys, picker
```

## Run it

Needs Node 20.6+, Redis 7, ffmpeg (with ffprobe).

```bash
npm install
cp .env.example .env            # mock provider by default, no keys needed
redis-server &                  # or: docker compose up redis
npm run dev:api
npm run dev:sing
```

Try it:

```bash
curl -X POST localhost:8080/v1/songs -H 'content-type: application/json' \
  -H 'idempotency-key: tap-1' -H "x-device-id: $(uuidgen)" -d '{"name":"Rahul","lang":"hi"}'
curl localhost:8080/v1/songs/<songId>
```

Real provider: `SINGING_PROVIDER=elevenlabs`, `ELEVENLABS_API_KEY`, `PROVIDER_CONCURRENCY=2`.
Real speech-to-text: `STT_PROVIDER=sarvam`, `SARVAM_API_KEY`.
Docker (single VPS): `docker compose up --build`.

New language: add its templates (`scripts/create-template.ts` presets with lyrics in that language). It then appears in `GET /v1/languages` with no other change.

## API

| Method | Path                              | Notes                                                                                                                                                                                         |
| ------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/languages`                   | Languages that have templates; the app's language picker                                                                                                                                      |
| POST   | `/v1/names/transcribe`            | multipart `audio` + `lang` (call after the user picks a language). Returns `{name, needsTyping}`. The recording is never stored. Over the STT budget, `needsTyping: true` instead of an error |
| POST   | `/v1/songs`                       | `{name, lang}` + optional `Idempotency-Key`. `200` ready, `202` queued                                                                                                                        |
| GET    | `/v1/songs/:id`                   | Current status; `Retry-After` header says when to ask again                                                                                                                                   |
| GET    | `/files/templates/:file`          | Template audio for the instant intro                                                                                                                                                          |
| GET    | `/healthz`, `/readyz`, `/metrics` | liveness, readiness, Prometheus (keep `/metrics` private)                                                                                                                                     |

Song response:

```json
{
  "songId": "…",
  "status": "queued | processing | ready | failed",
  "url": "… (when ready)",
  "wait": "none | short | later",
  "etaSeconds": 12,
  "pollAfterSeconds": 4,
  "intro": {
    "templateUrl": "…/files/templates/hi-love-01.mp3?v=1",
    "nameAtMs": 6000
  }
}
```

App behaviour: play `intro.templateUrl` at once. `wait: "short"`: show "Composing your song..." and poll after `pollAfterSeconds`; swap to `url` (same timeline as the template) when ready. `wait: "later"`: show "Lots of people are making songs, come back in a bit"; keep the `songId` and check again on reopen. `failed`: offer "try again" (re-posting re-queues it).

Send `X-Device-Id: <uuid>` on every `/v1` call (a random id the app makes once at install). Rate limits are per device, because Indian carriers put thousands of users behind one IP; a high per-IP ceiling (`RATE_LIMIT_IP_PER_MIN`) stays as a backstop.

## Load testing (never against the real provider)

The mock provider copies measured ElevenLabs behaviour: ~3.3 s for one name plus ~0.475 s per extra sung section, hard limit of 2 with `429` beyond, and real audio so stitching cost is real.

```bash
# on the server: SINGING_PROVIDER=mock, LOADTEST_TOKEN=<random>
k6 run -e BASE_URL=https://your-api -e PEAK_RPS=83 -e LOADTEST_TOKEN=<token> loadtest/spike.js     # 5,000 users/min
k6 run -e BASE_URL=https://your-api -e PEAK_RPS=1667 -e LOADTEST_TOKEN=<token> loadtest/spike.js   # 1 lakh users/min
```

Scenarios worth running: provider outage (`MOCK_FAIL_RATE=1` for 2 min: circuit breaker opens, jobs wait, nothing crashes), duplicate taps (same `Idempotency-Key`: one job), worker killed mid-job (BullMQ re-delivers the job with its batch).

## Tests

`npm test`. Only where a silent wrong number would hurt: splice and batch offsets (name in the wrong place), name keys (cache misses / wrong song), picker (spike behaviour, template versions).

## Before production

- Rotate every key that was ever pasted into a chat or screenshot.
- `STORAGE_DRIVER=s3` (R2) once there is more than one machine; upload template audio there and set `TEMPLATES_PUBLIC_BASE_URL`.
- Redis: `maxmemory-policy noeviction` (BullMQ requirement), persistence on.
- Fill `config/blocklist.txt`. Add app attestation (Play Integrity / App Attest) before public launch; device ids alone won't stop scripted abuse.

## Known limits

- New-name capacity is about 36 per minute (calm) to 85 per minute (batched) on 2 provider slots. Beyond that users get "come back in a bit"; more capacity is a plan or GPU budget, not code.
- The Creator plan's credits cover only about 790 new names a month.
- Cache hit rate depends on real name distribution, not yet measured.
- Load numbers so far are from one laptop; re-run on the VPS for the numbers that count.
