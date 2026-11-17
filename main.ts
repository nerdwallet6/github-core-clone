// main.ts — entry lifecycle: bind an ephemeral port, register it with the
// suite env, then poll /done until the suite finishes and exit 0.
import { createApp } from './app.ts';

const REQUEST_TIMEOUT_MS = 30000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt) {
  return Math.min(2000, 250 * Math.pow(2, attempt));
}

async function fetchJson(url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const envUrl = (process.env.MAKEFUN_ENV_URL || '').replace(/\/+$/, '');
  if (!envUrl) {
    console.error('[entry] MAKEFUN_ENV_URL is not set');
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;

  // Register: first register wins; a 409 means another entry registered
  // first and we simply keep waiting for /done.
  let registered = false;
  let attempt = 0;
  while (!registered) {
    try {
      const { status } = await fetchJson(envUrl + '/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (status === 200 || status === 409) {
        registered = true;
      } else if (status === 400 || status === 405) {
        throw new Error('register refused with HTTP ' + status);
      }
    } catch (e) {
      if (e && e.message && e.message.startsWith('register refused')) throw e;
      // The env may still be starting; retry.
    }
    if (!registered) {
      await sleep(backoff(attempt));
      attempt += 1;
    }
  }

  // Poll /done until the suite has finished and written its export.
  let done = false;
  attempt = 0;
  while (!done) {
    try {
      const { body } = await fetchJson(envUrl + '/done', { method: 'GET' });
      if (body && body.done === true) done = true;
    } catch {
      // Transient failure; keep polling.
    }
    if (!done) {
      await sleep(backoff(attempt));
      attempt += 1;
    }
  }

  await new Promise((resolve) => server.close(() => resolve()));
  console.log('[entry] done');
  process.exit(0);
}

main().catch((e) => {
  console.error('[entry] fatal: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
