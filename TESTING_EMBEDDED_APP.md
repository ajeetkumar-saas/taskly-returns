# GoReturn Embedded App - Testing & Verification Guide

## 🎯 What Was Fixed

1. **Syntax Error (server/index.js:444)**: `storeP lan` → `storePlan` - CRITICAL for server startup
2. **Shop Domain Extraction**: Embedded app now extracts shop from Shopify App Bridge config and adds to URL
3. **Bearer Token + Shop Context**: Frontend sends both Bearer token + shop parameter to backend

---

## ✅ Testing Checklist

### Phase 1: Server Startup Verification
```
□ Server starts without syntax errors
  npm start in taskly-returns directory
  Should see: "Server running on port 3000" (or Railway equivalent)
  
□ No database connection errors in logs
  Check: npm logs or Railway logs
  Should see: Database connected successfully
```

### Phase 2: Admin Dashboard (Standalone Mode)
```
□ Login to https://localhost:3000 (or production URL)
  Expected: Dashboard loads with login page
  
□ Connect taskly-test-store
  Expected: Store list shows "taskly-test-store"
  
□ View returns
  Expected: Returns list loads (or "0 returns" if none created)
  
□ Create test return
  Expected: Return appears in list immediately
  
□ Modify return status
  Expected: Status updates without errors
```

### Phase 3: Embedded App (CRITICAL - This Was Broken)
```
□ Navigate to: admin.shopify.com/store/taskly-test-store/apps/goreturn
  Note: URL should have NO ?shop= parameter initially
  
□ Wait 2-3 seconds
  Expected: Page redirects to ?shop=taskly-test-store.myshopify.com
  
□ Verify Dashboard Loads
  Expected: Store metrics show (not all 0s)
  Expected: "Total Returns" / "Pending" / "Approved" etc. show actual numbers
  
□ Verify Stores List Loads
  Expected: "Connected Stores" dropdown shows "taskly-test-store"
  Expected: NOT showing "No stores connected"
  
□ View Returns Tab
  Expected: Returns table loads with data (or "No returns found")
  Expected: NOT showing loading spinner forever
```

### Phase 4: Data Isolation (Security)
```
□ Connect second store: taskly-test-store-2
  
□ In Admin Dashboard:
  Expected: Can switch between stores
  Expected: Each store shows ONLY its own returns
  Expected: Cannot see other store's data
  
□ In Embedded App (taskly-test-store):
  Expected: Shows only taskly-test-store's data
  Expected: Cannot access taskly-test-store-2's data
  
□ In Embedded App (taskly-test-store-2):
  Expected: Shows only taskly-test-store-2's data
  Expected: Cannot access taskly-test-store's data
```

### Phase 5: Create & Update Operations
```
□ From Embedded App: Create return
  Expected: Return appears in returns list
  Expected: Email notification sent (check inbox)
  
□ From Embedded App: Update return status to "approved"
  Expected: Status updates without 401 errors
  Expected: Email notification sent
  
□ From Admin Dashboard: Update same return to "refunded"
  Expected: Updates successfully
  Expected: Embedded app shows updated status
```

### Phase 6: Settings & Configuration
```
□ From Embedded App: Go to Settings
  Expected: Settings page loads (not 401 error)
  
□ Update portal settings
  Expected: Changes save without errors
  Expected: Changes visible in admin dashboard
  
□ From Embedded App: Go to Email Templates
  Expected: Templates load successfully
  
□ Update email template
  Expected: Changes save and are used for future notifications
```

### Phase 7: Analytics (Growth Plan Only)
```
□ Switch account to "Growth" plan in admin
  Expected: Analytics tab appears in embedded app
  
□ View analytics
  Expected: Data loads without 401 errors
  Expected: Charts display returns/revenue data
```

---

## 🔴 Common Issues & Solutions

### Issue: "No stores connected" after refresh
```
Root Cause: Shop domain not extracted from Shopify App Bridge
Solution: 
  1. Check browser console for errors
  2. Verify window.shopify is available
  3. Clear localStorage and refresh
  4. Check that URL has ?shop= after redirect
```

### Issue: All metrics show "0"
```
Root Cause: API requests returning empty data
Solution:
  1. Open Network tab in DevTools
  2. Check /api/returns request
  3. Verify ?shop= parameter is in URL
  4. Verify Authorization header has Bearer token
  5. Check server logs for errors
```

### Issue: 401 Unauthorized errors
```
Root Cause: Bearer token not being sent or not valid
Solution:
  1. Ensure shopAuthHeaders() is being used
  2. Verify window.shopify.idToken() is available
  3. Check that Bearer token is in Authorization header
  4. Backend requireShopAccess should accept it (lines 497-505)
```

### Issue: Settings/Email Templates don't load
```
Root Cause: Missing getAuthHeaders() or shopAuthHeaders()
Solution:
  1. Check if endpoint has middleware: requireShopAccess
  2. Verify it's sending Authorization header
  3. If standalone dashboard: ensure x-auth-token is set
```

---

## 🚀 Regression Prevention

### Code Review Checklist (For Future Changes)
Before making ANY changes that touch auth/shop context:

```
□ Check all fetch() calls have proper headers:
  - In embedded mode: await shopAuthHeaders()
  - In admin dashboard: getAuthHeaders()
  
□ Check all endpoints have middleware:
  - If needs shop context: requireShopAccess
  - If platform admin only: requireOwner
  - If public: No middleware (but add comments why)
  
□ Test BOTH modes:
  - Standalone admin dashboard
  - Embedded app in Shopify admin
  
□ Verify shop isolation:
  - Create test data in Store A
  - Verify it doesn't appear in Store B
  
□ Test plan enforcement:
  - Free plan: Limited features
  - Growth plan: Analytics available
  - Pro plan: All features
```

### Files That MUST Have Auth Headers

**Frontend (client/build/index.html):**
- ✅ loadReturns() - Uses shopAuthHeaders() ✓
- ✅ loadOrders() - Uses getAuthHeaders() ✓
- ✅ createReturn() - Uses shopAuthHeaders() ✓
- ✅ saveSettings() - Uses shopAuthHeaders() ✓
- ✅ loadEmailTemplates() - Uses getAuthHeaders() ✓
- ✅ saveEmailTemplates() - Uses shopAuthHeaders() ✓
- ✅ savePortalSettings() - Uses shopAuthHeaders() ✓
- ✅ loadLogisticsStatus() - Uses getAuthHeaders() ✓
- ✅ connectProvider() - Uses shopAuthHeaders() ✓
- ✅ disconnectProvider() - Uses shopAuthHeaders() ✓
- ✅ saveLogisticsSettings() - Uses shopAuthHeaders() ✓

**Backend (server/index.js):**
- ✅ /api/returns (GET) - Custom Bearer check + requireShopAccess ✓
- ✅ /api/returns (POST) - requireShopAccess ✓
- ✅ /api/shopify/orders - requireShopAccess ✓
- ✅ /api/settings - requireShopAccess ✓
- ✅ /api/email-templates - requireShopAccess ✓
- ✅ /api/portal-settings (POST) - requireShopAccess ✓
- ✅ /api/logistics/* - requireShopAccess ✓

---

## 📋 Final Acceptance Criteria

✅ **MUST PASS** before production:
- [ ] Server starts without syntax errors
- [ ] Embedded app shows store data (not 0s)
- [ ] Data is properly isolated by shop
- [ ] No 401/403 auth errors in embedded app
- [ ] Settings and email templates load
- [ ] Analytics available for Growth+ plans
- [ ] Notifications sent with proper content
- [ ] All operations (create/update/delete) work

✅ **NICE TO HAVE** (Enhancements):
- [ ] Loading indicators while fetching
- [ ] Better error messages
- [ ] Offline mode support
- [ ] Performance optimizations

---

## 🔗 Commit References

- **Commit a8a141d**: Added getAuthHeaders() to all frontend endpoints
- **Commit 0e3d7f0**: Fixed syntax error + embedded app shop domain extraction

---

**Last Updated**: July 4, 2026
**Status**: ✅ All fixes implemented and committed
