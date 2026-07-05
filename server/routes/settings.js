// Store configuration routes: public portal customization, seller settings (return/exchange
// windows, auto-approve), and per-store email template customization. Extracted from
// server/index.js (Batch 5 Part 1, Domain 3) — behavior unchanged, verbatim move.

const pool = require('../lib/db');
const { logActivity } = require('../lib/activityLog');
const { requireShopAccess } = require('../lib/auth');
const { getEmailTemplates, DEFAULT_EMAIL_TEMPLATES } = require('../lib/emailTemplates');

function registerSettingsRoutes(app) {
  // Portal customization API (public - no auth needed)
  app.get('/api/portal-settings', async (req, res) => {
    const { shop } = req.query;
    if (!shop) return res.json({});
    try {
      const store = await pool.query('SELECT store_name, portal_color FROM shopify_stores WHERE shop_domain=$1', [shop]);
      const settings = await pool.query('SELECT * FROM store_settings WHERE shop_domain=$1', [shop]);
      const s = store.rows[0] || {};
      const ss = settings.rows[0] || {};
      res.json({
        store_name: s.store_name || shop.replace('.myshopify.com', ''),
        color: s.portal_color || '#4F46E5',
        heading: ss.portal_heading || 'Return & Exchange Portal',
        subheading: ss.portal_subheading || 'Submit your return request in 3 easy steps',
        logo_url: ss.portal_logo || '',
        return_reasons: (ss.return_reasons && ss.return_reasons.includes(',')) ? ss.return_reasons : 'Damaged Product,Wrong Item Received,Size/Fit Issue,Quality Not As Expected,Not As Described,Changed My Mind',
        exchange_reasons: (ss.exchange_reasons && ss.exchange_reasons.includes(',')) ? ss.exchange_reasons : 'Wrong Size,Wrong Color,Want Different Product',
        exchange_enabled: ss.exchange_enabled !== false,
        refund_methods: 'Original Payment Method'
      });
    } catch(e) { res.json({}); }
  });

  // Save portal customization
  app.post('/api/portal-settings', requireShopAccess, async (req, res) => {
    const { shop, heading, subheading, logo_url, exchange_enabled } = req.body;
    if (!shop) return res.status(400).json({ error: 'shop required' });
    try {
      await pool.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS portal_heading TEXT DEFAULT 'Return & Exchange Portal'`);
      await pool.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS portal_subheading TEXT DEFAULT 'Submit your return request in 3 easy steps'`);
      await pool.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS portal_logo TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS exchange_enabled BOOLEAN DEFAULT true`);
      await pool.query(
        `INSERT INTO store_settings (shop_domain, portal_heading, portal_subheading, portal_logo, exchange_enabled)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (shop_domain) DO UPDATE SET portal_heading=$2, portal_subheading=$3, portal_logo=$4, exchange_enabled=$5`,
        [shop, heading||'Return & Exchange Portal', subheading||'Submit your return request in 3 easy steps', logo_url||'', exchange_enabled!==false]);
      res.json({ ok: true });
    } catch(e) { console.log('portal-settings error:', e.message); res.status(500).json({ error: 'Failed to save portal settings' }); }
  });

  app.get('/api/settings', requireShopAccess, async (req, res) => {
    const { shop } = req.query;
    if (!shop) return res.status(400).json({ error: 'shop required' });
    const store = await pool.query('SELECT portal_color,portal_banner,return_window,exchange_window,auto_approve_under,notify_email FROM shopify_stores WHERE shop_domain=$1', [shop]);
    const settings = await pool.query('SELECT * FROM store_settings WHERE shop_domain=$1', [shop]);
    res.json({ store: store.rows[0] || {}, settings: settings.rows[0] || {} });
  });

  app.post('/api/settings', requireShopAccess, async (req, res) => {
    const { shop, portal_color, return_window, exchange_window, auto_approve_under, notify_email, return_reasons, exchange_reasons, refund_methods, auto_approve_enabled } = req.body;
    if (!shop) return res.status(400).json({ error: 'shop required' });
    await pool.query('UPDATE shopify_stores SET portal_color=$1, return_window=$2, exchange_window=$3, auto_approve_under=$4, notify_email=$5 WHERE shop_domain=$6',
      [portal_color||'#4F46E5', return_window||14, exchange_window||14, auto_approve_under||0, notify_email!==false, shop]);
    await pool.query(
      `INSERT INTO store_settings (shop_domain, return_reasons, exchange_reasons, refund_methods, auto_approve_enabled, auto_approve_amount)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (shop_domain) DO UPDATE SET return_reasons=$2, exchange_reasons=$3, refund_methods=$4, auto_approve_enabled=$5, auto_approve_amount=$6`,
      [shop, return_reasons||'', exchange_reasons||'', refund_methods||'', auto_approve_enabled||false, auto_approve_under||0]);
    res.json({ ok: true });
  });

  // ---- Email Templates (per-store customization) ----
  app.get('/api/email-templates', requireShopAccess, async (req, res) => {
    const { shop } = req.query;
    if (!shop) return res.json({ templates: DEFAULT_EMAIL_TEMPLATES, defaults: DEFAULT_EMAIL_TEMPLATES });
    const templates = await getEmailTemplates(shop);
    res.json({ templates, defaults: DEFAULT_EMAIL_TEMPLATES });
  });
  app.post('/api/email-templates', requireShopAccess, async (req, res) => {
    const { shop, templates } = req.body;
    if (!shop) return res.status(400).json({ error: 'shop required' });
    try {
      await pool.query('ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS email_templates TEXT');
      await pool.query(
        `INSERT INTO store_settings (shop_domain, email_templates) VALUES ($1,$2)
         ON CONFLICT (shop_domain) DO UPDATE SET email_templates=$2`,
        [shop, JSON.stringify(templates||{})]);
      logActivity(req, 'Email Templates Updated', `Store ${shop}`);
      res.json({ ok: true });
    } catch(e) { console.log('email-templates save error:', e.message); res.status(500).json({ error: 'Failed to save email templates' }); }
  });
}

module.exports = { registerSettingsRoutes };
