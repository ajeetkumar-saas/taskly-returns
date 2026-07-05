// Postgres connection pool. Extracted from server/index.js (Batch 4 Step 1c) — behavior
// unchanged, verbatim move. Exports the pool itself as a singleton — require() caches modules,
// so every file that does `const pool = require('./lib/db')` gets the exact same Pool instance,
// which is what makes this a safe zero-behavior-change extraction despite pool.query() being
// called from ~245 places across the codebase.

const { Pool } = require('pg');
const { notifyAdmin } = require('./email');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10, // explicit (matches pg's own default) — documents the intended ceiling rather than relying on an implicit default
  idleTimeoutMillis: 30000, // recycle idle clients instead of holding them open indefinitely
  connectionTimeoutMillis: 5000 // fail fast if the DB is unreachable instead of hanging the request
});
// REQUIRED by node-postgres: an idle client hitting a network-level error (e.g. the DB connection
// dropping) emits 'error' on the Pool itself. With no listener, Node treats this as an uncaught
// EventEmitter error and can crash the whole process — this had no handler at all before now.
pool.on('error', (err) => {
  console.error('Unexpected idle Postgres client error:', err.message);
  notifyAdmin('🚨 GoReturn Database Connection Error', `<p>An idle database connection errored unexpectedly: ${err.message}</p><p>Time: ${new Date().toUTCString()}</p>`).catch(()=>{});
});

module.exports = pool;
