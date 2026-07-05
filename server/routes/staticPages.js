// Static page-serving routes — pure res.sendFile()/express.static, zero business logic, zero
// dependency on any mutable state. Extracted from server/index.js (Batch 4 Step 2, Group 1) —
// behavior unchanged, verbatim move.
//
// IMPORTANT: registerStaticPageRoutes(app) must be called at the exact same point in index.js's
// route-registration order as this code used to run — Express matches routes in registration
// order, and the catch-all app.get('*', ...) here must remain the LAST route registered (after
// every other route in the app), exactly as it was before extraction.

const express = require('express');
const path = require('path');

function registerStaticPageRoutes(app) {
  app.get('/', async (req, res) => {
    const shop = req.query.shop;
    if (shop) {
      // Shopify embedded app (seller view) - separate file so admin dashboard changes never affect it
      return res.sendFile(path.join(__dirname, '../../client/build/embedded.html'));
    }
    res.sendFile(path.join(__dirname, '../../client/build/landing.html'));
  });
  app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '../../client/build/login.html')));
  app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../../client/build/index.html')));
  app.get('/return', (req, res) => res.sendFile(path.join(__dirname, '../../client/build/return.html')));
  app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, '../../client/build/privacy.html')));

  app.use(express.static(path.join(__dirname, '../../client/build'), { index: false }));

  app.get('*', (req, res) => {
    // Any unmatched deep link: route by whether it's the Shopify embedded context (?shop=) or admin
    if (req.query.shop) {
      return res.sendFile(path.join(__dirname, '../../client/build/embedded.html'));
    }
    res.sendFile(path.join(__dirname, '../../client/build/index.html'));
  });
}

module.exports = { registerStaticPageRoutes };
