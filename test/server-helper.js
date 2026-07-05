// Boots the REAL, unmodified server/index.js as a child process against a throwaway test
// database, so tests exercise the actual production code path — not a reimplementation or a
// mock. This is deliberate: the app is a single monolithic file with no service layer (that
// refactor is intentionally deferred to a later batch), so black-box HTTP testing against a
// real running instance is the safest way to get real regression coverage without touching
// architecture or business logic.
//
// Never points at production — TEST_DATABASE_URL (or DATABASE_URL, when run in CI against the
// ephemeral Postgres service container) must be set, and this refuses to start if it looks like
// it might be the production database.

const { spawn } = require('node:child_process');
const path = require('node:path');

const TEST_PORT = process.env.TEST_PORT || '3999';
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function assertNotProductionDb(url) {
  if (!url) throw new Error('TEST_DATABASE_URL or DATABASE_URL must be set to run these tests (point it at a throwaway/CI database, never production).');
  // Check the HOST specifically, not the whole connection string — a substring check on the
  // full URL (e.g. matching "goreturn" anywhere) false-positives on a deliberately-named
  // throwaway CI database like postgres://test:test@localhost:5432/goreturn_test, which is
  // exactly what broke the first CI run. localhost/127.0.0.1 and the CI service alias
  // "postgres" are always safe regardless of what the database itself is named.
  let host;
  try { host = new URL(url).hostname; } catch (e) { host = url; }
  const isLocal = ['localhost', '127.0.0.1', 'postgres'].includes(host);
  if (!isLocal && /railway\.app|rlwy\.net/i.test(host)) {
    throw new Error(`Refusing to run tests against what looks like a production database host (${host}). Use a throwaway test database.`);
  }
}

async function waitForHealth(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE_URL}/api/health`);
      if (r.ok) return true;
    } catch (e) { /* not up yet */ }
    await new Promise(res => setTimeout(res, 300));
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms`);
}

let serverProcess = null;

async function startServer() {
  const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  assertNotProductionDb(dbUrl);

  serverProcess = spawn('node', [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: TEST_PORT,
      DATABASE_URL: dbUrl,
      NODE_ENV: 'test',
      // Dummy values so the app boots without real external services — no test in this suite
      // exercises real Shopify API calls, real email delivery, or real payment charges.
      SHOPIFY_CLIENT_ID: process.env.SHOPIFY_CLIENT_ID || 'test_client_id',
      SHOPIFY_APP_SHARED_SECRET: process.env.SHOPIFY_APP_SHARED_SECRET || 'test_shared_secret_for_hmac_checks',
      APP_URL: `http://127.0.0.1:${TEST_PORT}`,
      CREDENTIAL_ENCRYPTION_KEY: process.env.CREDENTIAL_ENCRYPTION_KEY || '0'.repeat(64),
      DEBUG_KEY: 'test_debug_key'
    },
    stdio: process.env.TEST_VERBOSE ? 'inherit' : 'pipe'
  });

  serverProcess.on('error', (e) => { console.error('Failed to start server process:', e); });

  await waitForHealth();
  return BASE_URL;
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
  }
}

module.exports = { startServer, stopServer, BASE_URL };
