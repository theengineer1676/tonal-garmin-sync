# Troubleshooting

Start here:

```bash
docker compose logs -f tonal-garmin-sync
SERVICE_URL="http://$(docker compose port tonal-garmin-sync 8080)"
curl "$SERVICE_URL/health"                                          # → {"ok":true}
curl -X POST "$SERVICE_URL/sync" -H "x-webhook-secret: YOUR-SECRET"
```

> Before pasting any of this into an issue, redact your workout data. See
> [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## Nothing syncs after a workout

Work down this list — it's ordered by how often each one is the cause.

| # | Check | If it's wrong |
| --- | --- | --- |
| 1 | Does a manual `curl` to `/sync` work? | If yes, the service is fine and the problem is the trigger — go to 2. If no, skip to [Sync errors](#sync-errors) |
| 2 | **Android:** does the Last-notification sensor update after a Tonal notification? | Almost always the allow-list setting — [home-assistant.md step 3](home-assistant.md#3-️-turn-off-the-allow-list-requirement) |
| 3 | **iPhone:** are you expecting a notification trigger? | It cannot exist on iOS. Use polling — [iphone.md](iphone.md) |
| 4 | Does the automation's `package` condition match the sensor's real `package` attribute? | Fix the package name — [home-assistant.md step 4](home-assistant.md#4-find-your-sensor-and-your-package-name) |
| 5 | Can Home Assistant reach the service? | Run the `curl` from the HA host. Use the LAN IP, not `localhost` |
| 6 | Do the secrets match? | `secrets.yaml` must equal `.env`'s `WEBHOOK_SECRET` exactly |

---

## Sync errors

### `{"error":"unauthorized"}` (401)

The `x-webhook-secret` header doesn't match `WEBHOOK_SECRET`. Watch for trailing
whitespace, mismatched quotes in `secrets.yaml`, and forgetting to restart the
service after changing `.env`.

### A workout is skipped with "no per-set detail available"

Two kinds of entry in the Tonal feed look like completed workouts but have no
sets behind them, and return 404 if you ask for their detail:

- **Activities imported from Apple Health.** If you let Tonal read from Apple
  Health, your runs and rides appear in the same feed, flagged
  `activityType: "External"`. They were never Tonal workouts, so there is
  nothing to sync — and you almost certainly don't want them going to Garmin
  twice anyway.
- **Deleted activities**, which keep appearing with `deletedAt` set.

The service filters both out before syncing, and anything that still slips
through is logged and skipped without stopping the rest of the batch. This is
working as intended, not an error.

If you'd rather they weren't in your Tonal feed at all: turn off the other app's
write access in iOS **Health → Sharing → Apps**, and delete the imported entries
in the Tonal app.

### `HTTP 401: token is expired by [N]m[M]s`, roughly every 10 hours

A known bug in the Tonal client library: it records its token expiry from the
`expires_in` value returned at login (24 hours), but authenticates with a token
whose own expiry claim is about 10 hours. After ~10 hours it keeps sending a
credential Tonal has already rejected.

**Nothing to do — the service handles it.** It logs in again and retries the
request once, so the workout still syncs. You'll see one line in the log:

```
[sync] Tonal rejected the session — logging in again and retrying once
```

You do *not* need the daily container restart that gets suggested for this.
Tracked upstream at
[dlwiest/ts-tonal-client#6](https://github.com/dlwiest/ts-tonal-client/issues/6).

### `Token expired and refresh failed. Call authenticate() first.`

The Tonal client's internal session token failed to refresh itself, usually
after the container has run for several days without a restart. Current
versions self-heal: the service drops the stale client on this error and logs
in fresh on the *next* sync attempt, so this fails once and then recovers on
its own. If you're on an older version, `docker compose restart
tonal-garmin-sync` clears it immediately. Either way, the workout that
triggered this error wasn't recorded as synced, so a backfill or the next
poll/trigger picks it up: `npm run backfill -- 3 --dry` to check.

### `Garmin token store missing at .../garmin_tokens.json`

The one-time bootstrap hasn't run, or wrote somewhere the service can't read.

```bash
docker compose exec tonal-garmin-sync npm run bootstrap:garmin
```

See [garmin-access.md](garmin-access.md).

### Uploads used to work, now fail with an auth error

Garmin tokens expired (~1 year), or you changed your Garmin password / revoked
sessions. Re-run the bootstrap. Nothing was recorded as synced, so the affected
workouts will upload once you have.

### `{"status":"no-activity"}`

The Tonal account has no completed workouts. Usually the wrong account in
`.env` — confirm with `npm run verify`.

### `{"error":"sync failed"}` (500)

Deliberately generic; the real error is in the logs:

```bash
docker compose logs --tail=50 tonal-garmin-sync
```

### 415 Unsupported Media Type

An old version of this service. Home Assistant's `rest_command` sends
`application/octet-stream`; current versions accept any content type. Update.

### Tonal login fails

See the failure table in [tonal-access.md](tonal-access.md#when-it-fails).

### `[movements] catalog refresh failed ... using cached names`

Harmless. Tonal's catalog endpoint was briefly unreachable, so cached exercise
names were used instead. It'll refresh on a later run.

---

## It synced, but looks wrong in Garmin

### Exercises show as "Unknown"

The movement isn't in the map. Reps and weights are still correct.
Find them with `npm run inspect:fit`, then see
[movement-map.md](movement-map.md). If the log says *no movement-map.json found*,
the bundled map isn't being read at all — check `config/` made it into your
image (`docker compose build --no-cache`).

### Calories show as 0

If they're 0 on an *older* synced workout: Garmin Connect does not recompute
calories for imported activities, and early versions of this project omitted the
value. Current versions send Tonal's figure. Re-sync the workout to fix it.

### No heart-rate graph

Tonal only records heart rate if **you pair an HR monitor to the Tonal itself**.
A watch worn during the workout doesn't feed Tonal. Check what Tonal has:

```bash
docker compose exec tonal-garmin-sync npm run check:hr
```

`sample count: 0` means Tonal has no HR data — nothing this project can do.

### Weights look wrong

Tonal reports weight per attachment already: handles are per-hand, a barbell is
the combined figure, a single-cable rope is that cable. The service sends that
figure as-is, which matches what the Tonal app shows you.

- **Bodyweight move showing a weight**, or the reverse → the `onMachine` flag,
  see [movement-map.md](movement-map.md#fixing-a-wrong-mapping)
- **Everything ~2.2× off** → `TONAL_WEIGHT_UNIT` is wrong; it should be `lb`
- **Right numbers, wrong unit displayed** → set `GARMIN_DISPLAY_UNIT=lb`

### Duplicate activities in Garmin

The service dedups by Tonal activity id, and Garmin rejects identical uploads
with a 409 (reported as `duplicate`). Genuine duplicates usually mean two
instances are running against the same account, or `data/` was reset between
syncs.

### Warm-up / cool-down blocks look odd

Gaps of 60s or more before your first set and after your last become "Warm Up"
blocks. FIT has no cool-down category, so the trailing one is labelled Warm Up
too — Garmin distinguishes them by position. This is a FIT limitation.

---

## Container problems

### Permission denied writing to /data

The container runs as uid 1000; your `./data` is owned by someone else.

```bash
sudo chown -R 1000:1000 ./data
```

### Container restarts repeatedly

```bash
docker compose logs --tail=50 tonal-garmin-sync
```

Usually a missing required variable — `TONAL_EMAIL`, `TONAL_PASSWORD` or
`WEBHOOK_SECRET`. The error names the one it wants.

### Port already in use

Change `HOST_PORT` in `.env` (not `PORT` — that's the port inside the
container), then `docker compose up -d`. Remember to update the Home Assistant
`rest_command` URL to match.

### Polling isn't running

It's off by default. The log confirms it when it's on:

```
[poll] checking for new workouts every 20 minute(s), looking back 3 activities
```

If you set a value below 15 you'll see a clamp warning — that's expected, see
[iphone.md](iphone.md).

---

## Force a re-sync

Useful after fixing a movement mapping or upgrading. Three steps — miss one and
nothing happens:

1. **Delete the activity in Garmin Connect.** Otherwise the upload comes back as
   a `duplicate`.
2. **Remove its entry from `data/sync-state.json`.** Otherwise the service skips
   it. Find the block keyed by the activity id and delete it, keeping the JSON
   valid.
3. **Trigger a sync** — `curl`, or `npm run backfill -- 5`.

To re-sync everything, delete the activities in Garmin and remove
`data/sync-state.json` entirely; it's recreated on the next run.

---

## Still stuck

Open an issue with:

- What you expected and what happened
- Whether `npm run verify` succeeds
- How it's triggered (HA / polling / manual)
- Relevant log lines — **redacted**

Keep field names, movement UUIDs, error text and status codes. Remove workout
names, weights, reps and heart rates. Never paste `.env`, your webhook secret,
or anything from `data/garmin-tokens/`.
