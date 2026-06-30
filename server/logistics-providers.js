// Multi-logistics provider integrations
// Supports: ClickPost, Shadowfax, Delhivery, XpressBees, WareIQ

const fetch = require('node-fetch');

// ============ CLICKPOST ============
class ClickPost {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.base = 'https://www.clickpost.ai/api/v1';
  }

  async createReturn(returnData) {
    // ClickPost: Create return order for reverse logistics
    const payload = {
      order_id: returnData.order_id,
      customer_name: returnData.customer_name,
      customer_email: returnData.customer_email,
      customer_phone: returnData.customer_phone,
      product_name: returnData.product_name,
      product_sku: returnData.product_sku,
      return_reason: returnData.reason,
      return_amount: returnData.amount || 0,
      return_address: returnData.return_address || {}
    };

    const r = await fetch(`${this.base}/returns/create/`, {
      method: 'POST',
      headers: { 'Authorization': `Token ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return r.json();
  }

  async generateLabel(returnId) {
    const r = await fetch(`${this.base}/returns/${returnId}/label/`, {
      method: 'GET',
      headers: { 'Authorization': `Token ${this.apiKey}` }
    });
    return r.json();
  }

  async trackReturn(returnId) {
    const r = await fetch(`${this.base}/returns/${returnId}/`, {
      method: 'GET',
      headers: { 'Authorization': `Token ${this.apiKey}` }
    });
    return r.json();
  }
}

// ============ SHADOWFAX ============
class Shadowfax {
  constructor(clientId, clientSecret) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.base = 'https://api.shadowfax.in';
    this.token = '';
    this.tokenExpiry = 0;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpiry) return this.token;

    const r = await fetch(`${this.base}/oauth/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'client_credentials'
      })
    });
    const d = await r.json();
    this.token = d.access_token;
    this.tokenExpiry = Date.now() + (d.expires_in * 1000);
    return this.token;
  }

  async createPickup(pickupData) {
    // Shadowfax: Create pickup for return shipment
    const token = await this.getToken();
    const payload = {
      order_number: pickupData.order_id,
      customer_name: pickupData.customer_name,
      customer_phone: pickupData.customer_phone,
      customer_email: pickupData.customer_email,
      pickup_address: pickupData.pickup_address || {},
      delivery_address: pickupData.return_address || {},
      cod_amount: 0,
      package_weight: 1,
      package_length: 20,
      package_width: 15,
      package_height: 10
    };

    const r = await fetch(`${this.base}/api/orders/`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return r.json();
  }

  async trackShipment(shipmentId) {
    const token = await this.getToken();
    const r = await fetch(`${this.base}/api/orders/${shipmentId}/`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    return r.json();
  }
}

// ============ DELHIVERY ============
class Delhivery {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.base = 'https://track.delhivery.com/api';
  }

  async createShipment(shipmentData) {
    // Delhivery: Create reverse shipment for returns
    const payload = {
      waybill: '',
      customer_name: shipmentData.customer_name,
      order_number: shipmentData.order_id,
      phone: shipmentData.customer_phone,
      email: shipmentData.customer_email,
      address: shipmentData.pickup_address?.street || '',
      city: shipmentData.pickup_address?.city || '',
      state: shipmentData.pickup_address?.state || '',
      pincode: shipmentData.pickup_address?.pincode || '',
      delivery_name: shipmentData.customer_name,
      delivery_address: shipmentData.return_address?.street || '',
      delivery_city: shipmentData.return_address?.city || '',
      delivery_state: shipmentData.return_address?.state || '',
      delivery_pincode: shipmentData.return_address?.pincode || '',
      weight: 1,
      product_list: [{ name: shipmentData.product_name, qty: 1 }],
      cod: 0,
      special_instructions: 'Return shipment'
    };

    const formData = new URLSearchParams();
    Object.entries(payload).forEach(([k, v]) => formData.append(k, v));
    formData.append('api_key', this.apiKey);

    const r = await fetch(`${this.base}/v1/create/`, {
      method: 'POST',
      body: formData,
      headers: { 'Authorization': `Token ${this.apiKey}` }
    });
    return r.text().then(t => ({ waybill: t.trim() }));
  }

  async trackShipment(waybill) {
    const r = await fetch(`${this.base}/v1/package/json/?waybill=${waybill}&api_key=${this.apiKey}`);
    return r.json();
  }
}

// ============ XPRESSBEES ============
class XpressBees {
  constructor(apiToken) {
    this.apiToken = apiToken;
    this.base = 'https://www.xpressbees.com/api/';
  }

  async createOrder(orderData) {
    // XpressBees: Create reverse pickup order
    const payload = {
      order_reference_id: orderData.order_id,
      customer_name: orderData.customer_name,
      customer_email: orderData.customer_email,
      customer_phone: orderData.customer_phone,
      delivery_address: orderData.return_address || {},
      weight: 1,
      packing_type: 'BOX',
      value_of_goods: orderData.amount || 0,
      is_reverse: true
    };

    const r = await fetch(`${this.base}shipment/create/`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return r.json();
  }

  async trackShipment(shipmentId) {
    const r = await fetch(`${this.base}shipment/track/${shipmentId}/`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${this.apiToken}` }
    });
    return r.json();
  }
}

// ============ WAREIQ ============
class WareIQ {
  constructor(clientId, clientSecret) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.base = 'https://api.wareiq.com/v1';
    this.token = '';
    this.tokenExpiry = 0;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpiry) return this.token;

    const r = await fetch(`${this.base}/auth/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret
      })
    });
    const d = await r.json();
    this.token = d.access_token;
    this.tokenExpiry = Date.now() + (d.expires_in * 1000);
    return this.token;
  }

  async createReverseOrder(orderData) {
    const token = await this.getToken();
    const payload = {
      order_id: orderData.order_id,
      customer_name: orderData.customer_name,
      customer_email: orderData.customer_email,
      customer_phone: orderData.customer_phone,
      origin_address: orderData.return_address || {},
      order_type: 'RETURN',
      weight: 1
    };

    const r = await fetch(`${this.base}/orders/create/`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return r.json();
  }

  async trackOrder(orderId) {
    const token = await this.getToken();
    const r = await fetch(`${this.base}/orders/${orderId}/track/`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    return r.json();
  }
}

module.exports = {
  ClickPost,
  Shadowfax,
  Delhivery,
  XpressBees,
  WareIQ
};
