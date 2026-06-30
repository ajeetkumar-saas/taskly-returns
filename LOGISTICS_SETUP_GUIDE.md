# GoReturn Multi-Logistics Setup Guide

GoReturn now supports 6 major Indian logistics providers for automated returns management. Each provider offers unique advantages. Choose based on your business needs.

## Quick Comparison

| Provider | Ease | Speed | Coverage | Best For |
|----------|------|-------|----------|----------|
| **Shiprocket** | ⭐⭐⭐⭐⭐ | Multi-carrier | Pan-India | Flexibility & multi-carrier |
| **ClickPost** | ⭐⭐⭐⭐⭐ | Fast | Pan-India | Dedicated returns |
| **Shadowfax** | ⭐⭐⭐⭐ | 1-2 hrs | Pan-India | Speed & same-day |
| **Delhivery** | ⭐⭐⭐ | 1-2 days | Pan-India (20K+) | Largest network |
| **XpressBees** | ⭐⭐⭐ | 1-2 days | Pan-India (18K+) | High volume (3M+/day) |
| **WareIQ** | ⭐⭐⭐⭐ | 1-2 days | Pan-India | WMS + returns combined |

---

## Provider Setup Guides

### 1. SHIPROCKET ✅ (Already Integrated)

**Sign up:** https://www.shiprocket.in/

**Steps:**
1. Create Shiprocket account
2. Go to `Settings → Additional Settings → API Users`
3. Click "Create New API User"
4. Set modules: `Orders`, `Shipments`, `Settings`
5. System generates API credentials
6. Copy email & password into GoReturn

**API Credentials:**
- Email (Shiprocket account)
- Password (auto-generated)

**Advantage:** Multi-carrier aggregator - can route to Delhivery, Ecom Express, Blue Dart, etc.

---

### 2. CLICKPOST 🎯 (Easiest - Recommended First)

**Sign up:** https://www.clickpost.ai/signup

**Steps:**
1. Create ClickPost account (free)
2. Go to `Settings → API Keys`
3. Click "Create New API Key"
4. Copy the token
5. Paste into GoReturn

**API Credentials:**
- API Token (from Settings)

**Advantages:**
- Dedicated to returns management
- Shopify-native integration
- Automatic label generation
- Real-time tracking

**Get API Key:**
```
Dashboard → Settings → API Keys → Generate
```

---

### 3. SHADOWFAX ⚡ (Fast - Same-Day Pickup)

**Sign up:** https://www.shadowfax.in/seller

**Steps:**
1. Create Shadowfax seller account
2. Complete KYC verification (ID + Bank details)
3. Go to `Settings → API Credentials`
4. Copy Client ID & Client Secret
5. Paste into GoReturn

**API Credentials:**
- Client ID
- Client Secret

**Advantages:**
- 1-2 hour pickup response
- Same-day returns processing
- Strong on reverse logistics

**Get Credentials:**
```
Dashboard → Settings → API Credentials
```

---

### 4. DELHIVERY 📦 (Largest Network)

**Sign up:** https://www.delhivery.com/sell-with-us

**Steps:**
1. Create Delhivery seller account
2. Complete onboarding & verification
3. Go to `Profile → Settings → API Access`
4. Request API access (takes 24-48 hrs)
5. Copy API Key
6. Paste into GoReturn

**API Credentials:**
- API Key

**Advantages:**
- Largest network in India (20K+ pincodes)
- Strong B2B partnerships
- Reverse logistics support

**Get API Key:**
```
Dashboard → Settings → API Access → Generate API Key
```

---

### 5. XPRESSBEES 🚀 (High Volume)

**Sign up:** https://www.xpressbees.com/onboarding

**Steps:**
1. Create XpressBees seller account
2. Complete KYC (Photo ID, PAN, Bank)
3. Go to `Settings → Integrations → API`
4. Generate API Token
5. Paste into GoReturn

**API Credentials:**
- API Token

**Advantages:**
- Handles 3M+ shipments/day
- Modern REST API
- Advanced tracking

**Get Token:**
```
Dashboard → Settings → Integrations → API → Generate Token
```

---

### 6. WAREIQ 🏭 (WMS + Returns)

**Sign up:** https://www.wareiq.com/seller

**Steps:**
1. Create WareIQ account
2. Integrate your inventory first
3. Go to `Settings → API → Generate Credentials`
4. Copy Client ID & Client Secret
5. Paste into GoReturn

**API Credentials:**
- Client ID
- Client Secret

**Advantages:**
- Warehouse management system included
- Returns + inventory combined
- AI-powered optimization

**Get Credentials:**
```
Dashboard → Settings → API Management → New Credentials
```

---

## How to Use Multiple Providers

### Switching Between Providers

1. Go to **GoReturn Admin → Logistics Providers**
2. See list of all connected providers
3. Click "Set as Default" on any provider
4. Future returns will use that provider's automation

### Fallback Strategy

Set up 2-3 providers as backup:
- **Primary:** ClickPost (dedicated returns)
- **Backup 1:** Shadowfax (if ClickPost unavailable)
- **Backup 2:** Shiprocket (multi-carrier fallback)

### Auto-Pickup Configuration

For each provider, you can:
- Enable `Auto-pickup on approval` — automatically triggers pickup when return is approved
- Disable for manual pickup — you trigger pickup manually for each return
- Set pickup location per provider (if required by provider)

---

## Troubleshooting

### "Connection Failed"
- Check if API credentials are correct
- Verify account is active (not suspended)
- Ensure IP whitelisting (if applicable)

### "Pickup Not Triggered"
- Confirm auto-pickup is enabled
- Check return address is valid
- Verify pickup location is set (for providers requiring it)

### "Label Not Generated"
- Ensure customer phone number is present
- Check return address completeness
- Try manually triggering from GoReturn dashboard

---

## Cost Comparison

| Provider | Per-Return | Monthly | Notes |
|----------|-----------|---------|-------|
| **Shiprocket** | ₹0-50 | Variable | Depends on selected courier |
| **ClickPost** | ₹20-40 | Variable | Cheapest for dedicated returns |
| **Shadowfax** | ₹60-100 | Variable | Premium for speed |
| **Delhivery** | ₹30-60 | Variable | Economy + premium options |
| **XpressBees** | ₹40-70 | Variable | Volume discounts available |
| **WareIQ** | ₹50+ | ₹5K+ base | Best for high-volume sellers |

---

## Recommended Setup

### For Small Stores (< 100 returns/month)
1. **ClickPost** (primary) - dedicated returns, easiest setup
2. **Shiprocket** (backup) - multi-carrier flexibility

### For Medium Stores (100-1000 returns/month)
1. **ClickPost** (primary)
2. **Shadowfax** (secondary for speed)
3. **Delhivery** (tertiary for coverage)

### For Large Stores (> 1000 returns/month)
1. **ClickPost** + **Shadowfax** (primary dual-setup for redundancy)
2. **Delhivery** + **XpressBees** (scalability)
3. **WareIQ** (if managing warehouse)

---

## Support

For provider-specific issues:
- **ClickPost Support:** support@clickpost.ai
- **Shadowfax Support:** seller@shadowfax.in
- **Delhivery Support:** seller-support@delhivery.com
- **XpressBees Support:** seller-care@xpressbees.com
- **WareIQ Support:** support@wareiq.com

For GoReturn integration issues, contact: ajeetkumar.saas@gmail.com
