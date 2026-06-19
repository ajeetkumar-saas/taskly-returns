require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_APP_SHARED_SECRET;
const APP_URL = process.env.APP_URL || 'http://localhost:3001';

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
    );
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
  } catch(e) {}
  console.log('DB ready');
}

// OAuth
app.get('/api/auth/shopify', (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  const nonce = crypto.randomBytes(16).toString('hex');
  const redirectUri = encodeURIComponent(`${APP_URL}/api/auth/callback`);
  const scopes = 'read_orders,write_orders,read_customers,read_products,read_inventory';
  res.redirect(`https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=${scopes}&redirect_uri=${redirectUri}&state=${nonce}`);
});

app.get('/api/auth/callback', async (req, res) => {
  const { shop, code } = req.query;
  if (!shop || !code) return res.status(400).send('Missing params');
  try {
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, code })
    });
    const { access_token } = await r.json();

    let storeName = shop;
    try {
      const shopInfo = await fetch(`https://${shop}/admin/api/2024-01/shop.json`, {
        headers: { 'X-Shopify-Access-Token': access_token }
      });
      const shopData = await shopInfo.json();
      storeName = shopData.shop?.name || shop;
      const storeEmail = shopData.shop?.email || '';
      await pool.query(
        'INSERT INTO shopify_stores (shop_domain, access_token, store_name, store_email) VALUES ($1,$2,$3,$4) ON CONFLICT (shop_domain) DO UPDATE SET access_token=$2, store_name=$3, store_email=$4',
        [shop, access_token, storeName, storeEmail]
      );
    } catch(e) {
      await pool.query(
        'INSERT INTO shopify_stores (shop_domain, access_token) VALUES ($1,$2) ON CONFLICT (shop_domain) DO UPDATE SET access_token=$2',
        [shop, access_token]
      );
    }

    res.redirect(`/?shop=${shop}&connected=true`);
  } catch(e) { res.status(500).send('OAuth error: ' + e.message); }
});

// Stores
app.get('/api/shopify/stores', async (req, res) => {
  const r = await pool.query('SELECT shop_domain, store_name, store_email, plan, created_at FROM shopify_stores ORDER BY created_at DESC');
  res.json(r.rows);
});

// Orders from Shopify
app.get('/api/shopify/orders', async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  const sr = await pool.query('SELECT access_token FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return res.status(404).json({ error: 'Store not connected' });
  try {
    const r = await fetch(`https://${shop}/admin/api/2024-01/orders.json?status=any&limit=50`, {
      headers: { 'X-Shopify-Access-Token': sr.rows[0].access_token }
    });
    const d = await r.json();
    res.json(d.orders || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Single order lookup (for customer return portal)
app.get('/api/shopify/order-lookup', async (req, res) => {
  const { shop, order_number, email } = req.query;
  if (!shop || !order_number) return res.status(400).json({ error: 'shop and order_number required' });
  const sr = await pool.query('SELECT access_token FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return res.status(404).json({ error: 'Store not found' });
  try {
    const r = await fetch(`https://${shop}/admin/api/2024-01/orders.json?name=${encodeURIComponent(order_number)}&status=any`, {
      headers: { 'X-Shopify-Access-Token': sr.rows[0].access_token }
    });
    const d = await r.json();
    const orders = d.orders || [];
    if (!orders.length) return res.status(404).json({ error: 'Order not found' });
    const order = orders[0];
    if (email && order.email && order.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(403).json({ error: 'Email does not match order' });
    }
    res.json({
      id: order.id,
      order_number: order.name,
      email: order.email,
      customer_name: order.customer ? `${order.customer.first_name} ${order.customer.last_name}` : '',
      phone: order.phone || order.customer?.phone || '',
      total_price: order.total_price,
      currency: order.currency,
      financial_status: order.financial_status,
      fulfillment_status: order.fulfillment_status,
      created_at: order.created_at,
      line_items: (order.line_items || []).map(li => ({
        id: li.id,
        title: li.title,
        sku: li.sku,
        quantity: li.quantity,
        price: li.price,
        variant_title: li.variant_title
      }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Shopify Refund (uses Shopify's built-in refund)
app.post('/api/shopify/refund', async (req, res) => {
  const { shop, order_id, amount, note } = req.body;
  if (!shop || !order_id) return res.status(400).json({ error: 'shop and order_id required' });
  const sr = await pool.query('SELECT access_token FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return res.status(404).json({ error: 'Store not connected' });
  try {
    const calcResp = await fetch(`https://${shop}/admin/api/2024-01/orders/${order_id}/refunds/calculate.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': sr.rows[0].access_token },
      body: JSON.stringify({ refund: { currency: 'INR', shipping: { full_refund: false } } })
    });
    const calcData = await calcResp.json();
    const refundResp = await fetch(`https://${shop}/admin/api/2024-01/orders/${order_id}/refunds.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': sr.rows[0].access_token },
      body: JSON.stringify({
        refund: {
          note: note || 'Refund via Taskly Returns',
          transactions: calcData.refund?.transactions || [],
          shipping: { full_refund: false }
        }
      })
    });
    const refundData = await refundResp.json();
    res.json(refundData);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Returns CRUD
app.get('/api/returns', async (req, res) => {
  const { shop, status } = req.query;
  let query = 'SELECT * FROM returns';
  const params = [];
  const conditions = [];
  if (shop) { conditions.push(`shop_domain=$${conditions.length+1}`); params.push(shop); }
  if (status) { conditions.push(`status=$${conditions.length+1}`); params.push(status); }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY created_at DESC';
  const r = await pool.query(query, params);
  res.json(r.rows);
});

app.get('/api/returns/stats', async (req, res) => {
  const { shop } = req.query;
  let where = '';
  const params = [];
  if (shop) { where = ' WHERE shop_domain=$1'; params.push(shop); }
  const total = await pool.query('SELECT COUNT(*) as count FROM returns' + where, params);
  const pending = await pool.query('SELECT COUNT(*) as count FROM returns' + (where || ' WHERE ') + (where ? ' AND ' : '') + "status='pending'", params);
  const approved = await pool.query('SELECT COUNT(*) as count FROM returns' + (where || ' WHERE ') + (where ? ' AND ' : '') + "status='approved'", params);
  const processed = await pool.query('SELECT COUNT(*) as count FROM returns' + (where || ' WHERE ') + (where ? ' AND ' : '') + "status='processed'", params);
  const rejected = await pool.query('SELECT COUNT(*) as count FROM returns' + (where || ' WHERE ') + (where ? ' AND ' : '') + "status='rejected'", params);
  const totalAmount = await pool.query('SELECT COALESCE(SUM(amount),0) as total FROM returns' + where, params);
  res.json({
    total: parseInt(total.rows[0].count),
    pending: parseInt(pending.rows[0].count),
    approved: parseInt(approved.rows[0].count),
    processed: parseInt(processed.rows[0].count),
    rejected: parseInt(rejected.rows[0].count),
    total_amount: parseFloat(totalAmount.rows[0].total)
  });
});

app.post('/api/returns', async (req, res) => {
  const { order_id, order_number, customer_name, customer_email, customer_phone, product_name, product_sku, quantity, reason, reason_detail, refund_method, amount, shop_domain } = req.body;
  const r = await pool.query(
    `INSERT INTO returns (order_id,order_number,customer_name,customer_email,customer_phone,product_name,product_sku,quantity,reason,reason_detail,refund_method,amount,shop_domain)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [order_id||'',order_number||'',customer_name||'',customer_email||'',customer_phone||'',product_name||'',product_sku||'',quantity||1,reason||'',reason_detail||'',refund_method||'original',amount||0,shop_domain||'']
  );
  res.json(r.rows[0]);
});

app.patch('/api/returns/:id', async (req, res) => {
  const { status, merchant_notes, tracking_number, pickup_status } = req.body;
  const fields = [];
  const values = [];
  let idx = 1;
  if (status) { fields.push(`status=$${idx++}`); values.push(status); }
  if (merchant_notes !== undefined) { fields.push(`merchant_notes=$${idx++}`); values.push(merchant_notes); }
  if (tracking_number !== undefined) { fields.push(`tracking_number=$${idx++}`); values.push(tracking_number); }
  if (pickup_status !== undefined) { fields.push(`pickup_status=$${idx++}`); values.push(pickup_status); }
  fields.push(`updated_at=NOW()`);
  values.push(req.params.id);
  const r = await pool.query(`UPDATE returns SET ${fields.join(',')} WHERE id=$${idx} RETURNING *`, values);
  res.json(r.rows[0]);
});

// Customer return tracking
app.get('/api/returns/track/:id', async (req, res) => {
  const r = await pool.query('SELECT id,order_id,order_number,customer_name,product_name,reason,status,refund_method,amount,tracking_number,pickup_status,created_at,updated_at FROM returns WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Return not found' });
  res.json(r.rows[0]);
});

app.get('/api/health', (req, res) => res.json({ ok: true, version: '2.0.0' }));

app.use(express.static(path.join(__dirname, '../client/build')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../client/build/index.html')));

const PORT = process.env.PORT || 3001;
initDB().then(() => app.listen(PORT, () => console.log('Taskly Returns v2.0 running on port ' + PORT)));
