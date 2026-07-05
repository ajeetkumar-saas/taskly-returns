// Shopify token/auth helpers: session-token (JWT) verification, webhook HMAC verification,
// offline-token refresh/retrieval, and the retry-wrapped fetch used for Shopify REST API calls.
// Extracted from server/index.js (Batch 4 Step 1e) — behavior unchanged, verbatim move.
//
// SHOPIFY_CLIENT_ID/SHOPIFY_APP_SHARED_SECRET are read directly from process.env here rather
// than imported from index.js — same values (env vars don't change at runtime), and avoids a
// circular require since index.js still needs its own copies for the OAuth routes that aren't
// moving in this step.

const crypto = require('crypto');
const fetch = require('node-fetch');
const pool = require('./db');
const { encryptCredential, decryptCredential } = require('./crypto');

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_APP_SHARED_SECRET;

// Verifies a Shopify App Bridge session token (the short-lived JWT from shopify.idToken()).
// Confirms the signature (HMAC-SHA256 with the app's client secret), expiry, and which shop
// it was issued for — this is the standard "verify session tokens" requirement for embedded apps.
function verifyShopifySessionToken(token) {
  if (!token || typeof token !== 'string' || !SHOPIFY_CLIENT_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const b64url = s => s.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const expectedSig = b64url(crypto.createHmac('sha256', SHOPIFY_CLIENT_SECRET).update(headerB64 + '.' + payloadB64).digest('base64'));
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(sigB64))) return null;
  } catch(e) { return null; }
  try {
    const padded = payloadB64.replace(/-/g,'+').replace(/_/g,'/') + '='.repeat((4 - payloadB64.length % 4) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    const shop = (payload.dest || '').replace(/^https?:\/\//, '');
    return shop ? { shop, payload } : null;
  } catch(e) { return null; }
}

function verifyShopifyHmac(req) {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  if (!hmac || !SHOPIFY_CLIENT_SECRET) return false;
  const body = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const hash = crypto.createHmac('sha256', SHOPIFY_CLIENT_SECRET).update(body).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmac));
  } catch(e) { return false; }
}

// Refresh an expiring offline token using the stored refresh_token
async function refreshAccessToken(shop, refreshToken) {
  const params = new URLSearchParams({
    client_id: SHOPIFY_CLIENT_ID,
    client_secret: SHOPIFY_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });
  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: params.toString()
  });
  const text = await r.text();
  let d; try { d = JSON.parse(text); } catch(e) { console.log('Refresh parse fail:', r.status, text.substring(0,150)); return null; }
  if (d.access_token) {
    const expiresAt = Date.now() + ((d.expires_in || 3600) * 1000);
    await pool.query(
      'UPDATE shopify_stores SET access_token=$1, refresh_token=$2, token_expires_at=$3 WHERE shop_domain=$4',
      [encryptCredential(d.access_token), encryptCredential(d.refresh_token || refreshToken), expiresAt, shop]
    );
    console.log('Token refreshed:', { shop, expires_in: d.expires_in });
    return d.access_token;
  }
  console.log('Refresh failed:', d);
  return null;
}

// Auto-fix: when API returns 401, try refreshing the token
async function attemptReauth(shop) {
  const sr = await pool.query('SELECT access_token, refresh_token, token_expires_at FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return null;
  const row = sr.rows[0];
  if (row.refresh_token) {
    console.log(`attemptReauth: trying refresh for ${shop}`);
    const fresh = await refreshAccessToken(shop, decryptCredential(row.refresh_token));
    if (fresh) return fresh;
  }
  console.log(`attemptReauth: no refresh token for ${shop}, needs App Bridge re-auth`);
  return null;
}

// Returns a valid (non-expired) access token, refreshing if needed.
// This is the single funnel almost every Shopify API call in the app goes through
// (directly or via getStoreToken()), so decrypting here covers the whole app —
// decryptCredential() transparently passes through old plaintext rows too.
async function getValidToken(shop) {
  const sr = await pool.query('SELECT access_token, refresh_token, token_expires_at FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return null;
  const row = sr.rows[0];
  if (!row.access_token) return null;
  const accessToken = decryptCredential(row.access_token);
  const refreshToken = row.refresh_token ? decryptCredential(row.refresh_token) : row.refresh_token;
  const expiresAt = Number(row.token_expires_at || 0);
  // If token has expiry info and is within 2 min of expiry, refresh it
  if (refreshToken && expiresAt > 0 && Date.now() > (expiresAt - 120000)) {
    const fresh = await refreshAccessToken(shop, refreshToken);
    if (fresh) return fresh;
  }
  // If token has expiry info and is already expired but no refresh token, it's dead
  if (expiresAt > 0 && Date.now() > expiresAt && !refreshToken) {
    console.log(`Store ${shop} token expired with no refresh token`);
    return null;
  }
  return accessToken;
}

// Drop-in replacement for the old DB query - returns refreshed token in same shape
async function getStoreToken(shop) {
  const tok = await getValidToken(shop);
  return { rows: tok ? [{ access_token: tok }] : [] };
}

// Calls the Shopify REST Admin API with automatic retry on rate limiting (429) and transient
// server errors (5xx), using exponential backoff (and honoring Shopify's Retry-After header
// when present). Without this, a single rate-limited call just failed outright.
async function shopifyFetch(url, options, maxRetries) {
  maxRetries = maxRetries == null ? 3 : maxRetries;
  let lastResp;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const r = await fetch(url, options);
    if ((r.status === 429 || r.status >= 500) && attempt < maxRetries) {
      const retryAfter = Number(r.headers.get('Retry-After')) || Math.pow(2, attempt);
      await new Promise(res => setTimeout(res, retryAfter * 1000));
      lastResp = r;
      continue;
    }
    return r;
  }
  return lastResp;
}

// Fetches every page of a Shopify REST list endpoint (orders, etc.) by following the cursor in
// the Link response header, instead of silently stopping at the first page (default/max 250
// items). Without this, merchants with more orders than one page get wrong analytics/search
// results with no indication anything was cut off. Capped at 20 pages as a sane safety limit.
async function shopifyFetchAllPages(initialUrl, options, maxPages) {
  maxPages = maxPages || 20;
  let url = initialUrl;
  let results = [];
  let page = 0;
  while (url && page < maxPages) {
    const r = await shopifyFetch(url, options);
    if (!r.ok) break;
    const data = await r.json();
    const key = Object.keys(data)[0]; // e.g. "orders"
    if (Array.isArray(data[key])) results = results.concat(data[key]);
    const link = r.headers.get('Link') || r.headers.get('link') || '';
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
    page++;
  }
  return results;
}

module.exports = {
  verifyShopifySessionToken,
  verifyShopifyHmac,
  refreshAccessToken,
  attemptReauth,
  getValidToken,
  getStoreToken,
  shopifyFetch,
  shopifyFetchAllPages
};
