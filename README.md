# tonal-garmin-sync

Sync your completed **Tonal** workouts into **Garmin Connect** as proper strength
activities — with every set, rep, weight and heart-rate sample, not just a
duration and a calorie estimate.

Tonal doesn't talk to Garmin. This is a small self-hosted service that makes it.

```
Tonal app  →  phone notification  →  Home Assistant  →  POST /sync  →  this service
                                                                          │
                        Tonal API (summary + per-set detail)  ────────────┤
                        encode strength FIT file             ─────────────┤
                        upload to Garmin Connect (deduped)   ─────────────┘
```

No phone notification? It can poll instead — see [iPhone & polling](docs/iphone.md).

## What you get in Garmin

- Every set: exercise, reps, weight, and time under tension
- Exercises named properly (not "Unknown") via a bundled 291-movement map
- Heart-rate graph, zones and training effect, if you pair an HR monitor to your Tonal
- Warm-up and cool-down blocks
- Calories from Tonal
- No duplicates, ever — each workout syncs once

## What you need

| | |
| --- | --- |
| **A Tonal** | and its account email + password |
| **A Garmin Connect account** | you'll log in once, interactively |
| **Somewhere to run Docker** | a NAS, a Pi, a home server — this is tiny |
| **Android + Home Assistant** | *optional* — for instant sync on workout completion |

**iPhone users:** the notification trigger is Android-only, permanently — iOS
doesn't let any app read another app's notifications. Use polling instead; it
works fine and needs no Home Assistant at all. See [docs/iphone.md](docs/iphone.md).

## Quick start

**1. Get the code and configure it**

```bash
git clone https://github.com/theengineer1676/tonal-garmin-sync.git
cd tonal-garmin-sync
cp .env.example .env
```

Edit `.env`: set `TONAL_EMAIL`, `TONAL_PASSWORD`, and a `WEBHOOK_SECRET`
(generate one with `openssl rand -hex 32`). Then lock it down:

```bash
chmod 600 .env
```

**2. Check your Tonal credentials work**

```bash
npm install
npm run verify
```

This prints what it can read from your account. Nothing is uploaded.
Details and failure modes: [docs/tonal-access.md](docs/tonal-access.md).

**3. Log in to Garmin once**

```bash
npm run bootstrap:garmin
```

When you run this on the host, install [uv](https://docs.astral.sh/uv/) first;
the script uses it to provide the pinned Python dependencies without modifying
your system Python.

You type your Garmin password and 2FA code directly into the prompt — they're
never stored. This mints a token store the service reuses for about a year.
Expect a 30–45 second pause during login; that's deliberate, not a hang.
Details: [docs/garmin-access.md](docs/garmin-access.md).

**4. Start it**

```bash
docker compose up -d --build
curl "http://$(docker compose port tonal-garmin-sync 8080)/health"  # → {"ok":true}
```

**5. Sync your existing workouts, so you can see it working**

```bash
docker compose exec tonal-garmin-sync npm run backfill -- 5 --dry   # preview
docker compose exec tonal-garmin-sync npm run backfill -- 5         # do it
```

**6. Make it automatic**

- **Android:** wire up the Home Assistant trigger → [docs/home-assistant.md](docs/home-assistant.md)
- **iPhone, or no Home Assistant:** set `POLL_INTERVAL_MINUTES=20` in `.env` → [docs/iphone.md](docs/iphone.md)

## Documentation

| Guide | What's in it |
| --- | --- |
| [Tonal access](docs/tonal-access.md) | How the Tonal login works, and what it means for your account |
| [Garmin access](docs/garmin-access.md) | The one-time token bootstrap, and why it's needed |
| [Home Assistant](docs/home-assistant.md) | The Android notification trigger, step by step |
| [iPhone & polling](docs/iphone.md) | Automatic sync without notifications |
| [Movement map](docs/movement-map.md) | Fixing or adding exercises that show as "Unknown" |
| [Troubleshooting](docs/troubleshooting.md) | Symptom → cause → fix |
| [Security](SECURITY.md) | What credentials are stored, and how to protect them |

## How it works

The Home Assistant trigger (or a poll tick) is only a nudge — it carries no
workout id. The service always looks up your *latest completed* Tonal workout,
so a stray trigger is harmless: already-synced workouts return `skipped`.

Per-set detail comes from a Tonal endpoint that no library wraps
(`/users/{userId}/workout-activities/{id}`), reached through the authenticated
HTTP client inside `@dlwiest/ts-tonal-client`. That gets reps, weights, per-set
timing and the heart-rate series. The service turns it into a strength-training
FIT file and uploads it via the Python `garminconnect` library, which is the part
that can get through Garmin's WAF and MFA.

```
src/
  server.ts     webhook (/sync, /health) + optional polling loop
  sync.ts       orchestration: fetch → dedup → detail → FIT → upload → record
  tonal.ts      ts-tonal-client wrapper + the raw per-set detail call
  garmin.ts     shells out to the Python uploader; token-store handling
  fit.ts        normalize a workout + encode the strength FIT file
  movements.ts  movement id → name cache, and → FIT exercise mapping
  store.ts      JSON dedup/audit log
  config.ts     environment parsing
config/
  movement-map.json   291 Tonal movements → FIT exercises (bundled, editable)
  curated.json        the editable source for that map
  fit-exercises.json  every valid FIT exercise name, for reference
python/
  garmin_upload.py     the single upload call
  garmin_bootstrap.py  the one-time interactive login
```

## Endpoints

- `POST /sync` — requires the `x-webhook-secret` header. Runs one sync.
  Returns `{ status, activityId, name, setCount }` where status is
  `synced` · `skipped` · `duplicate` · `no-activity`.
- `GET /health` — liveness, no auth.

## Limitations and risks

1. **Tonal has no public API.** This uses the same private endpoints the mobile
   app does. Tonal could change or block it at any time. It is not a supported
   integration and nobody at Tonal has blessed it.
2. **Your Tonal password is stored in plaintext** in `.env`, because Tonal offers
   no tokens or OAuth. See [SECURITY.md](SECURITY.md).
3. **iOS can't do notification triggers.** Platform limitation, no workaround.
   Polling covers it.
4. **FIT has a fixed exercise vocabulary.** Movements outside the bundled map
   show as "Unknown" in Garmin — reps and weights still upload correctly.
   [docs/movement-map.md](docs/movement-map.md) explains how to add them.
5. **Garmin doesn't recompute calories for imported activities**, so the service
   sends Tonal's figure. That's a Garmin Connect limitation.
6. **Library internals.** The per-set detail call reaches into
   `ts-tonal-client`'s private HTTP client. It's isolated to one method
   (`Tonal.rawRequest`) that throws a clear error if the library changes.

## Contributing

Movement map additions are especially welcome — the bundled 291 movements cover
one person's programs. See [CONTRIBUTING.md](CONTRIBUTING.md), and please redact
your personal workout data from anything you paste into an issue.

## License

[MIT](LICENSE).

Not affiliated with, endorsed by, or supported by Tonal Systems, Inc. or Garmin
Ltd. "Tonal" and "Garmin" are trademarks of their respective owners. Use at your
own risk.
