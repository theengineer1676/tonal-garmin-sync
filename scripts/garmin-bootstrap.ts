/**
 * One-time Garmin Connect token bootstrap.
 *
 *   npm run bootstrap:garmin
 *
 * Garmin's login sits behind a Cloudflare WAF that rate-limits the mobile SSO
 * endpoint, and most accounts have MFA — so the service can't log in with a
 * password on its own. Instead you log in once, interactively, here. That mints
 * a token store which the service then uses on its own; no password and no MFA
 * code are involved at sync time.
 *
 * You type your email, password and MFA code directly into the Python prompt
 * below. They are never written to .env, never passed as arguments, and never
 * logged — only the resulting tokens are saved, to:
 *
 *   $DATA_DIR/garmin-tokens/garmin_tokens.json
 *
 * Treat that file like a password. Tokens last about a year and refresh
 * themselves; when they finally expire, uploads fail with a message telling you
 * to run this again.
 *
 * See docs/garmin-access.md.
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configuredDataDir = process.env.DATA_DIR || './data';
// `.env` uses the container mount point, but the quick-start runs this script
// on the host before the container exists. Write to the bind-mount source in
// that case; Docker will expose the same files at /data later.
const dataDir =
  configuredDataDir === '/data' && !existsSync('/data') ? './data' : configuredDataDir;
const tokenDir = path.join(dataDir, 'garmin-tokens');
const script = fileURLToPath(new URL('../python/garmin_bootstrap.py', import.meta.url));
const requirements = fileURLToPath(new URL('../python/requirements.txt', import.meta.url));

const configuredPython = process.env.GARMIN_PYTHON;
const containerPython = '/opt/garmin-venv/bin/python';
const hasContainerPython = existsSync(containerPython);
const uvAvailable =
  !configuredPython && !hasContainerPython
    ? spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0
    : false;

const command =
  configuredPython ?? (hasContainerPython ? containerPython : uvAvailable ? 'uv' : 'python3');
const args = uvAvailable
  ? ['run', '--no-project', '--with-requirements', requirements, 'python', script, tokenDir]
  : [script, tokenDir];

mkdirSync(tokenDir, { recursive: true });

console.log(`Minting Garmin tokens into ${tokenDir}`);
console.log('Expect a 30-45 second pause during login — that delay is deliberate, not a hang.\n');

// stdio: 'inherit' so the password and MFA prompts are a direct conversation
// between you and Python. Nothing passes through this process.
const res = spawnSync(command, args, { stdio: 'inherit' });

if (res.error) {
  console.error(
    `\nCould not run "${command}": ${res.error.message}\n` +
      `Install uv (recommended) or Python 3, or set GARMIN_PYTHON to a Python ` +
      `that has python/requirements.txt installed. See docs/garmin-access.md.`,
  );
  process.exit(1);
}
process.exit(res.status ?? 1);
