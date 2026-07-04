// Black-box HTTP regression tests against a real (unmodified) running instance of the server —
// see server-helper.js for why. Covers exactly the class of bug that broke the live app
// repeatedly during manual testing today: syntax errors that kill every route, broken auth
// checks, broken validation, broken webhook signature verification.
//
// Run: npm test  (requires TEST_DATABASE_URL or DATABASE_URL pointing at a throwaway database —
// see test/server-helper.js, which refuses to run against anything that looks like production)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer } = require('./server-helper');

let BASE_URL;

before(async () => {
  BASE_URL = await startServer();
});

after(() => {
  stopServer();
});

// ---- Health / boot ----
test('health check responds ok', async () => {
  const r = await fetch(`${BASE_URL}/api/health`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
});

// ---- Admin: auth ----
test('admin session check with no token reports not logged in (not an error)', async () => {
  const r = await fetch(`${BASE_URL}/api/admin/session`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.loggedIn, false);
});

test('admin login rejects missing fields', async () => {
  const r = await fetch(`${BASE_URL}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
  });
  assert.equal(r.status, 400);
});

test('admin register succeeds once, then locks out further registration', async () => {
  const body = JSON.stringify({ email: 'ajeetkumar.saas@gmail.com', password: 'TestPassword123!', name: 'Test Owner' });
  const r1 = await fetch(`${BASE_URL}/api/admin/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(r1.status, 200);
  const r2 = await fetch(`${BASE_URL}/api/admin/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(r2.status, 403); // already exists — registration is a one-time bootstrap, not open signup
});

test('admin register rejects any email other than the locked owner address', async () => {
  const r = await fetch(`${BASE_URL}/api/admin/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'attacker@evil.com', password: 'x', name: 'x' })
  });
  assert.equal(r.status, 403);
});

test('team/activity-log require authentication', async () => {
  const team = await fetch(`${BASE_URL}/api/team`);
  assert.equal(team.status, 401);
  const log = await fetch(`${BASE_URL}/api/activity-log`);
  assert.equal(log.status, 401);
});

// ---- API authorization (the class of bug found and fixed earlier this session) ----
test('shopify/stores requires authentication', async () => {
  const r = await fetch(`${BASE_URL}/api/shopify/stores`);
  assert.equal(r.status, 401);
});

test('a fake/garbage Bearer token is rejected, not accepted by length alone', async () => {
  // Regression test for the critical bug found earlier: requireShopAccess used to accept ANY
  // 20+ char Bearer token as proof of access. Confirms it now actually verifies the JWT.
  const r = await fetch(`${BASE_URL}/api/shopify/stores?shop=some-shop.myshopify.com`, {
    headers: { Authorization: 'Bearer ' + 'a'.repeat(40) }
  });
  assert.equal(r.status, 401);
});

// ---- Shopify OAuth ----
test('oauth install redirects to Shopify with the requested shop', async () => {
  const r = await fetch(`${BASE_URL}/api/auth/shopify?shop=test-store.myshopify.com`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const location = r.headers.get('location');
  assert.ok(location.includes('test-store.myshopify.com'));
  assert.ok(location.includes('/admin/oauth/authorize'));
});

test('oauth callback rejects a request with no/invalid HMAC', async () => {
  const r = await fetch(`${BASE_URL}/api/auth/callback?shop=test-store.myshopify.com&code=fake&hmac=invalid&timestamp=123`, { redirect: 'manual' });
  assert.equal(r.status, 403);
});

// ---- Shopify webhooks: HMAC signature is mandatory ----
const webhookPaths = [
  '/api/webhooks/shopify/refunds-create',
  '/api/webhooks/customers/data_request',
  '/api/webhooks/customers/redact',
  '/api/webhooks/shop/redact',
  '/api/webhooks/app-uninstalled'
];
for (const path of webhookPaths) {
  test(`webhook ${path} rejects a request with no HMAC signature`, async () => {
    const r = await fetch(`${BASE_URL}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shop_domain: 'test-store.myshopify.com' })
    });
    assert.equal(r.status, 401);
  });
}

// ---- Customer-facing return portal: validation ----
test('order lookup requires shop, order_number, and email', async () => {
  const r = await fetch(`${BASE_URL}/api/shopify/order-lookup`);
  assert.equal(r.status, 400);
});

test('return creation rejects missing required fields', async () => {
  const r = await fetch(`${BASE_URL}/api/returns`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
  });
  assert.equal(r.status, 400);
});

test('return tracking requires an email to verify identity', async () => {
  const r = await fetch(`${BASE_URL}/api/returns/track/1`);
  assert.equal(r.status, 400);
});

// ---- Billing ----
test('billing plans lists all four tiers with expected prices', async () => {
  const r = await fetch(`${BASE_URL}/api/billing/plans`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.free.price, 0);
  assert.equal(d.starter.price, 11.99);
  assert.equal(d.growth.price, 23.99);
  assert.equal(d.pro.price, 47.99);
});

test('billing create requires a shop parameter', async () => {
  const r = await fetch(`${BASE_URL}/api/billing/create`, { redirect: 'manual' });
  assert.equal(r.status, 400);
});

// ---- Security headers (regression test for the CSP-injection fix earlier this session) ----
test('CSP frame-ancestors ignores an invalid ?shop= value instead of reflecting it', async () => {
  const r = await fetch(`${BASE_URL}/?shop=attacker.com`, { redirect: 'manual' });
  const csp = r.headers.get('content-security-policy') || '';
  assert.ok(!csp.includes('attacker.com'), `CSP should not reflect an invalid shop value, got: ${csp}`);
  assert.ok(csp.includes('*.myshopify.com'));
});
