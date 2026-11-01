# Name Song: Spike-Safe Backend Design

Nov 1, 2026 · @Agrim Mahajan

## Summary

Name Song is a one-screen app: say your name, confirm it, pick one of five Indian languages, and hear a song with your name sung in it, about 5 to 7 seconds after tapping when the line is short, with the music starting at once.

The AI singer is the bottleneck, not our servers: ElevenLabs sings at most 2 songs at a time. So users never talk to it directly, and the system makes as few, as cheap and as well-packed singing calls as possible:

- **Sing only the name.** Each song is a pre-made template; per user only the two spots where the name is sung are re-sung, then stitched in. 165 credits per new name instead of 371.
- **Sing each name once.** A song's id is a hash of template, version, language and name, so a finished song is reused forever and identical requests share one job.
- **One queue, capped at the singer's limit,** with up to 5 names per call when there is a line (2.3x faster, measured).
- **Honest waiting.** Each user's wait comes from their own place in line. The front of a rush gets the instant experience; people further back are told to come back, never shown a long countdown.

**Measured on the live server** (a €7.99/month, 2-CPU VPS): 5,000 people tapping at once, zero errors, all answered within about 12 seconds. The same code on a laptop answers them in 1.5 seconds.

**The honest limit:** on the current ElevenLabs plan about 85 brand-new names can be sung per minute. That is a budget dial (a bigger plan or our own GPUs), not a code limit. Repeated names cost nothing and are instant.

## Words used in this doc

A handful of terms carry the whole design; each is explained once here.

| Term            | Meaning                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Template        | A pre-made 27-second song with a neutral placeholder word where a name goes. 34 exist: 5 languages, several styles, each in a male and a female voice |
| Name spot       | One of the two 4-second places in a template where the name is sung (at 6 s and 18 s)                                                                 |
| Clip mode       | Asking ElevenLabs to re-sing only the two name spots plus 1 second of music either side, instead of the whole song                                    |
| Stitching       | Cutting the newly sung parts into the template on our server (ffmpeg), so the result is the full song with the user's name                            |
| Song id         | A hash of template, version, language and name. Same inputs, same song, for every user, forever                                                       |
| Join            | A request for a song that is already being made shares that job instead of starting a new one                                                         |
| Slot            | One of the 2 songs ElevenLabs lets us make at the same time on our plan                                                                               |
| Batch           | Up to 5 different names sung in one ElevenLabs call (same template), used when there is a line                                                        |
| Spike set       | 2 templates per language that a rush is steered onto, so batches stay full and identical names collapse                                               |
| Place in line   | Each waiting song gets a ticket number; a user's wait is worked out from how many songs are ahead of theirs                                           |
| Wait band       | What the app is told: **short** (music plays, song lands soon) or **later** (come back in a bit)                                                      |
| Intro hand-over | The app plays the template the moment you tap, then switches to your song at the same spot in the music                                               |
| Mock singer     | A fake ElevenLabs used for load tests: same timing and limits, no credits spent                                                                       |
| Credits         | ElevenLabs' billing unit. About 165 per new name in clip mode                                                                                         |

## The product

One screen, four steps; the user only ever gives a name and a language, and the system picks the song.

1. **Say your name.** Tap the mic, say it, tap again (it stops itself at 5 seconds and shows the time). The recording is about 12 to 20 KB, so it uploads fast on weak networks, and it is only sent to speech-to-text, never stored.
2. **Is this right?** The name comes back as text, large, and editable. If the mic is unavailable or nothing was understood, the user types it.
3. **Sing it in...** Hindi, Bengali, Marathi, Gujarati or Punjabi, each shown in its own script. The last choice is remembered. The list comes from the server: it offers exactly the languages that have templates.
4. **The song.** The music starts the instant you tap. The screen's title is the actual line being sung with your name in it (for example "O Rahul, dil kahe tera naam"). When your sung version is ready the app switches to it at the same spot in the music, with no gap. Then Play, Pause, or Make another.

**What the user is told while waiting.** Never a countdown that might slip.

| Situation                                            | What they see and hear                                                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Song already exists (someone with that name made it) | Plays immediately                                                                                                                              |
| Short line                                           | Music starts at once; the name lands a few seconds later                                                                                       |
| Song not ready when the music reaches the name       | The music fades and waits there ("Almost there"), then continues with the name                                                                 |
| Long line                                            | "Lots of songs being made right now. Come back in a bit, yours will be waiting here." The app remembers the song and picks it up when reopened |
| Song failed                                          | "That one didn't come out" and a Try again button                                                                                              |
| Offensive name                                       | Refused with a short message                                                                                                                   |

**Built to be light on cheap phones:** one screen, few libraries, no image or icon packs, animations on the native thread, small uploads, timeouts and retries on every call. The Android APK is 36.8 MB.

## Why the obvious design fails

The obvious design (each tap asks the AI for a full new song) cannot survive a rush, and adding servers does not help, because the limit belongs to the AI provider, not to us.

|                                     | Obvious: full song per tap         | This design: name only, batched |
| ----------------------------------- | ---------------------------------- | ------------------------------- |
| Songs the provider makes at once    | 2 (a 3rd is refused with HTTP 429) | 2, each carrying up to 5 names  |
| Speed                               | about 0.5 songs per second         | about 1.4 new names per second  |
| 5,000 users, all different names    | about 2.7 hours                    | about 1 hour                    |
| 1,00,000 users, all different names | about 50 hours                     | about 20 hours                  |
| Cost per new song                   | 371 credits, about $0.067          | 165 credits, about $0.03        |
| Repeated names                      | sung again every time              | free and instant                |

So the design has four jobs: make fewer singing calls (reuse and share songs), make each call cheaper and fuller (sing only the name, 5 at a time), never overload the provider (one queue capped at its limit), and be honest with each user about their wait.

## Architecture

Four containers on one server (Caddy, API, Redis, sing worker) serve the app, and only the sing worker ever talks to the AI singer, never more than twice at a time.

```
 Phone app ──HTTPS──► Caddy (only public door, automatic HTTPS)
     ▲                     │
     │                     ▼
     │               API (stateless, N copies) ◄──► Redis (songs, waiting line, queue, limits)
     │                                                   │ jobs
     │                                                   ▼
     │                                    Sing worker (max 2 calls, 1-5 names each)
     │                                          │ clip plan out ▲ name audio back
     │                                          ▼               │
     │                                        ElevenLabs (singing + speech-to-text)
     │                                          │ stitched song saved
     └──── intro first, then the song ◄── Storage / CDN (songs + templates, cached)
```

| Part        | What it does                                                                                                                                              | Built with                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Phone app   | Records the name, confirms it, picks the language, plays the intro and swaps in the song                                                                  | Expo SDK 58 (React Native), Zustand + MMKV for local state, TanStack Query for server calls |
| Caddy       | The only public door: automatic HTTPS, forwards to the API, hides internal metrics                                                                        | Caddy 2                                                                                     |
| API         | Takes requests, picks the template, creates or joins the song, works out each user's wait. Keeps no state of its own, so more copies can run side by side | Node 22, Express 5, TypeScript                                                              |
| Redis       | Song records, the waiting line, the job queue, rate-limit counters, idempotency keys                                                                      | Redis 7, set never to evict data                                                            |
| Sing worker | Takes waiting songs (1, or up to 5 when busy), calls ElevenLabs, checks the result, stitches each song, saves it                                          | BullMQ queue, ffmpeg                                                                        |
| ElevenLabs  | Sings the name spots (Music API, clip mode) and turns speech into text (Scribe)                                                                           | External service                                                                            |
| Files       | Finished songs and template audio, cached forever since they never change                                                                                 | Server disk today; cloud storage + CDN when there is more than one server                   |

**What happens to each request:**

| Request                            | What the system does                                | What the user gets                                  |
| ---------------------------------- | --------------------------------------------------- | --------------------------------------------------- |
| Name already sung in that template | Nothing new                                         | The song, immediately                               |
| Same name already being made       | Joins that job; popular names move up the line      | The same song when it lands                         |
| New name, short line               | Joins the line; sung alone (fastest)                | Music at once, name a few seconds later             |
| New name, long line                | Steered onto the 2 spike templates, sung 5 per call | Their own wait, from their place in line            |
| Further back than about 1 minute   | Stays in line, saved on the phone                   | "Come back in a bit", song waiting when they return |

**The API in five calls:** `GET /v1/languages` (what to offer), `POST /v1/names/transcribe` (recording to text), `POST /v1/songs` (make or reuse a song), `GET /v1/songs/:id` (status, with a hint for when to ask again), and `GET /files/...` (the audio).

## How one song is made

A song is a template with the user's name sung into two short spots; only those spots cost an AI call, and the rest is reused.

1. **The template** (made once, ahead of time): 27 seconds in five parts: 6 s instrumental intro, 4 s name spot, 8 s verse, 4 s name spot, 5 s outro. The name spots are sung with a placeholder word that fits the song (for example "yaara"). A speech-to-text check rejects any take where that word leaks outside the name spots, because the rest of the template is copied into every user's song.
2. **The request to ElevenLabs** (clip mode): for each name spot, 1 second of the template before it, the name spot sung fresh with the user's name, and 1 second after it. That is 12 seconds of audio per name instead of 27, and billing is per second returned: 165 credits instead of 371. With a line, up to 5 names go in one call (the API allows 30 sections, and each name uses 6).
3. **A safety check:** every returned clip must be the planned length (it always measured planned + 24 ms). If not, the job fails loudly instead of putting a name in the wrong place.
4. **Stitching** (our server, ffmpeg): each person's piece is cut out of the clip at the middle of the 1-second overlaps, where template and clip carry the same music, and joined into the template with 40 ms crossfades. The finished song is exactly as long as the template.
5. **Saved forever** under its song id, and the line (the song's lyric with the name) is returned to the app as the screen's title.

**The intro hand-over (in the app).** The finished song and the template are the same audio up to the name, so the app plays the template the moment you tap. When your song is ready it is downloaded in full, started silently, lined up with the music that is playing, and the two are crossfaded over 150 ms. If the song is not ready when the music reaches the name, the music fades and waits there, then continues with your name. Tested by ear on a real phone: no audible join.

## How a rush is handled

Each layer either removes work before it reaches the AI singer or makes the remaining wait honest; all of them are built and were exercised in load tests.

| #   | Layer             | What it does                                                                                                                                                                                                                                                                                | Evidence                                                                      |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Front door        | Rate limits per phone (a random id made at install), not per IP, because many Indian mobile users share one carrier IP; a high per-IP ceiling stops scripts. One idempotency key per tap, so retries never create a second song. Speech-to-text has its own budget; over it, the user types | 200 users on one IP: 0 songs before the fix, 200 after                        |
| 2   | Reuse             | A finished song is never made again; files are cached for a year                                                                                                                                                                                                                            | Song ids are a hash; unit tested                                              |
| 3   | Join              | Requests for a song already being made share that job (an atomic Redis step); names many people are waiting for move up the line                                                                                                                                                            | 5,000 requests for 100 names became 200 jobs                                  |
| 4   | Load-aware picker | Quiet: any template, for variety. Busy: a template this name already has, else the 2 spike templates, so batches fill and the same names collapse. Each arrival is counted before picking, so even a burst inside one second is noticed                                                     | A sub-second burst of 2,000 landed on exactly 2 templates                     |
| 5   | Capped queue      | At most 2 ElevenLabs calls at once, across all workers. A 429 pauses the queue without using up retries; repeated failures pause calls for 30 s                                                                                                                                             | Never more than 2 calls at once, zero 429s, in every test                     |
| 6   | Batching          | 1 name per call when quiet (fastest), up to 5 when there is a line                                                                                                                                                                                                                          | 2.3x throughput, measured on the real API                                     |
| 7   | Place in line     | Every waiting song gets a ticket number; each user's wait comes from the songs ahead of theirs, counted in rounds of batches, with a 20% safety margin                                                                                                                                      | 48 of 50 promises kept in a 2,000-user test on the laptop                     |
| 8   | Honest messages   | Short wait: music plays, song lands. Over about a minute: "come back in a bit", and the phone checks once a minute                                                                                                                                                                          | 5,000 waiting phones made about 56 requests per second instead of about 3,300 |
| 9   | CPU split         | Song-making is limited so answering users always has CPU                                                                                                                                                                                                                                    | Last of 5,000 answered in 11.7 s instead of 15.6 s on the VPS                 |

## Under pressure: 1 to 1,00,000 users

Two separate things happen in a rush: the server answering every user quickly (grows with CPU and servers), and new names being sung (fixed at about 85 per minute by the AI plan). Rows assume everyone taps within the same minute, every name is new (the worst case), and today's €7.99 server.

| Users    | Everyone gets an answer                                                      | Songs                                                                                      |
| -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1        | About 0.1 s                                                                  | Ready in about 5 to 7 s; music plays from the first second                                 |
| 100      | Instantly                                                                    | The first \~50 hear theirs within a minute; the rest within about 1 to 2 minutes           |
| 5,000    | Within about 12 s on this server (1.5 s on a laptop), zero errors (measured) | The first \~40 to 50 within a minute; everyone else "come back"; all done in about an hour |
| 10,000   | About 25 s on this server: needs a second API copy or a bigger CPU           | About 2 hours                                                                              |
| 1,00,000 | Needs several API copies or machines (about 1,700 requests per second)       | About 20 hours on the current plan, and far more credits than the plan includes            |

**Real crowds repeat names.** Every repeated name is instant and free, so these all-new-name numbers are the worst case.

### The 1,00,000th user

On today's plan, if all 1,00,000 names are new, the last one waits about 20 hours. They are never shown that number; they are asked to come back, and the song waits for them. But the real answer is capacity, sized up front. One provider slot sings about 0.7 new names per second (measured), so:

| Last user's wait (1,00,000 new names) | Provider slots needed |
| ------------------------------------- | --------------------- |
| About 20 hours                        | 2 (today)             |
| 1 hour                                | About 40              |
| 10 minutes                            | About 240             |
| 2 minutes                             | About 1,200           |

The singing bill is the same in every row, about $3,000 for 1,00,000 new names; what changes is how many slots run at once (a bigger ElevenLabs plan or our own GPUs). In practice 1,00,000 people arrive together because of something scheduled (an ad, a launch), so capacity is raised for that window. A surprise spike gets the same safe behaviour: no errors, repeats instant, new names in fair order.

## Measured numbers

Everything in this section was run, not estimated, between 31 Oct and 1 Nov 2026; estimates elsewhere are labelled as such.

**The real ElevenLabs API** (Creator plan, clip mode):

| Test                                        | Result                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Songs at once                               | 2; a 3rd is refused with 429 "concurrent\_limit\_exceeded"                                  |
| 1 name per call                             | 3.3 to 3.7 s                                                                                |
| 5 names per call                            | 6.9 to 7.4 s                                                                                |
| 10 names per call                           | Refused: at most 30 sections per call                                                       |
| Throughput on 2 slots                       | 0.6 names/s at 1 per call, 1.41 at 5 per call (2.3x)                                        |
| Names sung correctly (speech-to-text check) | 30 of 30 in batched calls; "Rahul" correct in all 4 new languages                           |
| Cost per new name                           | About 165 credits (about $0.03), the same batched or not; a full song is 371                |
| Returned length                             | Always planned + 24 ms                                                                      |
| Streaming                                   | Fails whenever clip mode is used; for fresh songs it saved only about 1 s                   |
| Template generation                         | 34 templates; the 27 new ones cost 8,786 credits; 25 of 27 passed the leak check first time |

**Load tests** (a mock singer with the measured timing and the 2-at-once limit, so no credits are spent):

|                                              | MacBook Air M4 | Live VPS (2 vCPU, €7.99/month)            |
| -------------------------------------------- | -------------- | ----------------------------------------- |
| 5,000 users at once: last one answered       | 1.5 s          | 11.7 to 13.3 s                            |
| Errors                                       | 0              | 0                                         |
| Requests answered per second                 | about 3,300    | about 350 to 400                          |
| 5,000 waiting phones checking back           | n/a            | about 56 per second, p95 114 ms, 0 errors |
| Time to make one song (whole job, per song)  | 2.2 s          | 3.1 to 3.7 s                              |
| Wait promises kept for the front of the line | 48 of 50       | 9 to 16 of 23 to 49                       |
| Memory used by the whole system              | n/a            | about 250 MB of 2 GB                      |

**How to read the VPS column:** the answers are about 8x slower than the laptop on the same code, which is the CPU, not the design. Wait promises for the front of the line miss by 10 to 30 s there because song-making and answering share 2 slow CPUs during the burst, so speed swings; on the laptop they held. The test client ran over a phone hotspot with 200 connections, so some of the answer time is the client's own network.

## Bugs found by testing

All but one bug below were found by running the system (load tests, an emulator, a real phone), and every fix was checked by running it again.

| Bug                                                                 | How it showed up                        | Fix                                                                                                                                                   | Checked                                    |
| ------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| A burst inside one second was treated as calm (everyone told "0 s") | Load test                               | Count each arrival immediately, not after the line is read                                                                                            | 4,230 of 5,000 steered correctly           |
| Users sharing one IP were locked out                                | 200 users from one IP got 0 songs       | Limit per phone id, with a high per-IP ceiling                                                                                                        | 200 of 200                                 |
| A song could wait forever with no job behind it after a crash       | Simulated crash                         | The next request for that name notices and re-queues it                                                                                               | Re-queued, counted in a metric             |
| After a template update, "already made" pointed at missing songs    | Code review                             | Remember template version too                                                                                                                         | Unit test                                  |
| Everyone in a rush was told "come back later", even the front       | VPS load test                           | Each user's wait from their own place in line                                                                                                         | 0 to \~50 users get the instant experience |
| Places in line jumped in steps                                      | Laptop test                             | Ticket numbers instead of millisecond timestamps (dozens of requests share a millisecond)                                                             | Smooth waits, 4 to 60 s                    |
| A sub-second burst scattered over 10 templates                      | Laptop test                             | Count arrivals before choosing a template                                                                                                             | Burst lands on 2 templates, batches full   |
| Wait promises too optimistic                                        | Laptop test                             | Time whole jobs (singing and stitching), count in rounds of 5, 20% margin                                                                             | 48 of 50 kept                              |
| Song-making starved the API of CPU                                  | VPS monitor                             | Give song-making low CPU priority (tested; the live server still runs an earlier 1-core cap until this is deployed)                                   | Answers 15.6 s to 11.7 s                   |
| Offensive "names" were sung                                         | Emulator audit                          | Blocklist (Hindi, Punjabi, English; Latin and Indian scripts) that also catches spelling variants and splits, without blocking real names like Gandhi | Unit test                                  |
| Speech-to-text never worked on phones                               | Server logs showed zero upload requests | Expo SDK 58's fetch rejects React Native's old file format; upload via Expo's own File class                                                          | Server receives the recording, HTTP 200    |
| App stuck forever on a saved song the server no longer knew         | Emulator                                | An "unknown song" answer clears it and starts over                                                                                                    | Checked on emulator                        |
| 0.4 s silence when the song took over from the intro                | Real phone, first play only             | Start the song silently, line it up, crossfade                                                                                                        | Confirmed by ear on a real phone           |

## Tried and rejected

Each idea below was built or measured and then dropped for a stated reason, so what remains in the design is what survived evidence.

| Idea                                                                                                          | What was found                                                                                                                                                            | Verdict                                                                                   |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Own-voice preview: play the template with the user's own recording of their name while the sung version waits | Instant, but it sounds like a voice pasted over music; and 5,000 of them took about 6 minutes of server CPU                                                               | Dropped. The intro hand-over replaced it                                                  |
| CPU singing synthesizer: retune a spoken name onto the template's notes on our own server                     | About 0.2 s of CPU per name, so it would scale cheaply; intelligibility improved from 55% to 80% with tuning, but by ear the name is clearly a different, pasted-in voice | Rejected. Audio, scripts and scores are in the repo under `experiments/cpu-singing-synth` |
| Streaming the AI's audio as it is made                                                                        | Fails whenever clip mode is used; even for fresh songs it saved only about 1 s                                                                                            | Rejected                                                                                  |
| Pre-singing a list of popular names                                                                           | Cannot cover the long tail of Indian names; any unlisted name still waits                                                                                                 | Not the design: songs are reused as they are made instead                                 |
| Hosting our own music model                                                                                   | Removes the 2-at-once limit, but every new name still costs GPU time; 5,000 new names in 10 s would need roughly 250 to 500 warm GPUs (estimate)                          | Phase 2 capacity lever, not a spike fix                                                   |
| A syllable bank: pre-sing every syllable in the template singer's voice and join them per name                | Finite and complete in theory (a few thousand units), but joining sung pieces smoothly is hard and it is days of work                                                     | Idea only, not built                                                                      |
| A load balancer on today's single server                                                                      | Splitting requests across API copies helps only with spare CPU; this box has 2 cores shared with song-making                                                              | Deferred: needs more CPU first                                                            |
| A hard 1-core limit on song-making                                                                            | Kept the API responsive but slowed song-making to 18 to 21 s per batch on the VPS                                                                                         | Replaced in testing by low priority (12 s per batch, faster answers)                      |

## Deployment and security

The whole backend runs on one small Mumbai VPS, deployed from GitHub, with only HTTPS open to the internet.

|            |                                                                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server     | €7.99/month KVM VPS, Mumbai: 2 vCPU, 2 GB RAM plus 2 GB swap, 40 GB SSD, Ubuntu 24.04, Docker                                                                                                                                                                                         |
| Address    | `https://103-215-216-51.sslip.io` (sslip.io turns the IP into a name, so Let's Encrypt can issue a real certificate without buying a domain)                                                                                                                                          |
| Containers | Caddy, API, sing worker, Redis (persistent, never evicts data)                                                                                                                                                                                                                        |
| HTTPS      | Caddy gets and renews the certificate automatically; plain http redirects to https                                                                                                                                                                                                    |
| Deploys    | The server is a git clone of `song-backend`, read through a read-only deploy key. `scripts/deploy.sh` refuses uncommitted or unpushed work, runs the type check and tests, then the server pulls, rebuilds and checks its own health. Production is always exactly a commit on GitHub |
| App        | Android release APK (36.8 MB, arm64 and armv7), talking only to the HTTPS address                                                                                                                                                                                                     |

**Security measures:**

- SSH accepts keys only; password login is switched off. The firewall allows only SSH, HTTP and HTTPS; the API port and internal metrics are not reachable from outside.
- Secrets live only in the server's `.env` (readable by root only). They were never committed (checked across the whole git history). The ElevenLabs key used during development is replaced by a fresh one on the server, and the old one must be deleted in ElevenLabs.
- Voice recordings are never stored: they go to speech-to-text and are discarded.
- Names are cleaned to letters only (this also blocks lyric tricks like "\[Verse\]") and checked against a blocklist.
- Load tests run against the mock singer in a separate Redis database, so they never spend credits or touch real songs.

**Moving to a real domain** later is two settings: the server's `SITE_ADDRESS` and the app's API address. Caddy fetches the new certificate itself.

## Scaling and cost

Everything except singing grows by adding ordinary servers; singing grows only with money.

| Part                    | How it grows                                                                            | What limits it today                                                   |
| ----------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| API                     | Keeps no state, so more copies run side by side behind Caddy (which also balances load) | CPU: one copy on this VPS answers about 350 to 400 requests per second |
| Song-making (stitching) | A separate song-making server, or more cores                                            | CPU: about 3 s per song on this VPS, 2.2 s on a laptop                 |
| Singing                 | A bigger ElevenLabs plan (more songs at once) or our own GPUs                           | The plan: 2 at once, about 85 new names per minute                     |
| Redis                   | One node is plenty here; managed Redis for failover                                     | Memory (tiny: the whole system used about 250 MB)                      |
| Song files              | Cloud storage plus a CDN once there is more than one server                             | Bandwidth: 200 Mbit/s is about 35 to 40 song downloads per second      |
| Languages               | Add templates; nothing else changes (the app reads the list from the server)            | Lyrics in each language need a native speaker's check                  |

**Cost:**

| Item                     | Cost                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| A new name in a template | About 165 credits, about $0.03                                                                                 |
| A name already sung      | Nothing                                                                                                        |
| A new template           | About 371 credits per attempt                                                                                  |
| The server               | €7.99 per month                                                                                                |
| Current plan (Creator)   | 131,000 credits a month: about 790 new names. A real launch needs a bigger plan before it needs bigger servers |

## Honest limits and what is not verified

The system does not fail under load, but it has real limits, and a few claims rest on less testing than others.

**Limits:**

- **New names per minute.** About 85 on the current ElevenLabs plan. Beyond that people are asked to come back; the wait is real.
- **Monthly credits.** The current plan covers about 790 new names a month.
- **This VPS.** In a 5,000-user burst the last user waits about 12 s just for an answer, and the wait promised to the front of the line can be 10 to 30 s off, because 2 slow CPUs are shared by answering and song-making.
- **One server.** If it goes down, the app is down. A second server needs shared storage first.
- **Languages.** The Marathi, Gujarati, Punjabi and Bengali lyrics were written without a native speaker; speech-to-text confirmed the words are sung, not that they sound natural.
- **Voices.** Each template was asked for a male or female voice; that it obeyed has not been checked by ear for all 34.
- **Names said as a sentence.** "My name is Priya" comes back whole; the user has to trim it on the confirm screen.
- **sslip.io.** The free address depends on a third-party DNS service until a real domain is used.
- **No push notifications.** "Come back in a bit" relies on the user reopening the app.

**Not verified yet:**

- [ ] A load test against the real ElevenLabs (only the mock singer was load tested, deliberately, to avoid spending credits)
- [ ] Provider outage and a worker killed mid-song (the code handles both; not re-tested)
- [ ] The low-priority CPU setting deployed on the live server (tested only)
- [ ] iOS (only Android was built and tested)
- [ ] Many different phones (tested on one real phone and an emulator)

## Phase 2

The next steps, in the order they would pay off:

1. **More singing capacity** for a planned launch: a bigger ElevenLabs plan, or a self-hosted open model (ACE-Step's repaint was tested in the lab and keeps the rest of the song nearly identical).
2. **More CPU:** a separate song-making server, and two or more API copies behind the load balancer.
3. **Cloud storage and a CDN** for song files, which also allows a second server.
4. **A real domain behind Cloudflare,** for caching and resilience.
5. **Push notifications** for users told to come back.
6. **App attestation** (Play Integrity, App Attest) so phone ids cannot be faked by scripts.
7. **Native-speaker review** of every lyric, and more template shapes so songs feel less alike.
8. **A singing-voice model trained on the template singers,** which would make the CPU-only singer viable and remove the provider from the hot path entirely.

## Questions a reviewer will ask

Short answers to say out loud; each is backed by a section above.

**Can it handle 1,00,000 users at once?** The system, yes: no errors, every user gets an answer, repeats are instant, and answering grows by adding API copies. Singing 1,00,000 brand-new names in minutes, no: on this plan it is about 85 a minute. That is a budget dial, not a code limit: about 240 provider slots would do it in 10 minutes, and the bill per name is the same.

**What does the 1,00,000th user see?** An answer within seconds. If the line is long: "come back in a bit, your song will be waiting". Never a fake countdown, and for a planned launch we size capacity so that line stays short.

**Why is it slower on your server than on your laptop?** The live server is a €7.99, 2-CPU box, the floor and not the ceiling. Same code: 1.5 s for 5,000 users on a laptop, about 12 s on the VPS. The API keeps no state, so it scales with CPUs and copies.

**Why not just add more workers?** The provider allows 2 songs at a time per account; more workers would only collect refusals. The queue is capped at 2 across all workers, and each call carries up to 5 names instead.

**What if 400 people named Rahul tap together?** One job; the other 399 join it and get the same file. Measured: 5,000 requests for 100 names became 200 jobs.

**How do you make a song without waiting for the AI?** The music starts the moment you tap (it is the same template), and your name is swapped in when it is ready, with a crossfade so the join is inaudible.

**How do you know the name lands in the right place?** The splice math is unit tested, every clip's length is checked against the plan (it is always plan + 24 ms), and a wrong length fails the job instead of shipping a bad song.

**Why ElevenLabs and not your own model?** Quality today and no GPUs to run. Self-hosting removes the 2-at-once cap, but each new name still costs GPU time, so it is the phase 2 capacity lever.

**What did you try that failed?** An own-voice preview, a CPU-only singing synthesizer (fast, but it sounded pasted in; the evidence is in the repo), streaming (fails with clip mode), and pre-sung name lists (cannot cover the long tail).

**What was the hardest bug?** Speech-to-text silently never worked on phones: the server logs showed zero upload requests, which pointed to the app. Expo SDK 58's fetch rejects React Native's old file-upload format; the recording is now sent through Expo's own File class.

**What happens if the provider goes down?** Calls pause for 30 s after repeated failures, jobs wait instead of using up retries, and finished songs keep playing.

**How do you stop abuse?** Names are reduced to letters only, checked against a blocklist that catches spelling variants, and rate-limited per phone, with a per-IP ceiling. App attestation is next.

**How do you deploy?** Commit, push, run one script. It refuses unpushed work, runs the checks, the server pulls from GitHub and rebuilds. Production is always a known commit.

**Why Caddy, Zustand, MMKV and TanStack Query?** Caddy gives automatic HTTPS in 10 lines of config. Zustand holds the screen's state machine, MMKV saves preferences instantly on the phone, and TanStack Query handles polling at the server's pace, retries with backoff, and pausing in the background.

**What does it cost?** About $0.03 per new name, nothing for a repeat, €7.99 a month for the server.
