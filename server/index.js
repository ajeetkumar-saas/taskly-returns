require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const bcrypt = require('bcryptjs');

let lastExchange = { stage: 'none' };

// Previously a crash was completely silent — Railway restarts the process, but nobody is told
// it happened. These email the owner before the process exits (uncaughtException) or continues
// with a swallowed promise rejection (unhandledRejection), using the same notifyAdmin() pattern
// used elsewhere for install/uninstall alerts. Kept deliberately minimal (no new dependency) —
// notifyAdmin/sendEmail are function declarations further down and are hoisted, so this is safe
// to register this early even though they're defined later in the file.
let lastCrashAlertAt = 0;
const CRASH_ALERT_THROTTLE_MS = 10 * 60 * 1000; // avoid an email storm if something crash-loops
function alertCrash(kind, err) {
  const now = Date.now();
  console.error(`[${kind}]`, err);
  monitoring.captureException(err instanceof Error ? err : new Error(String(err)), { error_type: kind });
  if (now - lastCrashAlertAt < CRASH_ALERT_THROTTLE_MS) return;
  lastCrashAlertAt = now;
  try {
    notifyAdmin(`🚨 GoReturn ${kind}`, `<p><strong>${kind}</strong> at ${new Date().toUTCString()}</p><pre style="white-space:pre-wrap;font-size:12px;color:#555">${(err?.stack || String(err)).substring(0, 2000)}</pre>`).catch(()=>{});
  } catch(e) { /* never let alerting itself crash the process */ }
}
process.on('uncaughtException', (err) => alertCrash('Uncaught Exception', err));
process.on('unhandledRejection', (err) => alertCrash('Unhandled Rejection', err));

// Production error monitoring (Sentry) — Batch 5 Part 2. Gracefully disables itself if
// SENTRY_DSN isn't set (see server/lib/monitoring.js); every call here is safe unconditionally.
const monitoring = require('./lib/monitoring');

// AES-256-GCM encryption for sensitive credentials (Shiprocket passwords) stored in DB.
// Extracted to server/lib/crypto.js (Batch 4 Step 1a) — behavior unchanged, verbatim move.
const { encryptCredential, decryptCredential } = require('./lib/crypto');
// Email sending + admin alerting. Extracted to server/lib/email.js (Batch 4 Step 1b) —
// behavior unchanged, verbatim move.
const { sendEmail, notifyAdmin, getLastEmailError, ALLOWED_ADMIN_EMAIL } = require('./lib/email');

// returnStatusEmail, DEFAULT_EMAIL_TEMPLATES, getEmailTemplates, fillPlaceholders extracted to
// server/lib/emailTemplates.js (Batch 4 Step 2, prep for Group 4) — behavior unchanged.
const { returnStatusEmail, DEFAULT_EMAIL_TEMPLATES, getEmailTemplates, fillPlaceholders } = require('./lib/emailTemplates');

const app = express();
monitoring.initMonitoring(app);
// All real API calls in this app are same-origin (pages served by goreturn.pro calling its own
// /api/* routes) — there's no legitimate cross-origin fetch use case, so CORS is restricted to
// the app's own domain and Shopify's admin (covers the embedded App Bridge context) instead of
// the previous open `*` default, which let any website make authenticated-looking requests here.
const ALLOWED_ORIGINS = [process.env.APP_URL || 'https://goreturn.pro', 'https://admin.shopify.com'].filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // non-browser callers (curl, webhooks, server-to-server)
    if (ALLOWED_ORIGINS.includes(origin) || /^https:\/\/[a-z0-9-]+\.myshopify\.com$/.test(origin)) return cb(null, true);
    cb(null, false);
  },
  credentials: false
}));
// Allow embedding inside Shopify Admin iframe (required for App Bridge). The ?shop= value must
// be validated before going into the CSP header — passing it through unchecked would let anyone
// set frame-ancestors to their own origin via ?shop=attacker.com, defeating clickjacking
// protection entirely for that response.
app.use((req, res, next) => {
  const shop = req.query.shop;
  const isValidShop = typeof shop === 'string' && /^[a-z0-9-]+\.myshopify\.com$/.test(shop);
  const allowShop = isValidShop ? `https://${shop}` : 'https://*.myshopify.com';
  res.setHeader('Content-Security-Policy', `frame-ancestors ${allowShop} https://admin.shopify.com;`);
  res.removeHeader('X-Frame-Options');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Error-rate alerting: previously a crash or a spike in 500s was completely silent — nobody
// would know until a merchant complained. Tracks 5xx responses in a rolling window and emails
// the owner once (throttled) if they cross a threshold, using the same notifyAdmin() pattern
// already used for install/uninstall.
let recentErrorCount = 0;
let errorWindowStart = Date.now();
let lastErrorAlertAt = 0;
const ERROR_WINDOW_MS = 5 * 60 * 1000;
const ERROR_ALERT_THRESHOLD = 10;
const ERROR_ALERT_THROTTLE_MS = 30 * 60 * 1000;
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode < 500) return;
    const now = Date.now();
    if (now - errorWindowStart > ERROR_WINDOW_MS) { recentErrorCount = 0; errorWindowStart = now; }
    recentErrorCount++;
    if (recentErrorCount >= ERROR_ALERT_THRESHOLD && now - lastErrorAlertAt > ERROR_ALERT_THROTTLE_MS) {
      lastErrorAlertAt = now;
      notifyAdmin('🚨 GoReturn High Error Rate', `<p><strong>${recentErrorCount}</strong> server errors (5xx) in the last ${ERROR_WINDOW_MS/60000} minutes.</p><p>Latest: ${req.method} ${req.path} → ${res.statusCode}</p><p>Time: ${new Date().toUTCString()}</p>`).catch(()=>{});
    }
  });
  next();
});

// Lightweight in-memory rate limiter (no extra dependency, fine for a single Railway instance).
// Protects against abuse/spam since there was previously zero request throttling anywhere.
const rateBuckets = new Map();
function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const key = (req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown').split(',')[0].trim() + ':' + req.path;
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start > windowMs) { bucket = { count: 0, start: now }; rateBuckets.set(key, bucket); }
    bucket.count++;
    if (bucket.count > maxRequests) return res.status(429).json({ error: 'Too many requests, please slow down and try again shortly.' });
    next();
  };
}
// Per-shop variant: keyed by shop_domain (not caller IP), so one shop can't be spammed from
// many/rotating IPs and one attacker can't exhaust a shared IP's budget across unrelated shops.
function rateLimitByShop(maxRequests, windowMs) {
  return (req, res, next) => {
    const shop = req.query.shop || req.body?.shop_domain || req.body?.shop || 'unknown';
    const key = 'shop:' + shop + ':' + req.path;
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start > windowMs) { bucket = { count: 0, start: now }; rateBuckets.set(key, bucket); }
    bucket.count++;
    if (bucket.count > maxRequests) return res.status(429).json({ error: 'Too many requests for this store, please slow down and try again shortly.' });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of rateBuckets) if (now - v.start > 10 * 60 * 1000) rateBuckets.delete(k); }, 5 * 60 * 1000);
app.use('/api/', rateLimit(180, 60 * 1000)); // generous default cap for all API traffic
app.use('/api/returns', rateLimit(20, 60 * 1000)); // stricter cap on return submissions specifically
app.use('/api/returns', rateLimitByShop(40, 60 * 1000)); // per-shop cap in addition to per-IP, since a public/anonymous storefront endpoint could otherwise be spammed for one shop from many rotating IPs
app.use('/api/admin/login', rateLimit(10, 60 * 1000)); // brute-force protection on login
app.use('/api/admin/verify-otp', rateLimit(10, 60 * 1000)); // prevent OTP brute force
app.use('/api/shiprocket', rateLimit(15, 60 * 1000)); // prevent courier API quota burn
app.use('/api/shiprocket', rateLimitByShop(30, 60 * 1000)); // per-shop cap — Shiprocket bills per API call, so this is the actual Denial-of-Wallet guard
app.use('/api/logistics', rateLimitByShop(30, 60 * 1000)); // same Denial-of-Wallet concern for other courier providers
app.use('/api/logistics', rateLimit(15, 60 * 1000)); // prevent courier API quota burn
app.use('/api/team', rateLimit(30, 60 * 1000)); // team invite/edit/delete had no dedicated cap beyond the generous 180/min global default
app.use('/api/billing/create', rateLimitByShop(10, 60 * 1000)); // each call creates a real pending Shopify charge — cap spam-creation per shop
app.use('/api/upload-image', rateLimitByShop(60, 60 * 1000)); // storage-exhaustion guard noted in the earlier audit — generous enough that multiple customers uploading return photos simultaneously won't hit it, just blocks obvious abuse

// Postgres pool. Extracted to server/lib/db.js (Batch 4 Step 1c) — behavior unchanged, verbatim
// move (including the pool.on('error') handler). require() caches modules, so this is the same
// singleton Pool instance everywhere it's required.
const pool = require('./lib/db');

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_APP_SHARED_SECRET;
const APP_URL = process.env.APP_URL || 'http://localhost:3001';
// SHIPROCKET_EMAIL/PASSWORD/BASE, getShiprocketToken, shiprocketAPI, getSellerShiprocketToken,
// sellerShiprocketAPI, createShiprocketPickup all now in server/routes/logistics.js
// (Batch 5 Part 1, Domain 1) — behavior unchanged. /api/health below reads
// process.env.SHIPROCKET_EMAIL directly (same value).

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopify_stores (
      id SERIAL PRIMARY KEY,
      shop_domain VARCHAR(255) UNIQUE NOT NULL,
      access_token TEXT NOT NULL,
      store_name VARCHAR(255) DEFAULT '',
      store_email VARCHAR(255) DEFAULT '',
      plan VARCHAR(50) DEFAULT 'starter',
      created_at TIMESTAMP DEFAULT NOW()
    );`);
  // Token rotation columns (idempotent). Force token_expires_at to BIGINT (epoch ms).
  await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS refresh_token TEXT DEFAULT ''`).catch(e=>console.log('alter refresh_token:',e.message));
  await pool.query(`ALTER TABLE shopify_stores DROP COLUMN IF EXISTS token_expires_at`).catch(e=>console.log('drop token_expires_at:',e.message));
  await pool.query(`ALTER TABLE shopify_stores ADD COLUMN token_expires_at BIGINT DEFAULT 0`).catch(e=>console.log('add token_expires_at:',e.message));
  await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP DEFAULT NULL`).catch(e=>console.log('add trial_ends_at:',e.message));
await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS custom_price NUMERIC(10,2) DEFAULT NULL`).catch(e=>console.log('add custom_price:',e.message));
  await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS custom_returns_limit INTEGER DEFAULT NULL`).catch(e=>console.log('add custom_returns_limit:',e.message));
  await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS custom_features JSONB DEFAULT NULL`).catch(e=>console.log('add custom_features:',e.message));
  // Persists the Shopify recurring_application_charge id so we can later re-check its live
  // status (cancelled/declined/expired) — previously charge_id was only used transiently during
  // /api/billing/confirm and never stored, so there was no way to detect billing changes after
  // the fact.
  await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS billing_charge_id VARCHAR(255) DEFAULT NULL`).catch(e=>console.log('add billing_charge_id:',e.message));
    await pool.query(`
    CREATE TABLE IF NOT EXISTS returns (
      id SERIAL PRIMARY KEY,
      shop_domain VARCHAR(255) DEFAULT '',
      order_id VARCHAR(255),
      order_number VARCHAR(255) DEFAULT '',
      customer_name VARCHAR(255),
      customer_email VARCHAR(255),
      customer_phone VARCHAR(50) DEFAULT '',
      product_name TEXT,
      product_sku VARCHAR(255) DEFAULT '',
      quantity INTEGER DEFAULT 1,
      reason TEXT,
      reason_detail TEXT DEFAULT '',
      status VARCHAR(50) DEFAULT 'pending',
      refund_method VARCHAR(50) DEFAULT 'original',
      amount NUMERIC(10,2) DEFAULT 0,
      tracking_number VARCHAR(255) DEFAULT '',
      pickup_status VARCHAR(50) DEFAULT '',
      merchant_notes TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  try {
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS order_number VARCHAR(255) DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(50) DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS product_sku VARCHAR(255) DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS reason_detail TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(255) DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS pickup_status VARCHAR(50) DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS merchant_notes TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS store_name VARCHAR(255) DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS store_email VARCHAR(255) DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS plan VARCHAR(50) DEFAULT 'starter'`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS shiprocket_email VARCHAR(255) DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS shiprocket_password TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS shiprocket_token TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS shiprocket_connected BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS shiprocket_auto_pickup BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS shiprocket_pickup_location TEXT DEFAULT ''`);
    // ClickPost
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS clickpost_api_key TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS clickpost_connected BOOLEAN DEFAULT false`);
    // Shadowfax
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS shadowfax_client_id TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS shadowfax_client_secret TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS shadowfax_connected BOOLEAN DEFAULT false`);
    // Delhivery
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS delhivery_api_key TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS delhivery_connected BOOLEAN DEFAULT false`);
    // XpressBees
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS xpressbees_api_token TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS xpressbees_connected BOOLEAN DEFAULT false`);
    // WareIQ
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS wareiq_client_id TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS wareiq_client_secret TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS wareiq_connected BOOLEAN DEFAULT false`);
    // Logistics config
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS default_logistics VARCHAR(50) DEFAULT 'shiprocket'`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS logistics_auto_pickup BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS portal_color VARCHAR(20) DEFAULT '#4F46E5'`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS portal_banner TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS return_window INTEGER DEFAULT 14`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS exchange_window INTEGER DEFAULT 14`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS auto_approve_under NUMERIC(10,2) DEFAULT 0`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS notify_email BOOLEAN DEFAULT true`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'return'`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS exchange_product TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS exchange_variant TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS inspected_at TIMESTAMP`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMP`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS risk_level VARCHAR(20) DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS images TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS line_items TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS refund_status VARCHAR(20) DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS shopify_refund_id VARCHAR(255) DEFAULT ''`);
    await pool.query(`CREATE TABLE IF NOT EXISTS store_settings (
      id SERIAL PRIMARY KEY,
      shop_domain VARCHAR(255) UNIQUE NOT NULL,
      return_reasons TEXT DEFAULT 'Damaged Product,Wrong Item Received,Size/Fit Issue,Quality Not As Expected,Not As Described,Changed My Mind',
      exchange_reasons TEXT DEFAULT 'Wrong Size,Wrong Color,Want Different Product',
      refund_methods TEXT DEFAULT 'Original Payment Method',
      notification_emails TEXT DEFAULT '',
      auto_approve_enabled BOOLEAN DEFAULT false,
      auto_approve_amount NUMERIC(10,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name VARCHAR(255) DEFAULT '',
      role VARCHAR(50) DEFAULT 'admin',
      shop_domain VARCHAR(255) DEFAULT '',
      session_token TEXT DEFAULT '',
      last_login TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS team_members (
      id SERIAL PRIMARY KEY,
      shop_domain VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      password_hash TEXT DEFAULT '',
      role VARCHAR(50) DEFAULT 'viewer',
      status VARCHAR(20) DEFAULT 'invited',
      session_token TEXT DEFAULT '',
      invite_token TEXT DEFAULT '',
      last_login TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(shop_domain, email)
    )`);
  await pool.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS invite_token TEXT DEFAULT ''`).catch(()=>{});
    await pool.query(`CREATE TABLE IF NOT EXISTS activity_log (
      id SERIAL PRIMARY KEY,
      user_name VARCHAR(255) DEFAULT '',
      user_email VARCHAR(255) DEFAULT '',
      user_role VARCHAR(50) DEFAULT '',
      action VARCHAR(255) NOT NULL,
      details TEXT DEFAULT '',
      ip_address VARCHAR(50) DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    // Indexes — none existed anywhere before this. At today's data volume these build instantly
    // (milliseconds, brief write-lock only), but shop_domain/session_token are the WHERE clause
    // of nearly every query and every authenticated request respectively, so this matters
    // increasingly as returns/merchants grow. Purely additive — no table structure or existing
    // data is touched, IF NOT EXISTS makes this safe to run on every boot.
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_returns_shop_domain ON returns(shop_domain)`).catch(e=>console.log('idx_returns_shop_domain:',e.message));
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_returns_shop_order ON returns(shop_domain, order_id)`).catch(e=>console.log('idx_returns_shop_order:',e.message));
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_returns_customer_email ON returns(customer_email)`).catch(e=>console.log('idx_returns_customer_email:',e.message));
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_team_members_session_token ON team_members(session_token)`).catch(e=>console.log('idx_team_members_session_token:',e.message));
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_users_session_token ON admin_users(session_token)`).catch(e=>console.log('idx_admin_users_session_token:',e.message));
  } catch(e) {}
  console.log('DB ready');
}

// Extracted to server/lib/activityLog.js (Batch 4 Step 1d) — behavior unchanged, verbatim move.
const { logActivity } = require('./lib/activityLog');

// hashPassword, legacyHashPassword, verifyPassword, authenticateRequest, requireOwner,
// checkSessionTimeout, requireShopAccess, requirePlan all now imported from ./lib/auth
// (Batch 4 Step 1f) — behavior unchanged, verbatim move.
const {
  hashPassword,
  legacyHashPassword,
  verifyPassword,
  authenticateRequest,
  requireOwner,
  checkSessionTimeout,
  requireShopAccess,
  requirePlan
} = require('./lib/auth');

// ALLOWED_ADMIN_EMAIL and notifyAdmin() now imported from ./lib/email (Batch 4 Step 1b).

// Admin auth (register/login/OTP/session/logout) + team member CRUD extracted to
// server/routes/adminAuth.js (Batch 4 Step 2, Group 2a) — behavior unchanged, verbatim move.
require('./routes/adminAuth').registerAdminAuthRoutes(app);

// verifyShopifySessionToken, verifyShopifyHmac, refreshAccessToken, attemptReauth,
// getStoreToken, shopifyFetch, shopifyFetchAllPages, getValidToken all now imported from
// ./lib/shopify (Batch 4 Step 1e) — behavior unchanged, verbatim move.
const {
  verifyShopifySessionToken,
  verifyShopifyHmac,
  refreshAccessToken,
  attemptReauth,
  getValidToken,
  getStoreToken,
  shopifyFetch,
  shopifyFetchAllPages
} = require('./lib/shopify');

// Token exchange - convert App Bridge session token to EXPIRING offline access token
app.post('/api/auth/token-exchange', async (req, res) => {
  const { shop, sessionToken } = req.body;
  lastExchange = { at: new Date().toISOString(), shop, token_len: sessionToken?.length || 0, stage: 'received' };
  if (!shop || !sessionToken) { lastExchange.stage = 'missing-params'; return res.status(400).json({ error: 'shop and sessionToken required' }); }
  try {
    console.log('Token exchange attempt:', { shop, token_len: sessionToken?.length });
    const params = new URLSearchParams({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: sessionToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: '1'
    });
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: params.toString()
    });
    const text = await r.text();
    // Never log/store the raw response body here — it contains the plaintext access_token.
    // Redact before logging or persisting to the (DEBUG_KEY-gated but still readable) lastExchange.
    const redactedText = text.replace(/"access_token"\s*:\s*"[^"]*"/, '"access_token":"[redacted]"');
    console.log('Token exchange response:', r.status, redactedText.substring(0, 250));
    lastExchange.shopify_status = r.status; lastExchange.shopify_resp = redactedText.substring(0, 250); lastExchange.stage = 'shopify-responded';
    let d;
    try { d = JSON.parse(text); } catch(e) { lastExchange.stage = 'parse-fail'; return res.status(400).json({ error: 'Invalid response from Shopify', status: r.status, body: redactedText.substring(0, 200) }); }
    if (d.access_token) {
      const expiresAt = d.expires_in ? Date.now() + (d.expires_in * 1000) : 0;
      lastExchange.stage = 'success'; lastExchange.token_prefix = d.access_token.substring(0,10); lastExchange.expires_in = d.expires_in; lastExchange.has_refresh = !!d.refresh_token;
      console.log('Token exchange SUCCESS:', { shop, token_prefix: d.access_token.substring(0,10), expires_in: d.expires_in, has_refresh: !!d.refresh_token });
      let storeName = shop, storeEmail = '';
      try {
        const shopInfo = await fetch(`https://${shop}/admin/api/2025-04/shop.json`, { headers: { 'X-Shopify-Access-Token': d.access_token } });
        const shopData = await shopInfo.json();
        storeName = shopData.shop?.name || shop;
        storeEmail = shopData.shop?.email || '';
      } catch(e) {}
      // Detect NEW install (store not already in DB) for install alert email
      let isNewInstall = false;
      try { const ex = await pool.query('SELECT 1 FROM shopify_stores WHERE shop_domain=$1', [shop]); isNewInstall = ex.rows.length === 0; } catch(e) {}
      try {
        await pool.query(
          'INSERT INTO shopify_stores (shop_domain, access_token, refresh_token, token_expires_at, store_name, store_email) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (shop_domain) DO UPDATE SET access_token=$2, refresh_token=$3, token_expires_at=$4, store_name=$5, store_email=$6',
          [shop, encryptCredential(d.access_token), encryptCredential(d.refresh_token || ''), expiresAt, storeName, storeEmail]
        );
        lastExchange.db = 'saved';
        if (isNewInstall) {
          notifyAdmin('🎉 New GoReturn Install', `<p><strong>${storeName}</strong> (${shop}) just installed GoReturn.</p><p>Store email: ${storeEmail || 'N/A'}</p><p>Time: ${new Date().toUTCString()}</p>`);
        }
      } catch(dbErr) {
        lastExchange.db = 'FAILED: ' + dbErr.message;
        try { await pool.query('UPDATE shopify_stores SET access_token=$1 WHERE shop_domain=$2', [encryptCredential(d.access_token), shop]); lastExchange.db += ' | fallback-saved'; } catch(e2) { lastExchange.db += ' | fallback-failed:'+e2.message; }
      }
      res.json({ ok: true, shop: storeName, expires_in: d.expires_in, expiring: !!d.refresh_token });
    } else {
      console.log('Token exchange no token, error:', d.error || d.error_description || 'unknown');
      res.status(400).json({ error: 'No access_token in response' });
    }
  } catch(e) { console.log('Token exchange error:', e.message); res.status(500).json({ error: 'Token exchange failed' }); }
});

// OAuth CSRF protection: the `state` nonce sent on the install redirect must match what we
// generated for that shop when the callback comes back, and can only be used once. Without
// this, an attacker could trick a merchant into completing an OAuth flow initiated by the
// attacker (connecting the attacker's intended store/scope to the victim's session).
const oauthNonces = new Map();
function issueOAuthNonce(shop) {
  const nonce = crypto.randomBytes(16).toString('hex');
  oauthNonces.set(shop, { nonce, expires: Date.now() + 10 * 60 * 1000 });
  return nonce;
}
function verifyOAuthNonce(shop, state) {
  const entry = oauthNonces.get(shop);
  oauthNonces.delete(shop); // one-time use regardless of outcome
  if (!entry || Date.now() > entry.expires) return false;
  try { return crypto.timingSafeEqual(Buffer.from(entry.nonce), Buffer.from(state || '')); } catch(e) { return false; }
}
setInterval(() => { const now = Date.now(); for (const [k, v] of oauthNonces) if (now > v.expires) oauthNonces.delete(k); }, 5 * 60 * 1000);

// OAuth (legacy fallback)
app.get('/api/auth/shopify', (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  const nonce = issueOAuthNonce(shop);
  const redirectUri = encodeURIComponent(`${APP_URL}/api/auth/callback`);
  const scopes = 'read_orders,write_orders,read_customers,read_products,read_inventory';
  res.redirect(`https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=${scopes}&redirect_uri=${redirectUri}&state=${nonce}`);
});

app.get('/api/auth/callback', async (req, res) => {
  const { shop, code, hmac, ...rest } = req.query;
  if (!shop || !code) return res.status(400).send('Missing params');
  if (hmac && SHOPIFY_CLIENT_SECRET) {
    const params = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('&') + (Object.keys(rest).length ? '&' : '') + `code=${code}&shop=${shop}&state=${req.query.state || ''}&timestamp=${req.query.timestamp || ''}`;
    const sortedParams = Object.entries(req.query).filter(([k]) => k !== 'hmac').sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('&');
    const digest = crypto.createHmac('sha256', SHOPIFY_CLIENT_SECRET).update(sortedParams).digest('hex');
    if (digest !== hmac) return res.status(403).send('HMAC verification failed');
  }
  // Only enforce state-nonce verification if we actually issued one for this shop (keeps
  // Shopify's own direct app-install entry point, which doesn't go through our redirect, working).
  if (oauthNonces.has(shop) && !verifyOAuthNonce(shop, req.query.state)) {
    return res.status(403).send('Invalid or expired OAuth state — please reinstall the app');
  }
  try {
    // Request an EXPIRING token via authorization code grant (expiring=1)
    const tokenParams = new URLSearchParams({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, code, expiring: '1' });
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: tokenParams.toString()
    });
    const tokenData = await r.json();
    let access_token = tokenData.access_token;
    const expiresAt = tokenData.expires_in ? Date.now() + (tokenData.expires_in * 1000) : 0;
    console.log('OAuth token received:', { shop, token_type: access_token?.substring(0,5), expires_in: tokenData.expires_in, has_refresh: !!tokenData.refresh_token });

    let storeName = shop, storeEmail = '';
    try {
      const shopInfo = await fetch(`https://${shop}/admin/api/2025-04/shop.json`, {
        headers: { 'X-Shopify-Access-Token': access_token }
      });
      const shopData = await shopInfo.json();
      storeName = shopData.shop?.name || shop;
      storeEmail = shopData.shop?.email || '';
    } catch(e) {}
    try {
      await pool.query(
        'INSERT INTO shopify_stores (shop_domain, access_token, refresh_token, token_expires_at, store_name, store_email) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (shop_domain) DO UPDATE SET access_token=$2, refresh_token=$3, token_expires_at=$4, store_name=$5, store_email=$6',
        [shop, encryptCredential(access_token), encryptCredential(tokenData.refresh_token || ''), expiresAt, storeName, storeEmail]
      );
    } catch(e) {
      await pool.query('UPDATE shopify_stores SET access_token=$1 WHERE shop_domain=$2', [encryptCredential(access_token), shop]).catch(()=>{});
    }

    // Register Shopify webhooks needed for sync (idempotent — Shopify deduplicates by topic+address).
    // Note: GDPR webhooks (customers/data_request, customers/redact, shop/redact) are also declared
    // in shopify.app.toml privacy_compliance section and auto-registered by Shopify, but we register
    // them explicitly here to ensure they're always set up, even if Shopify's auto-registration fails.
    try {
      const webhookTopics = [
        'refunds/create',
        'app/uninstalled',
        'customers/data_request',
        'customers/redact',
        'shop/redact'
      ];
      const webhookUrls = {
        'refunds/create': `${APP_URL}/api/webhooks/shopify/refunds-create`,
        'app/uninstalled': `${APP_URL}/api/webhooks/app-uninstalled`,
        'customers/data_request': `${APP_URL}/api/webhooks/customers/data_request`,
        'customers/redact': `${APP_URL}/api/webhooks/customers/redact`,
        'shop/redact': `${APP_URL}/api/webhooks/shop/redact`
      };
      for (const topic of webhookTopics) {
        const address = webhookUrls[topic];
        await fetch(`https://${shop}/admin/api/2025-04/webhooks.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': access_token },
          body: JSON.stringify({ webhook: { topic, address, format: 'json' } })
        });
      }
    } catch(e) { console.log('Webhook registration warning:', e.message); }

    const plan = req.query.plan || 'starter';
    if (plan === 'free_trial' || plan === 'free') {
      res.redirect(`/?shop=${shop}`);
    } else {
      res.redirect(`/api/billing/create?shop=${shop}&plan=${plan}`);
    }
  } catch(e) { res.status(500).send('OAuth error: ' + e.message); }
});

// Billing
// PLANS extracted to server/lib/plans.js (Batch 4 Step 2, preparatory) — behavior unchanged.
const { PLANS } = require('./lib/plans');

// Billing routes (create/confirm/plans) extracted to server/routes/billing.js
// (Batch 4 Step 2, Group 3) — behavior unchanged, verbatim move. Offers/redeem also moved
// there (see below, was previously right after admin plan routes).
require('./routes/billing').registerBillingRoutes(app);

// Stores
app.get('/api/shopify/stores', async (req, res, next) => {
  // With ?shop= param: validate via requireShopAccess (accepts embedded app
  // Bearer token OR x-auth-token — real sellers only have the Bearer token).
  // Without ?shop=: owner login required.
  const { shop } = req.query;
  if (shop) {
    return requireShopAccess(req, res, next);
  }

  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  // All stores: owner only
  const admin = await pool.query('SELECT * FROM admin_users WHERE session_token=$1', [token]);
  if (!admin.rows.length || admin.rows[0].role !== 'owner') {
    return res.status(403).json({ error: 'Owner access required' });
  }
  req.user = admin.rows[0];
  next();
}, async (req, res) => {
  const { shop } = req.query;
  try {
    if (shop) {
      const r = await pool.query('SELECT shop_domain, store_name, store_email, plan, created_at, trial_ends_at, custom_price, custom_returns_limit, custom_features FROM shopify_stores WHERE shop_domain=$1', [shop]);
      return res.json(r.rows);
    }
    const r = await pool.query('SELECT shop_domain, store_name, store_email, plan, created_at, trial_ends_at, custom_price, custom_returns_limit, custom_features FROM shopify_stores ORDER BY created_at DESC');
    res.json(r.rows);
  } catch(e) {
    console.log('stores endpoint error:', e.message);
    res.status(500).json({ error: 'Failed to fetch stores' });
  }
});

// Orders from Shopify
app.get('/api/shopify/orders', async (req, res) => {
  const { shop, all } = req.query;

  // For 'all' requests (admin "All Stores" view): owner auth via x-auth-token,
  // same pattern as GET /api/shopify/stores
  if (all === 'true') {
    const token = req.headers['x-auth-token'];
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    const admin = await pool.query('SELECT * FROM admin_users WHERE session_token=$1', [token]);
    if (!admin.rows.length || admin.rows[0].role !== 'owner') {
      return res.status(403).json({ error: 'Owner access required' });
    }

    try {
      const sr = await pool.query('SELECT shop_domain FROM shopify_stores ORDER BY created_at DESC');
      if (!sr.rows.length) return res.json([]);

      let allOrders = [];
      for (const store of sr.rows) {
        try {
          const tok = await getValidToken(store.shop_domain);
          if (!tok) continue;
          const r = await fetch(`https://${store.shop_domain}/admin/api/2025-04/orders.json?status=any&limit=50`, {
            headers: { 'X-Shopify-Access-Token': tok }
          });
          if (r.ok) {
            const d = await r.json();
            const orders = (d.orders || []).map(o => ({ ...o, shop_domain: store.shop_domain }));
            allOrders = allOrders.concat(orders);
          }
        } catch(e) {
          console.log(`Error fetching orders for ${store.shop_domain}:`, e.message);
        }
      }
      // Newest first across all stores (each store's list is sorted, but concatenation isn't)
      allOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return res.json(allOrders);
    } catch(e) {
      console.log('all orders fetch error:', e.message);
      return res.status(500).json({ error: 'Failed to fetch orders' });
    }
  }

  // For single shop requests, use requireShopAccess middleware
  requireShopAccess(req, res, async () => {
    if (!shop) return res.status(400).json({ error: 'shop required' });
    const sr = await getStoreToken(shop);
    if (!sr.rows.length) return res.status(404).json({ error: 'Store not connected. Open GoReturn in Shopify Admin first.' });
    try {
      const r = await shopifyFetch(`https://${shop}/admin/api/2025-04/orders.json?status=any&limit=50`, {
        headers: { 'X-Shopify-Access-Token': sr.rows[0].access_token }
      });
      if (r.status === 401 || r.status === 403) {
        const reauth = await attemptReauth(shop);
        if (reauth) {
          const retry = await shopifyFetch(`https://${shop}/admin/api/2025-04/orders.json?status=any&limit=50`, {
            headers: { 'X-Shopify-Access-Token': reauth }
          });
          if (retry.ok) { const rd = await retry.json(); return res.json(rd.orders || []); }
        }
        return res.status(503).json({ error: 'Store connection expired. Open GoReturn in Shopify Admin to reconnect.' });
      }
      const d = await r.json();
      res.json(d.orders || []);
    } catch(e) { console.log('orders fetch error:', e.message); res.status(500).json({ error: 'Failed to fetch orders' }); }
  });
});

// Core return/customer routes (order-lookup, refund processing, returns CRUD/stats) extracted
// to server/routes/returns.js (Batch 4 Step 2, Group 4) — behavior unchanged, verbatim move.
require('./routes/returns').registerReturnRoutes(app);

// Analytics routes (/api/analytics, /api/analytics/orders, /api/analytics/returns-deep,
// /api/analytics/fraud, /api/analytics/pincode-risk) extracted to server/routes/analytics.js
// (Batch 5 Part 1, Domain 2) — behavior unchanged, verbatim move.
require('./routes/analytics').registerAnalyticsRoutes(app);

// /api/returns/export moved to server/routes/returns.js (Batch 4 Step 2, Group 4).

// Store configuration routes (portal-settings, settings, email-templates) extracted to
// server/routes/settings.js (Batch 5 Part 1, Domain 3) — behavior unchanged, verbatim move.
require('./routes/settings').registerSettingsRoutes(app);

// POST /api/returns (create) moved to server/routes/returns.js (Batch 4 Step 2, Group 4).
// PATCH /api/returns/:id (approve/reject/status flow), Shiprocket integration, and
// multi-logistics-provider routes extracted to server/routes/logistics.js
// (Batch 5 Part 1, Domain 1) — behavior unchanged, verbatim move.
require('./routes/logistics').registerLogisticsRoutes(app);

// Admin APIs — gated by requireOwner (real logged-in session), not a shared secret

// Admin plan-management routes (change-plan, free-access, custom-plans CRUD, offers CRUD)
// extracted to server/routes/adminPlans.js (Batch 4 Step 2, Group 2b) — behavior unchanged,
// verbatim move.
require('./routes/adminPlans').registerAdminPlanRoutes(app);

// /api/offers/redeem moved to server/routes/billing.js (Batch 4 Step 2, Group 3).

// /api/analytics/fraud and /api/analytics/pincode-risk moved to server/routes/analytics.js
// (Batch 5 Part 1, Domain 2).

// /api/upload-image and /api/returns/:id/images moved to server/routes/returns.js
// (Batch 4 Step 2, Group 4).

// Automation Rules (Wonder Bot)
app.get('/api/automation/rules', requirePlan('growth','automation'), async (req, res) => {
  const { shop } = req.query;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS automation_rules (
      id SERIAL PRIMARY KEY, shop_domain VARCHAR(255), name VARCHAR(255),
      condition_field VARCHAR(50), condition_operator VARCHAR(20), condition_value TEXT,
      action_type VARCHAR(50), action_value TEXT, active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    const r = await pool.query('SELECT * FROM automation_rules WHERE shop_domain=$1 ORDER BY created_at DESC', [shop||'']);
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

app.post('/api/automation/rules', requirePlan('growth','automation'), async (req, res) => {
  const { shop, name, condition_field, condition_operator, condition_value, action_type, action_value } = req.body;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS automation_rules (
      id SERIAL PRIMARY KEY, shop_domain VARCHAR(255), name VARCHAR(255),
      condition_field VARCHAR(50), condition_operator VARCHAR(20), condition_value TEXT,
      action_type VARCHAR(50), action_value TEXT, active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    const r = await pool.query('INSERT INTO automation_rules (shop_domain,name,condition_field,condition_operator,condition_value,action_type,action_value) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [shop,name,condition_field,condition_operator,condition_value,action_type,action_value]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/automation/rules/:id', requirePlan('growth','automation'), async (req, res) => {
  await pool.query('DELETE FROM automation_rules WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Promotions (Wonder Promotions - incentivize exchange over refund)
app.get('/api/promotions', requirePlan('growth','promotions'), async (req, res) => {
  const { shop } = req.query;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS promotions (
      id SERIAL PRIMARY KEY, shop_domain VARCHAR(255), name VARCHAR(255),
      type VARCHAR(50) DEFAULT 'store_credit_bonus', bonus_percent INTEGER DEFAULT 10,
      message TEXT DEFAULT 'Choose exchange and get 10% bonus store credit!',
      active BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW()
    )`);
    const r = await pool.query('SELECT * FROM promotions WHERE shop_domain=$1', [shop||'']);
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

app.post('/api/promotions', requirePlan('growth','promotions'), async (req, res) => {
  const { shop, name, type, bonus_percent, message } = req.body;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS promotions (
      id SERIAL PRIMARY KEY, shop_domain VARCHAR(255), name VARCHAR(255),
      type VARCHAR(50) DEFAULT 'store_credit_bonus', bonus_percent INTEGER DEFAULT 10,
      message TEXT, active BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW()
    )`);
    const r = await pool.query('INSERT INTO promotions (shop_domain,name,type,bonus_percent,message) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [shop,name||'Exchange Bonus',type||'store_credit_bonus',bonus_percent||10,message||'']);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/promotions/:id', requirePlan('growth','promotions'), async (req, res) => {
  const { active } = req.body;
  const r = await pool.query('UPDATE promotions SET active=$1 WHERE id=$2 RETURNING *', [active, req.params.id]);
  res.json(r.rows[0]);
});

// Webhooks
app.get('/api/webhooks', requirePlan('pro','webhooks'), async (req, res) => {
  const { shop } = req.query;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS webhooks (
      id SERIAL PRIMARY KEY, shop_domain VARCHAR(255), url TEXT NOT NULL,
      events TEXT DEFAULT 'return.created,return.approved,return.rejected,return.refunded',
      active BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW()
    )`);
    const r = await pool.query('SELECT * FROM webhooks WHERE shop_domain=$1', [shop||'']);
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

app.post('/api/webhooks', requirePlan('pro','webhooks'), async (req, res) => {
  const { shop, url, events } = req.body;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS webhooks (
      id SERIAL PRIMARY KEY, shop_domain VARCHAR(255), url TEXT NOT NULL,
      events TEXT DEFAULT 'return.created,return.approved,return.rejected,return.refunded',
      active BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW()
    )`);
    const r = await pool.query('INSERT INTO webhooks (shop_domain,url,events) VALUES ($1,$2,$3) RETURNING *', [shop,url,events||'return.created,return.approved']);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/webhooks/:id', requirePlan('pro','webhooks'), async (req, res) => {
  await pool.query('DELETE FROM webhooks WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Mark order as returned on Shopify (tags)
app.post('/api/shopify/tag-order', requireShopAccess, async (req, res) => {
  const { shop, order_id, tags } = req.body;
  if (!shop || !order_id) return res.status(400).json({ error: 'shop and order_id required' });
  const sr = await getStoreToken(shop);
  if (!sr.rows.length) return res.status(404).json({ error: 'Store not connected' });
  try {
    const r = await fetch(`https://${shop}/admin/api/2025-04/orders/${order_id}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': sr.rows[0].access_token },
      body: JSON.stringify({ order: { id: order_id, tags: tags || 'return-requested' } })
    });
    const d = await r.json();
    res.json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Locations (multiple warehouse addresses)
app.get('/api/locations', requireShopAccess, async (req, res) => {
  const { shop } = req.query;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS locations (
      id SERIAL PRIMARY KEY, shop_domain VARCHAR(255), name VARCHAR(255),
      address TEXT, city VARCHAR(100), state VARCHAR(100), pincode VARCHAR(20),
      phone VARCHAR(50), is_default BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW()
    )`);
    const r = await pool.query('SELECT * FROM locations WHERE shop_domain=$1 ORDER BY is_default DESC', [shop||'']);
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

app.post('/api/locations', requireShopAccess, async (req, res) => {
  const { shop, name, address, city, state, pincode, phone, is_default } = req.body;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS locations (
      id SERIAL PRIMARY KEY, shop_domain VARCHAR(255), name VARCHAR(255),
      address TEXT, city VARCHAR(100), state VARCHAR(100), pincode VARCHAR(20),
      phone VARCHAR(50), is_default BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW()
    )`);
    if (is_default) await pool.query('UPDATE locations SET is_default=false WHERE shop_domain=$1', [shop]);
    const r = await pool.query('INSERT INTO locations (shop_domain,name,address,city,state,pincode,phone,is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [shop,name,address,city,state,pincode,phone,is_default||false]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/locations/:id', requireShopAccess, async (req, res) => {
  // Scope by shop_domain — req.params.id here refers to a locations row, not a return, so
  // requireShopAccess's returns-table auto-lookup doesn't apply; it relies on the caller
  // supplying ?shop= (verified against their own token). This WHERE clause is what actually
  // stops a caller deleting a DIFFERENT shop's location by guessing an id.
  const r = await pool.query('DELETE FROM locations WHERE id=$1 AND shop_domain=$2 RETURNING id', [req.params.id, req.verifiedShop]);
  if (!r.rows.length) return res.status(404).json({ error: 'Location not found' });
  res.json({ ok: true });
});

// Activity Log API — moved to server/routes/adminPlans.js above (Batch 4 Step 2, Group 2b).

// Mandatory Shopify compliance webhooks (refunds-create, GDPR data_request/redact/shop-redact,
// app-uninstalled) extracted to server/routes/webhooks.js (Batch 4 Step 2, Group 5) — behavior
// unchanged, verbatim move. webhookFailureCount moved with it (exported via getter, same
// pattern as getLastEmailError in lib/email.js).
const { registerWebhookRoutes, getWebhookFailureCount } = require('./routes/webhooks');
registerWebhookRoutes(app);

// Batch 5 Part 3: previously this never actually touched the database — it was a static
// process-state response, so if Postgres were down this would still report ok:true and an
// uptime monitor would see a healthy 200. Added a real, lightweight `SELECT 1` with a 3s
// timeout so `database` genuinely reflects connectivity. All previously-existing fields are
// unchanged (additive only) — no existing consumer of this response is affected.
app.get('/api/health', async (req, res) => {
  let database = { connected: false, latency_ms: null };
  try {
    const start = Date.now();
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB health check timeout')), 3000))
    ]);
    database = { connected: true, latency_ms: Date.now() - start };
  } catch(e) {
    database = { connected: false, error: e.message };
  }
  const overallOk = database.connected;
  res.status(overallOk ? 200 : 503).json({
    ok: overallOk,
    version: '3.6.0-features',
    database,
    shiprocket: !!process.env.SHIPROCKET_EMAIL,
    email: !!process.env.RESEND_API_KEY,
    monitoring: monitoring.isEnabled(),
    last_email_error: getLastEmailError() || 'none',
    last_successful_backup: lastSuccessfulBackupAt || 'none yet this boot',
    webhook_failures_since_boot: getWebhookFailureCount()
  });
});

// Debug/support endpoints — gated by a dedicated DEBUG_KEY env var (never hardcoded, never the
// same secret used anywhere else). Fails CLOSED: if DEBUG_KEY isn't set in the environment, these
// routes refuse every request rather than falling back to a guessable default.
function checkDebugKey(req, res) {
  const expected = process.env.DEBUG_KEY;
  const key = req.query?.key;
  if (!expected || !key || key !== expected) { res.status(403).json({ error: 'Unauthorized' }); return false; }
  return true;
}

app.get('/api/debug/reset-store', async (req, res) => {
  if (!checkDebugKey(req, res)) return;
  const { shop } = req.query;
  if (!shop) return res.json({ error: 'shop required' });
  await pool.query('DELETE FROM shopify_stores WHERE shop_domain=$1', [shop]);
  res.json({ ok: true, deleted: shop });
});

app.get('/api/debug/last-exchange', (req, res) => {
  if (!checkDebugKey(req, res)) return;
  res.json(lastExchange);
});

// Force re-auth: redirects store through OAuth to get fresh expiring token
app.get('/api/auth/reauth', (req, res) => {
  if (!checkDebugKey(req, res)) return;
  const { shop } = req.query;
  if (!shop) return res.status(400).send('shop required');
  const redirectUri = encodeURIComponent(`${APP_URL}/api/auth/callback`);
  const scopes = 'read_orders,write_orders,read_customers,read_products,read_inventory';
  const nonce = issueOAuthNonce(shop);
  res.redirect(`https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=${scopes}&redirect_uri=${redirectUri}&state=${nonce}`);
});

app.get('/api/debug/force-refresh', async (req, res) => {
  if (!checkDebugKey(req, res)) return;
  const { shop } = req.query;
  const sr = await pool.query('SELECT refresh_token, token_expires_at FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return res.json({ error: 'store not in db' });
  const rt = sr.rows[0].refresh_token;
  if (!rt) return res.json({ error: 'no refresh_token stored (token is non-expiring type - reopen embedded app)' });
  const before = sr.rows[0].token_expires_at;
  const fresh = await refreshAccessToken(shop, decryptCredential(rt));
  const after = await pool.query('SELECT token_expires_at, LEFT(refresh_token,10) AS rt FROM shopify_stores WHERE shop_domain=$1', [shop]);
  res.json({ refreshed: !!fresh, token_prefix: fresh ? fresh.substring(0,10) : null, expires_before: Number(before), expires_after: Number(after.rows[0].token_expires_at), new_refresh_prefix: after.rows[0].rt });
});

app.get('/api/debug/shop-check', async (req, res) => {
  if (!checkDebugKey(req, res)) return;
  const { shop } = req.query;
  if (!shop) return res.json({ error: 'shop param required' });
  const sr = await pool.query('SELECT shop_domain, store_name, created_at FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return res.json({ error: 'Store not in DB', shop });
  const token = await getValidToken(shop);
  try {
    const shopR = await fetch(`https://${shop}/admin/api/2025-04/shop.json`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    const shopStatus = shopR.status;
    const shopBody = await shopR.text();
    const ordR = await fetch(`https://${shop}/admin/api/2025-04/orders.json?status=any&limit=3`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    const ordStatus = ordR.status;
    const ordBody = await ordR.text();
    res.json({ store: sr.rows[0], shop_api: shopStatus, shop_resp: shopBody.substring(0,200), orders_api: ordStatus, orders_resp: ordBody.substring(0,200), token_prefix: token?.substring(0,12)+'...' });
  } catch(e) { res.json({ store: sr.rows[0], error: e.message }); }
});

// Static page-serving routes extracted to server/routes/staticPages.js (Batch 4 Step 2, Group 1)
// — behavior unchanged, verbatim move. Registered here at the exact same point in the route
// order as before (the catch-all '*' inside it must stay last).
require('./routes/staticPages').registerStaticPageRoutes(app);

// ===== AUTOMATIC DATA BACKUP =====
// Protects against losing all data if the Railway database is ever corrupted, deleted, or the
// project is lost. Runs daily and emails a JSON snapshot of all business data (returns, stores,
// settings, team) to the admin's inbox — an off-site copy independent of Railway.
// Access tokens / passwords are deliberately excluded; reconnecting a store just needs a re-auth.
let lastSuccessfulBackupAt = null; // exposed via /api/health so backup health is visible without digging through email
async function runDataBackup(triggeredManually) {
  try {
    const tables = ['shopify_stores', 'returns', 'store_settings', 'team_members', 'admin_users', 'activity_log'];
    const dump = {};
    for (const t of tables) {
      // activity_log grows unbounded over time — cap it so backups stay small and fast indefinitely
      const r = t === 'activity_log'
        ? await pool.query(`SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 1000`)
        : await pool.query(`SELECT * FROM ${t}`);
      dump[t] = r.rows.map(row => {
        const clean = { ...row };
        delete clean.access_token; delete clean.refresh_token; delete clean.password_hash;
        delete clean.shiprocket_password; delete clean.shiprocket_token; delete clean.session_token;
        delete clean.invite_token; delete clean.clickpost_api_key; delete clean.shadowfax_client_secret;
        delete clean.delhivery_api_key; delete clean.xpressbees_api_token; delete clean.wareiq_client_secret;
        // Photos are already safe in Postgres (not on Railway's ephemeral disk) — excluding the
        // base64 image blobs here keeps backup emails small and reliable instead of risking
        // Resend attachment-size failures as return volume grows.
        if (clean.images) { clean.has_images = true; delete clean.images; }
        return clean;
      });
    }
    dump._meta = { generated_at: new Date().toISOString(), version: '3.6.0-features' };
    const json = JSON.stringify(dump, null, 2);
    const base64 = Buffer.from(json).toString('base64');
    const dateStr = new Date().toISOString().split('T')[0];
    const ok = await sendEmail(
      ALLOWED_ADMIN_EMAIL,
      `GoReturn Daily Backup - ${dateStr}`,
      `<div style="font-family:sans-serif;padding:20px"><h2>GoReturn Data Backup</h2><p>Automatic backup for ${dateStr}.</p><p>Stores: ${dump.shopify_stores.length} · Returns: ${dump.returns.length}</p><p style="color:#888;font-size:12px">Keep this email safe — it's your off-site recovery copy. Access tokens are excluded for security; reconnect stores via Shopify re-auth if ever needed.</p></div>`,
      [{ filename: `goreturn-backup-${dateStr}.json`, content: base64 }]
    );
    console.log(`Backup ${triggeredManually ? '(manual)' : '(scheduled)'} ${ok ? 'sent' : 'FAILED to send'} — ${dump.returns.length} returns, ${dump.shopify_stores.length} stores`);
    if (ok) {
      lastSuccessfulBackupAt = new Date().toISOString();
    } else {
      // The backup itself failed to send — this previously only showed up as a console.log line
      // nobody would see. Try a second, much simpler alert (no large attachment) since the
      // original failure might specifically be attachment-size/delivery related.
      notifyAdmin('🚨 GoReturn Backup FAILED to send', `<p>The ${triggeredManually ? 'manual' : 'scheduled'} backup for ${dateStr} generated successfully (${dump.returns.length} returns, ${dump.shopify_stores.length} stores) but the email failed to send.</p><p>Last known good backup: ${lastSuccessfulBackupAt || 'none recorded this run'}</p>`).catch(()=>{});
    }
    return { ok, returns: dump.returns.length, stores: dump.shopify_stores.length };
  } catch(e) {
    console.log('Backup error:', e.message);
    notifyAdmin('🚨 GoReturn Backup Failed (Exception)', `<p>Error generating backup: ${e.message}</p><p>Last known good backup: ${lastSuccessfulBackupAt || 'none recorded this run'}</p><p>Time: ${new Date().toUTCString()}</p>`).catch(()=>{});
    return { ok: false, error: e.message };
  }
}

// Keeps our DB plan in sync with what's actually true on Shopify's side. The legacy REST
// recurring_application_charges API has no webhook for cancellation/decline/expiry, so this is
// a daily poll: any paid shop whose stored charge is no longer 'active' gets downgraded to free,
// and any paid trial that has run out (with no real charge behind it) gets downgraded too.
async function syncBillingStatus() {
  const downgraded = [];
  try {
    const paidWithCharge = await pool.query(
      `SELECT shop_domain, billing_charge_id, plan FROM shopify_stores WHERE plan != 'free' AND billing_charge_id IS NOT NULL`
    );
    for (const row of paidWithCharge.rows) {
      try {
        const token = await getValidToken(row.shop_domain);
        if (!token) continue;
        const r = await shopifyFetch(`https://${row.shop_domain}/admin/api/2025-04/recurring_application_charges/${row.billing_charge_id}.json`, {
          headers: { 'X-Shopify-Access-Token': token }
        });
        const d = await r.json();
        const status = d.recurring_application_charge?.status;
        if (status && status !== 'active') {
          await pool.query('UPDATE shopify_stores SET plan=$1 WHERE shop_domain=$2', ['free', row.shop_domain]);
          downgraded.push(`${row.shop_domain} (${row.plan}→free, charge status: ${status})`);
        }
      } catch(e) { console.log(`syncBillingStatus check failed for ${row.shop_domain}:`, e.message); }
    }

    // Trials that ran out with no real charge on file (merchant never actually paid) — these
    // couldn't be caught above since there's no billing_charge_id to check against Shopify.
    const expiredTrials = await pool.query(
      `SELECT shop_domain, plan FROM shopify_stores WHERE plan != 'free' AND billing_charge_id IS NULL AND trial_ends_at IS NOT NULL AND trial_ends_at < NOW()`
    );
    for (const row of expiredTrials.rows) {
      await pool.query('UPDATE shopify_stores SET plan=$1 WHERE shop_domain=$2', ['free', row.shop_domain]);
      downgraded.push(`${row.shop_domain} (${row.plan}→free, trial expired)`);
    }

    if (downgraded.length) {
      console.log('syncBillingStatus: downgraded', downgraded);
      await notifyAdmin('⚠️ GoReturn Plan Downgrades (Billing Sync)', `<p>The following stores were downgraded to Free after checking Shopify billing status / trial expiry:</p><ul>${downgraded.map(x => `<li>${x}</li>`).join('')}</ul>`);
    }
    return { ok: true, downgraded: downgraded.length };
  } catch(e) {
    console.log('syncBillingStatus error:', e.message);
    return { ok: false, error: e.message };
  }
}

// Manual on-demand backup trigger (admin only)
// Force register refunds/create webhook for all stores (admin only)
app.post('/api/admin/register-webhooks', requireOwner, async (req, res) => {
  try {
    const stores = await pool.query('SELECT shop_domain FROM shopify_stores');
    const results = [];
    for (const row of stores.rows) {
      try {
        // Always go through getValidToken() — it decrypts (and refreshes if needed). Reading
        // access_token directly from the row would return raw ciphertext for any store whose
        // token has been encrypted since the AES-256-GCM migration, and sending that to Shopify
        // as-is would fail with 401 for every such store.
        const token = await getValidToken(row.shop_domain);
        if (!token) { results.push({ shop: row.shop_domain, error: 'no valid token' }); continue; }
        const r = await fetch(`https://${row.shop_domain}/admin/api/2025-04/webhooks.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
          body: JSON.stringify({ webhook: { topic: 'refunds/create', address: `${APP_URL}/api/webhooks/shopify/refunds-create`, format: 'json' } })
        });
        const d = await r.json();
        results.push({ shop: row.shop_domain, status: r.status, webhook_id: d.webhook?.id, errors: d.errors });
      } catch(e) { results.push({ shop: row.shop_domain, error: e.message }); }
    }
    res.json({ ok: true, results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/backup-now', requireOwner, async (req, res) => {
  const result = await runDataBackup(true);
  res.json(result);
});

// Catches any error that reaches Express's default error handling (a route that threw without
// its own try/catch) — records it to Sentry (no-op if not configured) with route/shop context,
// then hands off to next(err) so existing behavior (Express's default 500 response) is unchanged.
app.use(monitoring.expressErrorHandler());

const PORT = process.env.PORT || 3001;
initDB().then(() => {
  app.listen(PORT, () => console.log('GoReturn v3.0 running on port ' + PORT));
  // First backup 2 min after boot (lets DB settle), then every 24 hours
  setTimeout(() => runDataBackup(false), 2 * 60 * 1000);
  setInterval(() => runDataBackup(false), 24 * 60 * 60 * 1000);

  // Register refunds/create webhook for all existing stores (idempotent)
  setTimeout(async () => {
    try {
      const stores = await pool.query('SELECT shop_domain FROM shopify_stores');
      for (const row of stores.rows) {
        try {
          // Same fix as /api/admin/register-webhooks: must decrypt via getValidToken(), not
          // read the (possibly now-encrypted) access_token column directly.
          const token = await getValidToken(row.shop_domain);
          if (!token) { console.log(`Webhook reg skipped for ${row.shop_domain}: no valid token`); continue; }
          await fetch(`https://${row.shop_domain}/admin/api/2025-04/webhooks.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
            body: JSON.stringify({ webhook: { topic: 'refunds/create', address: `${APP_URL}/api/webhooks/shopify/refunds-create`, format: 'json' } })
          });
          console.log(`Webhook registered for ${row.shop_domain}`);
        } catch(e) { console.log(`Webhook reg failed for ${row.shop_domain}: ${e.message}`); }
      }
    } catch(e) { console.log('Bulk webhook registration error:', e.message); }
  }, 10 * 1000); // 10 seconds after boot

  // Daily billing-status sync: catches subscription cancellation, payment decline/expiry, and
  // trial expiry that Shopify has no webhook for on the legacy REST recurring-charges API — the
  // DB `plan` column previously could only move "up" via /api/billing/confirm, never back down
  // on its own if a merchant cancelled directly in Shopify or a trial simply ran out.
  setTimeout(() => syncBillingStatus(), 3 * 60 * 1000); // 3 min after boot (after backup settles)
  setInterval(() => syncBillingStatus(), 24 * 60 * 60 * 1000);
});
