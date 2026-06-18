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
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS returns (
      id SERIAL PRIMARY KEY,
      shop_domain VARCHAR(255) DEFAULT '',
      order_id VARCHAR(255),
      customer_name VARCHAR(255),
      customer_email VARCHAR(255),
      product_name TEXT,
      reason TEXT,
      status VARCHAR(50) DEFAULT 'pending',
      refund_method VARCHAR(50) DEFAULT 'cod',
      amount NUMERIC(10,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('DB ready');
}

app.get('/api/auth/shopify', (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  const nonce = crypto.randomBytes(16).toString('hex');
  const redirectUri = encodeURIComponent(`${APP_URL}/api/auth/callback`);
  const scopes = 'read_orders,write_orders,read_customers,read_products';
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
    await pool.query('INSERT INTO shopify_stores (shop_domain, access_token) VALUES ($1,$2) ON CONFLICT (shop_domain) DO UPDATE SET access_token=$2', [shop, access_token]);
    res.redirect(`/?shop=${shop}&connected=true`);
  } catch(e) { res.status(500).send('OAuth error: ' + e.message); }
});

app.get('/api/shopify/stores', async (req, res) => {
  const r = await pool.query('SELECT shop_domain, created_at FROM shopify_stores ORDER BY created_at DESC');
  res.json(r.rows);
});

app.get('/api/shopify/orders', async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  const sr = await pool.query('SELECT access_token FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return res.status(404).json({ error: 'Store not connected' });
  const r = await fetch(`https://${shop}/admin/api/2024-01/orders.json?status=any&limit=50`, { headers: { 'X-Shopify-Access-Token': sr.rows[0].access_token } });
  const d = await r.json();
  res.json(d.orders || []);
});

app.get('/api/returns', async (req, res) => {
  const r = await pool.query('SELECT * FROM returns ORDER BY created_at DESC');
  res.json(r.rows);
});

app.post('/api/returns', async (req, res) => {
  const { order_id, customer_name, customer_email, product_name, reason, refund_method, amount, shop_domain } = req.body;
  const r = await pool.query(
    'INSERT INTO returns (order_id,customer_name,customer_email,product_name,reason,refund_method,amount,shop_domain) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [order_id||'', customer_name||'', customer_email||'', product_name||'', reason||'', refund_method||'cod', amount||0, shop_domain||'']
  );
  res.json(r.rows[0]);
});

app.patch('/api/returns/:id', async (req, res) => {
  const r = await pool.query('UPDATE returns SET status=$1 WHERE id=$2 RETURNING *', [req.body.status, req.params.id]);
  res.json(r.rows[0]);
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, '../client/build')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../client/build/index.html')));

const PORT = process.env.PORT || 3001;
initDB().then(() => app.listen(PORT, () => console.log('Server on port ' + PORT)));
