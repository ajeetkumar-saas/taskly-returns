// Shiprocket + multi-logistics-provider integration, and the return approve/reject/status-update
// route (PATCH /api/returns/:id) which triggers Shiprocket auto-pickup on approval. Extracted
// from server/index.js (Batch 5 Part 1, Domain 1) — behavior unchanged, verbatim move.
//
// PATCH /api/returns/:id is grouped here (not with the other return routes moved in Batch 4)
// because it calls createShiprocketPickup(), which lives in this same domain — moving it
// separately would have required a circular require back into index.js.

const fetch = require('node-fetch');
const pool = require('../lib/db');
const { sendEmail } = require('../lib/email');
const { logActivity } = require('../lib/activityLog');
const { encryptCredential, decryptCredential } = require('../lib/crypto');
const { requireShopAccess } = require('../lib/auth');
const { getEmailTemplates, fillPlaceholders, returnStatusEmail } = require('../lib/emailTemplates');
const LogisticsProviders = require('../logistics-providers.js');

const SHIPROCKET_EMAIL = process.env.SHIPROCKET_EMAIL;
const SHIPROCKET_PASSWORD = process.env.SHIPROCKET_PASSWORD;
const SHIPROCKET_BASE = 'https://apiv2.shiprocket.in/v1/external';

let shiprocketToken = '';
let shiprocketTokenExpiry = 0;

async function getShiprocketToken() {
  if (shiprocketToken && Date.now() < shiprocketTokenExpiry) return shiprocketToken;
  if (!SHIPROCKET_EMAIL || !SHIPROCKET_PASSWORD) return null;
  const r = await fetch(`${SHIPROCKET_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: SHIPROCKET_EMAIL, password: SHIPROCKET_PASSWORD })
  });
  const d = await r.json();
  shiprocketToken = d.token;
  shiprocketTokenExpiry = Date.now() + 9 * 24 * 60 * 60 * 1000;
  return shiprocketToken;
}

async function shiprocketAPI(endpoint, method, body) {
  const token = await getShiprocketToken();
  if (!token) throw new Error('Shiprocket not configured');
  const opts = { method, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${SHIPROCKET_BASE}${endpoint}`, opts);
  return r.json();
}

async function getSellerShiprocketToken(shop) {
  const r = await pool.query('SELECT shiprocket_token, shiprocket_email, shiprocket_password FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!r.rows.length || !r.rows[0].shiprocket_email) return null;
  let token = r.rows[0].shiprocket_token;
  if (!token) {
    const resp = await fetch(`${SHIPROCKET_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: r.rows[0].shiprocket_email, password: decryptCredential(r.rows[0].shiprocket_password) })
    });
    const d = await resp.json();
    token = d.token;
    if (token) await pool.query('UPDATE shopify_stores SET shiprocket_token=$1 WHERE shop_domain=$2', [token, shop]);
  }
  return token;
}

async function sellerShiprocketAPI(shop, endpoint, method, body) {
  const token = await getSellerShiprocketToken(shop);
  if (!token) throw new Error('Shiprocket not connected for this store');
  const opts = { method, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${SHIPROCKET_BASE}${endpoint}`, opts);
  return r.json();
}

// Reusable: create Shiprocket return pickup + AWB + schedule, update DB
async function createShiprocketPickup(shop, d) {
  const return_id = d.id || d.return_id;
  // Get seller's registered pickup location (return destination/warehouse)
  const stRow = await pool.query('SELECT shiprocket_pickup_location FROM shopify_stores WHERE shop_domain=$1', [shop]);
  let dest = { name: 'Primary', address: 'Warehouse', city: 'City', state: 'State', pincode: '110001', phone: '0000000000', email: '' };
  try {
    const locResp = await sellerShiprocketAPI(shop, '/settings/company/pickup', 'GET');
    const locs = locResp?.data?.shipping_address || [];
    const chosen = locs.find(l => l.pickup_location === stRow.rows[0]?.shiprocket_pickup_location) || locs[0];
    if (chosen) dest = { name: chosen.pickup_location, address: chosen.address, city: chosen.city, state: chosen.state, pincode: chosen.pin_code, phone: chosen.phone, email: chosen.email };
  } catch(e) {}
  const orderData = await sellerShiprocketAPI(shop, '/orders/create/return', 'POST', {
    order_id: `RETURN-${return_id}`,
    order_date: new Date().toISOString().split('T')[0],
    channel_id: '',
    pickup_customer_name: d.customer_name,
    pickup_address: d.customer_address || 'Customer Address',
    pickup_city: d.customer_city || 'City',
    pickup_state: d.customer_state || 'State',
    pickup_country: 'India',
    pickup_pincode: d.customer_pincode || '110001',
    pickup_email: d.customer_email || '',
    pickup_phone: d.customer_phone || '',
    shipping_customer_name: dest.name,
    shipping_address: dest.address,
    shipping_city: dest.city,
    shipping_state: dest.state,
    shipping_country: 'India',
    shipping_pincode: dest.pincode,
    shipping_email: dest.email || d.customer_email || '',
    shipping_phone: dest.phone || '0000000000',
    order_items: [{ name: d.product_name || 'Return Item', sku: d.product_sku || 'SKU', units: d.quantity || 1, selling_price: d.amount || 0 }],
    payment_method: 'prepaid',
    sub_total: d.amount || 0,
    length: 10, breadth: 10, height: 10, weight: 0.5
  });
  let awb = '', awbData = null;
  if (orderData.shipment_id) {
    try {
      awbData = await sellerShiprocketAPI(shop, '/courier/assign/awb', 'POST', { shipment_id: orderData.shipment_id });
      awb = awbData?.response?.data?.awb_code || '';
      await sellerShiprocketAPI(shop, '/courier/generate/pickup', 'POST', { shipment_id: [orderData.shipment_id] });
    } catch(e) {}
  }
  if (orderData.order_id) {
    await pool.query('UPDATE returns SET pickup_status=$1, tracking_number=$2, updated_at=NOW() WHERE id=$3',
      ['pickup_scheduled', awb || orderData.shipment_id || '', return_id]);
  }
  return { ...orderData, awb_code: awb, awb: awbData };
}

function registerLogisticsRoutes(app) {
  app.patch('/api/returns/:id', requireShopAccess, async (req, res) => {
    const { status, merchant_notes, tracking_number, pickup_status, archived, risk_level } = req.body;
    // Refunds must go through Shopify's refund API (POST /api/returns/:id/refund), never a bare status flip
    if (status === 'refunded') return res.status(400).json({ error: 'Use POST /api/returns/:id/refund to process refunds through Shopify' });
    const fields = [];
    const values = [];
    let idx = 1;
    if (status) {
      fields.push(`status=$${idx++}`); values.push(status);
      if (status === 'inspected') fields.push('inspected_at=NOW()');
    }
    if (merchant_notes !== undefined) { fields.push(`merchant_notes=$${idx++}`); values.push(merchant_notes); }
    if (tracking_number !== undefined) { fields.push(`tracking_number=$${idx++}`); values.push(tracking_number); }
    if (pickup_status !== undefined) { fields.push(`pickup_status=$${idx++}`); values.push(pickup_status); }
    if (archived !== undefined) { fields.push(`archived=$${idx++}`); values.push(archived); }
    if (risk_level !== undefined) { fields.push(`risk_level=$${idx++}`); values.push(risk_level); }
    fields.push(`updated_at=NOW()`);
    values.push(req.params.id);
    const idParamIdx = idx++;
    values.push(req.verifiedShop);
    // Scope the UPDATE to the caller's own verified shop — requireShopAccess resolves
    // req.verifiedShop from the record's real owner when possible, but a caller can also supply
    // their OWN shop via ?shop=, which passes the middleware fine; without this WHERE clause that
    // would let any authenticated seller modify a DIFFERENT shop's return just by guessing its id.
    const r = await pool.query(`UPDATE returns SET ${fields.join(',')} WHERE id=$${idParamIdx} AND shop_domain=$${idx} RETURNING *`, values);
    if (!r.rows.length) return res.status(404).json({ error: 'Return not found' });
    const ret = r.rows[0];
    if (status && ret.customer_email) {
      const tpl = await getEmailTemplates(ret.shop_domain);
      const t = tpl[status];
      const ph = { order: ret.order_number||ret.order_id, name: ret.customer_name, amount: ret.amount, product: ret.product_name };
      const subj = t ? fillPlaceholders(t.subject, ph) : `Return ${status.toUpperCase()} - #${ret.order_number||ret.order_id}`;
      const msg = t ? fillPlaceholders(t.message, ph) : null;
      sendEmail(ret.customer_email, subj, returnStatusEmail(ret.customer_name||'Customer', ret.order_number||ret.order_id, status, ret.amount, { product: ret.product_name, reason: ret.reason, refund_method: ret.refund_method, returnId: ret.id, customMsg: msg }));
    }
    if (status) logActivity(req, 'Return Status Changed', `#${req.params.id} → ${status} (${ret.customer_name}, ${ret.order_id})`);
    if (archived) logActivity(req, 'Return Archived', `#${req.params.id} (${ret.customer_name})`);
    // Auto-pickup: if approved & store has Shiprocket auto-pickup enabled
    if (status === 'approved' && ret.type !== 'exchange' && ret.pickup_status !== 'pickup_scheduled') {
      try {
        const st = await pool.query('SELECT shiprocket_connected, shiprocket_auto_pickup FROM shopify_stores WHERE shop_domain=$1', [ret.shop_domain]);
        if (st.rows[0]?.shiprocket_connected && st.rows[0]?.shiprocket_auto_pickup) {
          createShiprocketPickup(ret.shop_domain, ret).catch(async e => {
            console.log('Auto-pickup failed:', e.message);
            try {
              await pool.query(`UPDATE returns SET pickup_status='pickup_failed' WHERE id=$1`, [ret.id]);
              const storeRow = await pool.query('SELECT store_email FROM shopify_stores WHERE shop_domain=$1', [ret.shop_domain]);
              const notifyTo = storeRow.rows[0]?.store_email;
              if (notifyTo) {
                sendEmail(notifyTo, `Action needed: Pickup failed for return #${ret.id}`,
                  `<div style="font-family:sans-serif;padding:20px"><h3>Shiprocket auto-pickup failed</h3><p>Return #${ret.id} (Order ${ret.order_number||ret.order_id}) was approved but the automatic Shiprocket pickup could not be scheduled.</p><p>Reason: ${e.message}</p><p>Please open GoReturn and trigger the pickup manually for this return.</p></div>`);
              }
            } catch(e2) { console.log('Auto-pickup failure notification error:', e2.message); }
          });
        }
      } catch(e) {}
    }
    res.json(ret);
  });

  // Shiprocket Connect (per seller)
  app.post('/api/shiprocket/connect', requireShopAccess, async (req, res) => {
    const { shop, email, password } = req.body;
    if (!shop || !email || !password) return res.status(400).json({ error: 'shop, email, password required' });
    try {
      const r = await fetch(`${SHIPROCKET_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const d = await r.json();
      if (!d.token) return res.status(400).json({ error: 'Invalid Shiprocket credentials' });
      await pool.query(
        'UPDATE shopify_stores SET shiprocket_email=$1, shiprocket_password=$2, shiprocket_token=$3, shiprocket_connected=true WHERE shop_domain=$4',
        [email, encryptCredential(password), d.token, shop]
      );
      res.json({ ok: true, message: 'Shiprocket connected successfully!' });
    } catch(e) { console.log('shiprocket connect error:', e.message); res.status(500).json({ error: 'Failed to connect Shiprocket' }); }
  });

  app.post('/api/shiprocket/disconnect', requireShopAccess, async (req, res) => {
    const { shop } = req.body;
    if (!shop) return res.status(400).json({ error: 'shop required' });
    await pool.query(
      'UPDATE shopify_stores SET shiprocket_email=$1, shiprocket_password=$2, shiprocket_token=$3, shiprocket_connected=false WHERE shop_domain=$4',
      ['', '', '', shop]
    );
    res.json({ ok: true });
  });

  app.get('/api/shiprocket/status', requireShopAccess, async (req, res) => {
    const { shop } = req.query;
    if (!shop) return res.status(400).json({ error: 'shop required' });
    const r = await pool.query('SELECT shiprocket_connected, shiprocket_email, shiprocket_auto_pickup, shiprocket_pickup_location FROM shopify_stores WHERE shop_domain=$1', [shop]);
    if (!r.rows.length) return res.json({ connected: false });
    res.json({ connected: r.rows[0].shiprocket_connected, email: r.rows[0].shiprocket_email, auto_pickup: r.rows[0].shiprocket_auto_pickup, pickup_location: r.rows[0].shiprocket_pickup_location });
  });

  // Fetch the seller's Shiprocket pickup locations (return destinations)
  app.get('/api/shiprocket/pickup-locations', requireShopAccess, async (req, res) => {
    const { shop } = req.query;
    if (!shop) return res.status(400).json({ error: 'shop required' });
    try {
      const d = await sellerShiprocketAPI(shop, '/settings/company/pickup', 'GET');
      const locations = (d?.data?.shipping_address || []).map(l => ({
        id: l.pickup_location, name: l.pickup_location, address: l.address, city: l.city, state: l.state, pincode: l.pin_code
      }));
      res.json({ locations });
    } catch(e) { res.json({ locations: [], error: e.message }); }
  });

  // Save Shiprocket automation settings
  app.post('/api/shiprocket/settings', requireShopAccess, async (req, res) => {
    const { shop, auto_pickup, pickup_location } = req.body;
    if (!shop) return res.status(400).json({ error: 'shop required' });
    await pool.query('UPDATE shopify_stores SET shiprocket_auto_pickup=$1, shiprocket_pickup_location=$2 WHERE shop_domain=$3',
      [auto_pickup === true, pickup_location || '', shop]);
    logActivity(req, 'Shiprocket Settings Updated', `auto_pickup=${auto_pickup}, location=${pickup_location||'-'}`);
    res.json({ ok: true });
  });

  // Shiprocket APIs (per seller)
  app.post('/api/shiprocket/pickup', requireShopAccess, async (req, res) => {
    const { return_id, shop } = req.body;
    if (!return_id || !shop) return res.status(400).json({ error: 'return_id and shop required' });
    try {
      const result = await createShiprocketPickup(shop, { ...req.body, id: return_id });
      res.json(result);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/shiprocket/track/:shipment_id', requireShopAccess, async (req, res) => {
    const { shop } = req.query;
    try {
      const data = shop ? await sellerShiprocketAPI(shop, `/courier/track/shipment/${req.params.shipment_id}`, 'GET') : await shiprocketAPI(`/courier/track/shipment/${req.params.shipment_id}`, 'GET');
      res.json(data);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ========== MULTI-LOGISTICS ENDPOINTS ==========

  // Get all connected logistics providers for a store
  app.get('/api/logistics/status', requireShopAccess, async (req, res) => {
    const { shop } = req.query;
    if (!shop) return res.status(400).json({ error: 'shop required' });
    try {
      const r = await pool.query(
        `SELECT
          shiprocket_connected, clickpost_connected, shadowfax_connected,
          delhivery_connected, xpressbees_connected, wareiq_connected,
          default_logistics, logistics_auto_pickup
        FROM shopify_stores WHERE shop_domain=$1`,
        [shop]
      );
      const store = r.rows[0] || {};
      res.json({
        providers: {
          shiprocket: store.shiprocket_connected || false,
          clickpost: store.clickpost_connected || false,
          shadowfax: store.shadowfax_connected || false,
          delhivery: store.delhivery_connected || false,
          xpressbees: store.xpressbees_connected || false,
          wareiq: store.wareiq_connected || false
        },
        default: store.default_logistics || 'shiprocket',
        auto_pickup: store.logistics_auto_pickup || false
      });
    } catch(e) { console.log('logistics status error:', e.message); res.status(500).json({ error: 'Internal server error' }); }
  });

  // ---- ClickPost ----
  app.post('/api/logistics/clickpost/connect', requireShopAccess, async (req, res) => {
    const { shop, api_key } = req.body;
    if (!shop || !api_key) return res.status(400).json({ error: 'shop and api_key required' });
    try {
      const cp = new LogisticsProviders.ClickPost(api_key);
      await pool.query(
        'UPDATE shopify_stores SET clickpost_api_key=$1, clickpost_connected=true WHERE shop_domain=$2',
        [api_key, shop]
      );
      logActivity(req, 'ClickPost Connected', shop);
      res.json({ ok: true });
    } catch(e) { console.log('clickpost connect error:', e.message); res.status(500).json({ error: 'Failed to connect ClickPost' }); }
  });

  app.post('/api/logistics/clickpost/disconnect', requireShopAccess, async (req, res) => {
    const { shop } = req.body;
    if (!shop) return res.status(400).json({ error: 'shop required' });
    await pool.query('UPDATE shopify_stores SET clickpost_api_key=\'\', clickpost_connected=false WHERE shop_domain=$1', [shop]);
    logActivity(req, 'ClickPost Disconnected', shop);
    res.json({ ok: true });
  });

  // ---- Shadowfax ----
  app.post('/api/logistics/shadowfax/connect', requireShopAccess, async (req, res) => {
    const { shop, client_id, client_secret } = req.body;
    if (!shop || !client_id || !client_secret) return res.status(400).json({ error: 'shop, client_id, client_secret required' });
    try {
      const sf = new LogisticsProviders.Shadowfax(client_id, client_secret);
      await sf.getToken();
      await pool.query(
        'UPDATE shopify_stores SET shadowfax_client_id=$1, shadowfax_client_secret=$2, shadowfax_connected=true WHERE shop_domain=$3',
        [client_id, client_secret, shop]
      );
      logActivity(req, 'Shadowfax Connected', shop);
      res.json({ ok: true });
    } catch(e) { console.log('shadowfax connect error:', e.message); res.status(500).json({ error: 'Failed to connect Shadowfax' }); }
  });

  app.post('/api/logistics/shadowfax/disconnect', requireShopAccess, async (req, res) => {
    const { shop } = req.body;
    if (!shop) return res.status(400).json({ error: 'shop required' });
    await pool.query('UPDATE shopify_stores SET shadowfax_client_id=\'\', shadowfax_client_secret=\'\', shadowfax_connected=false WHERE shop_domain=$1', [shop]);
    logActivity(req, 'Shadowfax Disconnected', shop);
    res.json({ ok: true });
  });

  // ---- Delhivery ----
  app.post('/api/logistics/delhivery/connect', requireShopAccess, async (req, res) => {
    const { shop, api_key } = req.body;
    if (!shop || !api_key) return res.status(400).json({ error: 'shop and api_key required' });
    try {
      await pool.query(
        'UPDATE shopify_stores SET delhivery_api_key=$1, delhivery_connected=true WHERE shop_domain=$2',
        [api_key, shop]
      );
      logActivity(req, 'Delhivery Connected', shop);
      res.json({ ok: true });
    } catch(e) { console.log('delhivery connect error:', e.message); res.status(500).json({ error: 'Failed to connect Delhivery' }); }
  });

  app.post('/api/logistics/delhivery/disconnect', requireShopAccess, async (req, res) => {
    const { shop } = req.body;
    if (!shop) return res.status(400).json({ error: 'shop required' });
    await pool.query('UPDATE shopify_stores SET delhivery_api_key=\'\', delhivery_connected=false WHERE shop_domain=$1', [shop]);
    logActivity(req, 'Delhivery Disconnected', shop);
    res.json({ ok: true });
  });

  // ---- XpressBees ----
  app.post('/api/logistics/xpressbees/connect', requireShopAccess, async (req, res) => {
    const { shop, api_token } = req.body;
    if (!shop || !api_token) return res.status(400).json({ error: 'shop and api_token required' });
    try {
      await pool.query(
        'UPDATE shopify_stores SET xpressbees_api_token=$1, xpressbees_connected=true WHERE shop_domain=$2',
        [api_token, shop]
      );
      logActivity(req, 'XpressBees Connected', shop);
      res.json({ ok: true });
    } catch(e) { console.log('xpressbees connect error:', e.message); res.status(500).json({ error: 'Failed to connect XpressBees' }); }
  });

  app.post('/api/logistics/xpressbees/disconnect', requireShopAccess, async (req, res) => {
    const { shop } = req.body;
    if (!shop) return res.status(400).json({ error: 'shop required' });
    await pool.query('UPDATE shopify_stores SET xpressbees_api_token=\'\', xpressbees_connected=false WHERE shop_domain=$1', [shop]);
    logActivity(req, 'XpressBees Disconnected', shop);
    res.json({ ok: true });
  });

  // ---- WareIQ ----
  app.post('/api/logistics/wareiq/connect', requireShopAccess, async (req, res) => {
    const { shop, client_id, client_secret } = req.body;
    if (!shop || !client_id || !client_secret) return res.status(400).json({ error: 'shop, client_id, client_secret required' });
    try {
      const wq = new LogisticsProviders.WareIQ(client_id, client_secret);
      await wq.getToken();
      await pool.query(
        'UPDATE shopify_stores SET wareiq_client_id=$1, wareiq_client_secret=$2, wareiq_connected=true WHERE shop_domain=$3',
        [client_id, client_secret, shop]
      );
      logActivity(req, 'WareIQ Connected', shop);
      res.json({ ok: true });
    } catch(e) { console.log('wareiq connect error:', e.message); res.status(500).json({ error: 'Failed to connect WareIQ' }); }
  });

  app.post('/api/logistics/wareiq/disconnect', requireShopAccess, async (req, res) => {
    const { shop } = req.body;
    if (!shop) return res.status(400).json({ error: 'shop required' });
    await pool.query('UPDATE shopify_stores SET wareiq_client_id=\'\', wareiq_client_secret=\'\', wareiq_connected=false WHERE shop_domain=$1', [shop]);
    logActivity(req, 'WareIQ Disconnected', shop);
    res.json({ ok: true });
  });

  // Set default logistics provider & auto-pickup preference
  app.post('/api/logistics/settings', requireShopAccess, async (req, res) => {
    const { shop, default_provider, auto_pickup } = req.body;
    if (!shop) return res.status(400).json({ error: 'shop required' });
    await pool.query(
      'UPDATE shopify_stores SET default_logistics=$1, logistics_auto_pickup=$2 WHERE shop_domain=$3',
      [default_provider || 'shiprocket', auto_pickup || false, shop]
    );
    logActivity(req, 'Logistics Settings Updated', `Provider: ${default_provider}, Auto-pickup: ${auto_pickup}`);
    res.json({ ok: true });
  });
}

module.exports = { registerLogisticsRoutes };
