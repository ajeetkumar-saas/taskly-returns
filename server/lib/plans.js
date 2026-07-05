// Plan pricing/limits config — shared between billing routes and admin plan-management routes.
// Extracted from server/index.js (Batch 4 Step 2, preparatory) — behavior unchanged, verbatim move.
const PLANS = {
  free: { name: 'Free', price: 0, returns: 5, trial_days: 0 },
  starter: { name: 'Starter', price: 11.99, returns: 50, trial_days: 15 },
  growth: { name: 'Growth', price: 23.99, returns: 150, trial_days: 15 },
  pro: { name: 'Pro', price: 47.99, returns: 500, trial_days: 15 }
};

module.exports = { PLANS };
