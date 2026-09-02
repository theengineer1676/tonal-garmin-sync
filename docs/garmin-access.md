# Getting Garmin access

**Short version:** run `npm run bootstrap:garmin` once, type your Garmin
password and 2FA code, and you're done for about a year. No Garmin password is
ever stored.

## Why there's a bootstrap step at all

You'd expect the service to just log in with a stored password. Two things stop
that:

- **Garmin's login sits behind a Cloudflare WAF** that rate-limits (HTTP 429) the
  mobile SSO endpoint most libraries use. Automated logins get blocked.
- **Most accounts have MFA**, and there's nobody around to type the code when a
  container restarts at 3am.

So the login happens **once, with you at the keyboard**. That produces a token
store the service reuses on its own. After that there is no password and no MFA
code involved in a sync — which is both more convenient and more secure than
storing a password would have been.

This is handled by the Python [`garminconnect`](https://pypi.org/project/garminconnect/)
library, whose widget+cffi login strategy is the part that gets through the WAF.
It's pinned in `python/requirements.txt` because this is fragile ground.

## Do it

### If you're running with Docker (most people)

Bring the service up first (`docker compose up -d --build`), then:

```bash
docker compose exec tonal-garmin-sync npm run bootstrap:garmin
```

### If you're running Node directly

```bash
npm run bootstrap:garmin
```

Install [uv](https://docs.astral.sh/uv/) first. The bootstrap script uses it to
run the pinned Python dependencies in an isolated environment; it does not
modify your system Python. If uv is unavailable, the script falls back to
`python3`, in which case that interpreter must already have
`python/requirements.txt` installed.

Either way you'll be asked for three things:

```
Garmin Connect email: you@example.com
Garmin Connect password (hidden):
MFA / 2FA code: 123456
```

You type these directly into the prompt. They are **never** written to `.env`,
**never** passed as command-line arguments (which would show up in the process
list), and **never** logged. Only the resulting tokens are saved.

> **Expect a 30–45 second pause** after you enter your password. That delay is
> deliberate — it's how the library avoids tripping Garmin's rate limiter. It has
> not frozen. Don't Ctrl-C it.

Success looks like:

```
Success. Tokens saved to data/garmin-tokens
```

Inside Docker, the same host directory is mounted at `/data`, so the container
prints `/data/garmin-tokens` instead.

## What just got created

```
data/garmin-tokens/garmin_tokens.json
```

**Treat this file like a password.** It's a logged-in Garmin session — readable
and writable — that works without your password or your 2FA. Anyone who copies it
has your Garmin account until the tokens expire.

```bash
chmod 700 data/garmin-tokens
```

It's already covered by `.gitignore` (the whole `data/` directory is). Don't
move it somewhere that isn't.

## How long it lasts

About a year. The short-lived half refreshes itself automatically, so in normal
use you will not think about this again.

When it does finally expire, uploads fail with a clear message telling you to
re-run the bootstrap. It won't fail silently — and because dedup means nothing
was recorded as synced, your workouts will upload once you've re-run it.

You'll also need to re-run it if you **change your Garmin password** or **revoke
sessions** in Garmin's account settings. Both invalidate the tokens immediately.

## When it fails

| What you see | What it means | What to do |
| --- | --- | --- |
| `HTTP 429` / "too many requests" | Garmin is rate-limiting you | **Wait at least an hour.** Retrying in a loop makes it worse and can extend the block |
| No MFA prompt appears, login fails | Account has MFA off, or a login method the library can't drive | Try again with MFA enabled on your Garmin account |
| `The 'garminconnect' package is not installed` | Running outside Docker without uv or the Python dep | Install uv, or use the Docker command above |
| `Could not run "python3"` | Neither uv nor a usable Python is on the host | Install uv, set `GARMIN_PYTHON` to a suitable Python, or use the Docker command above |
| Wrong password error, but the password is right | Garmin sometimes rejects logins from new IPs | Sign in to Garmin Connect in a browser from the same network first, then retry |
| `Garmin token store missing at ...` when syncing | Bootstrap never completed, or wrote somewhere else | Check `data/garmin-tokens/garmin_tokens.json` exists and the service can read it |
| Uploads fail with an auth error later | Tokens expired or were revoked | Re-run the bootstrap |

### Garmin China accounts

`garminconnect` supports Garmin China (`garmin.cn`) but this project doesn't pass
that option through. If you need it, you'd set `is_cn=True` when constructing
`Garmin(...)` in `python/garmin_bootstrap.py` and `python/garmin_upload.py`.
Untested — a PR making it an env var would be welcome.

## A note on what the service can do to your Garmin account

The token store grants full account access, and the service uses it to **upload
activities**. It never deletes or modifies anything, and it never reads your
other data. But the token itself isn't scoped — if that's a concern, be aware
that a compromised token store is a compromised Garmin account.

Uploaded activities behave like any manually-imported activity: you can delete
them in Garmin Connect normally. (If you delete one and want it back, see
[troubleshooting.md](troubleshooting.md#force-a-re-sync).)

## Next

- **Android + Home Assistant:** [home-assistant.md](home-assistant.md)
- **iPhone, or no Home Assistant:** [iphone.md](iphone.md)
