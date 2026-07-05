// Seller-facing analytics: return trends, Shopify order analysis, deep return breakdowns,
// customer fraud scoring, pincode risk scoring. Extracted from server/index.js (Batch 5 Part 1,
// Domain 2) — behavior unchanged, verbatim move.

const pool = require('../lib/db');
const { getStoreToken, shopifyFetchAllPages } = require('../lib/shopify');
const { requirePlan } = require('../lib/auth');

function registerAnalyticsRoutes(app) {
  // Analytics with date range
  app.get('/api/analytics', requirePlan('starter','analytics'), async (req, res) => {
    const { shop, days } = req.query;
    const d = parseInt(days) || 30;
    const p = shop ? [shop] : [];
    const w = shop ? ' AND shop_domain=$1' : '';
    const daily = await pool.query(
      `SELECT DATE(created_at) as date, COUNT(*) as count, COALESCE(SUM(amount),0) as amount,
       SUM(CASE WHEN type='exchange' THEN amount ELSE 0 END) as saved
       FROM returns WHERE created_at >= NOW() - INTERVAL '${d} days'${w}
       GROUP BY DATE(created_at) ORDER BY date`, p);
    const byReason = await pool.query(
      `SELECT reason, COUNT(*) as count FROM returns WHERE created_at >= NOW() - INTERVAL '${d} days'${w} GROUP BY reason ORDER BY count DESC LIMIT 10`, p);
    const byStatus = await pool.query(
      `SELECT status, COUNT(*) as count FROM returns WHERE created_at >= NOW() - INTERVAL '${d} days'${w} GROUP BY status`, p);
    res.json({ daily: daily.rows, by_reason: byReason.rows, by_status: byStatus.rows });
  });

  // Order Analytics — fetch all orders from Shopify and analyze
  app.get('/api/analytics/orders', requirePlan('starter','analytics'), async (req, res) => {
    const { shop } = req.query;
    if (!shop) return res.status(400).json({ error: 'shop required' });
    const sr = await getStoreToken(shop);
    if (!sr.rows.length) return res.status(404).json({ error: 'Store not connected' });
    try {
      const orders = await shopifyFetchAllPages(`https://${shop}/admin/api/2025-04/orders.json?status=any&limit=250`, {
        headers: { 'X-Shopify-Access-Token': sr.rows[0].access_token }
      });

      const totalOrders = orders.length;
      const totalRevenue = orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
      const codOrders = orders.filter(o => o.gateway === 'Cash on Delivery (COD)' || o.payment_gateway_names?.some(g => g.toLowerCase().includes('cod'))).length;
      const prepaidOrders = totalOrders - codOrders;

      const byCity = {};
      const byState = {};
      const byPincode = {};
      orders.forEach(o => {
        const addr = o.shipping_address || o.billing_address || {};
        const city = addr.city || 'Unknown';
        const state = addr.province || 'Unknown';
        const pin = addr.zip || 'Unknown';
        byCity[city] = (byCity[city] || 0) + 1;
        byState[state] = (byState[state] || 0) + 1;
        byPincode[pin] = (byPincode[pin] || 0) + 1;
      });

      const byProduct = {};
      orders.forEach(o => {
        (o.line_items || []).forEach(li => {
          const name = li.title || 'Unknown';
          if (!byProduct[name]) byProduct[name] = { sold: 0, revenue: 0 };
          byProduct[name].sold += li.quantity;
          byProduct[name].revenue += parseFloat(li.price) * li.quantity;
        });
      });

      const byDate = {};
      orders.forEach(o => {
        const d = new Date(o.created_at).toISOString().split('T')[0];
        if (!byDate[d]) byDate[d] = { count: 0, revenue: 0 };
        byDate[d].count++;
        byDate[d].revenue += parseFloat(o.total_price || 0);
      });

      const topCities = Object.entries(byCity).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([city, count]) => ({ city, count }));
      const topStates = Object.entries(byState).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([state, count]) => ({ state, count }));
      const topPincodes = Object.entries(byPincode).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([pincode, count]) => ({ pincode, count }));
      const topProducts = Object.entries(byProduct).sort((a, b) => b[1].sold - a[1].sold).slice(0, 20).map(([name, data]) => ({ name, sold: data.sold, revenue: Math.round(data.revenue) }));
      const dailyOrders = Object.entries(byDate).sort((a, b) => a[0].localeCompare(b[0])).slice(-30).map(([date, data]) => ({ date, count: data.count, revenue: Math.round(data.revenue) }));

      res.json({
        total_orders: totalOrders, total_revenue: Math.round(totalRevenue),
        cod_orders: codOrders, prepaid_orders: prepaidOrders,
        cod_percent: totalOrders ? Math.round(codOrders / totalOrders * 100) : 0,
        top_cities: topCities, top_states: topStates, top_pincodes: topPincodes,
        top_products: topProducts, daily_orders: dailyOrders
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Return Analytics by location and product
  app.get('/api/analytics/returns-deep', requirePlan('starter','analytics'), async (req, res) => {
    const { shop } = req.query;
    if (!shop) return res.status(400).json({ error: 'shop required' });
    const sr = await getStoreToken(shop);
    if (!sr.rows.length) return res.json({ by_product: [], by_city: [] });
    try {
      const orders = await shopifyFetchAllPages(`https://${shop}/admin/api/2025-04/orders.json?status=any&limit=250`, {
        headers: { 'X-Shopify-Access-Token': sr.rows[0].access_token }
      });
      const orderMap = {};
      orders.forEach(o => {
        orderMap[o.name] = o;
        orderMap[String(o.id)] = o;
      });

      const returns = await pool.query('SELECT * FROM returns WHERE shop_domain=$1', [shop]);
      const byProduct = {};
      const byCity = {};
      const byPincode = {};

      returns.rows.forEach(ret => {
        const prod = ret.product_name || 'Unknown';
        if (!byProduct[prod]) byProduct[prod] = { returns: 0, exchanges: 0, amount: 0 };
        if (ret.type === 'exchange') byProduct[prod].exchanges++;
        else byProduct[prod].returns++;
        byProduct[prod].amount += parseFloat(ret.amount || 0);

        const order = orderMap[ret.order_number] || orderMap[ret.order_id];
        if (order) {
          const addr = order.shipping_address || order.billing_address || {};
          const city = addr.city || 'Unknown';
          const pin = addr.zip || 'Unknown';
          byCity[city] = (byCity[city] || 0) + 1;
          byPincode[pin] = (byPincode[pin] || 0) + 1;
        }
      });

      const productData = Object.entries(byProduct).sort((a, b) => (b[1].returns + b[1].exchanges) - (a[1].returns + a[1].exchanges)).slice(0, 20).map(([name, data]) => ({ name, ...data, total: data.returns + data.exchanges }));
      const cityData = Object.entries(byCity).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([city, count]) => ({ city, count }));
      const pincodeData = Object.entries(byPincode).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([pincode, count]) => ({ pincode, count }));

      res.json({ by_product: productData, by_city: cityData, by_pincode: pincodeData });
    } catch(e) { console.log('returns-deep error:', e.message); res.status(500).json({ error: 'Failed to load deep analytics' }); }
  });

  // Customer fraud score
  app.get('/api/analytics/fraud', requirePlan('growth','fraud'), async (req, res) => {
    const { shop } = req.query;
    if (!shop) return res.status(400).json({ error: 'shop required' });
    try {
      const r = await pool.query(
        `SELECT customer_email, customer_name, COUNT(*) as return_count, COALESCE(SUM(amount),0) as total_amount,
         MAX(created_at) as last_return FROM returns WHERE shop_domain=$1 AND customer_email!=''
         GROUP BY customer_email, customer_name HAVING COUNT(*) >= 2 ORDER BY COUNT(*) DESC LIMIT 20`, [shop]);
      const customers = r.rows.map(c => ({
        ...c, return_count: parseInt(c.return_count), total_amount: Math.round(parseFloat(c.total_amount)),
        risk: parseInt(c.return_count) >= 5 ? 'high' : parseInt(c.return_count) >= 3 ? 'medium' : 'low'
      }));
      res.json(customers);
    } catch(e) { res.json([]); }
  });

  // Pincode risk score
  app.get('/api/analytics/pincode-risk', requirePlan('growth','pincode'), async (req, res) => {
    const { shop } = req.query;
    if (!shop) return res.status(400).json({ error: 'shop required' });
    const sr = await getStoreToken(shop);
    if (!sr.rows.length) return res.json([]);
    try {
      const orders = await shopifyFetchAllPages(`https://${shop}/admin/api/2025-04/orders.json?status=any&limit=250`, {
        headers: { 'X-Shopify-Access-Token': sr.rows[0].access_token }
      });
      const returns = await pool.query('SELECT * FROM returns WHERE shop_domain=$1', [shop]);
      const orderMap = {};
      orders.forEach(o => { orderMap[o.name] = o; orderMap[String(o.id)] = o; });

      const pincodeData = {};
      orders.forEach(o => {
        const pin = o.shipping_address?.zip || 'Unknown';
        const city = o.shipping_address?.city || 'Unknown';
        if (!pincodeData[pin]) pincodeData[pin] = { pincode: pin, city, orders: 0, returns: 0 };
        pincodeData[pin].orders++;
      });
      returns.rows.forEach(ret => {
        const order = orderMap[ret.order_number] || orderMap[ret.order_id];
        if (order) {
          const pin = order.shipping_address?.zip || 'Unknown';
          if (pincodeData[pin]) pincodeData[pin].returns++;
        }
      });

      const result = Object.values(pincodeData)
        .map(p => ({ ...p, return_rate: p.orders ? Math.round(p.returns / p.orders * 100) : 0,
          risk: p.orders >= 3 && (p.returns / p.orders) >= 0.3 ? 'high' : (p.returns / p.orders) >= 0.15 ? 'medium' : 'low' }))
        .filter(p => p.orders >= 2)
        .sort((a, b) => b.return_rate - a.return_rate).slice(0, 20);
      res.json(result);
    } catch(e) { res.json([]); }
  });
}

module.exports = { registerAnalyticsRoutes };
