// Production error monitoring via Sentry. Batch 5 Part 2.
//
// CRITICAL DESIGN REQUIREMENT: if SENTRY_DSN is not set, every exported function becomes a no-op
// and the app must start and run completely normally — monitoring is additive observability, never
// a hard dependency. Every function here is safe to call unconditionally from anywhere in the app
// without checking whether Sentry is actually configured.
//
// SECURITY: beforeSend below strips Shopify access/refresh tokens, password hashes, OTPs, and
// other credential-shaped fields from every event before it leaves the process — see
// scrubSensitiveData() for the exact fields. Never add raw customer PII (email, phone, name) to
// captured context; only shop_domain (not customer-identifying) and route/error metadata.

let Sentry = null;
let enabled = false;

const SENSITIVE_KEYS = [
  'access_token', 'refresh_token', 'token', 'session_token', 'password', 'password_hash',
  'otp', 'client_secret', 'api_key', 'client_id', 'shiprocket_password', 'shiprocket_token',
  'clickpost_api_key', 'shadowfax_client_secret', 'delhivery_api_key', 'xpressbees_api_token',
  'wareiq_client_secret', 'invite_token', 'authorization', 'cookie', 'x-auth-token'
];

// Customer-identifying fields we never want leaving the process via error telemetry, even
// though they aren't "credentials" — this is a Shopify merchant's customer's PII.
const PII_KEYS = ['customer_email', 'customer_name', 'customer_phone', 'email', 'phone', 'name'];

function scrubObject(obj, depth) {
  if (depth > 6 || obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(v => scrubObject(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const lowerKey = k.toLowerCase();
    if (SENSITIVE_KEYS.some(s => lowerKey.includes(s))) { out[k] = '[redacted]'; continue; }
    if (PII_KEYS.some(s => lowerKey === s)) { out[k] = '[redacted-pii]'; continue; }
    out[k] = typeof v === 'object' ? scrubObject(v, depth + 1) : v;
  }
  return out;
}

// Scrubs request data, extra context, and breadcrumbs on a Sentry event before it's sent.
function scrubSensitiveData(event) {
  if (event.request) {
    if (event.request.data) event.request.data = scrubObject(event.request.data, 0);
    if (event.request.headers) event.request.headers = scrubObject(event.request.headers, 0);
    if (event.request.cookies) event.request.cookies = '[redacted]';
    // Query strings can carry tokens (e.g. legacy CSV export ?token=) — scrub the whole string
    // rather than trying to parse+redact individual params.
    if (event.request.query_string) event.request.query_string = '[redacted]';
  }
  if (event.extra) event.extra = scrubObject(event.extra, 0);
  if (event.contexts) event.contexts = scrubObject(event.contexts, 0);
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(b => ({ ...b, data: b.data ? scrubObject(b.data, 0) : b.data }));
  }
  return event;
}

function initMonitoring(app) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('Monitoring: SENTRY_DSN not set — error monitoring disabled (app continues normally).');
    return;
  }
  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: 0, // errors only for now — no performance tracing, keeps this lightweight
      beforeSend(event) { return scrubSensitiveData(event); },
      beforeSendTransaction(event) { return scrubSensitiveData(event); }
    });
    enabled = true;
    console.log('Monitoring: Sentry initialized.');
  } catch (e) {
    // Never let a monitoring setup failure take down the app.
    console.error('Monitoring: failed to initialize Sentry, continuing without it:', e.message);
    Sentry = null;
    enabled = false;
  }
}

// Attaches request-id + shop_domain context and reports the error, then calls next(err) so
// Express's own error handling (and any route-specific catch blocks) still runs unchanged —
// this only ever adds observability, never alters response behavior.
function expressErrorHandler() {
  return (err, req, res, next) => {
    captureException(err, {
      route: req.path,
      method: req.method,
      shop_domain: req.query?.shop || req.body?.shop || req.body?.shop_domain || undefined,
      request_id: req.headers['x-request-id'] || undefined
    });
    next(err);
  };
}

// Manual capture with structured context — used from webhook handlers, DB failure paths, and
// Shopify API failure paths that already catch their own errors and handle the response, but
// still want the failure recorded for observability.
function captureException(err, context) {
  if (!enabled || !Sentry) return;
  try {
    Sentry.withScope(scope => {
      if (context) {
        const safeContext = scrubObject(context, 0);
        scope.setContext('app', safeContext);
        if (safeContext.shop_domain) scope.setTag('shop_domain', safeContext.shop_domain);
        if (safeContext.route) scope.setTag('route', safeContext.route);
        if (safeContext.error_type) scope.setTag('error_type', safeContext.error_type);
      }
      Sentry.captureException(err);
    });
  } catch (e) { console.error('Monitoring: captureException failed:', e.message); }
}

function captureMessage(message, context) {
  if (!enabled || !Sentry) return;
  try {
    Sentry.withScope(scope => {
      if (context) scope.setContext('app', scrubObject(context, 0));
      Sentry.captureMessage(message);
    });
  } catch (e) { console.error('Monitoring: captureMessage failed:', e.message); }
}

function isEnabled() { return enabled; }

module.exports = { initMonitoring, expressErrorHandler, captureException, captureMessage, isEnabled, scrubSensitiveData };
