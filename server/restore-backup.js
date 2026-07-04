// Standalone disaster-recovery restore script — NOT imported or run by server/index.js, and
// NOT wired to any HTTP route. Run manually by a human when actually needed:
//
//   node server/restore-backup.js path/to/goreturn-backup-YYYY-MM-DD.json           (dry run by default)
//   node server/restore-backup.js path/to/goreturn-backup-YYYY-MM-DD.json --apply    (actually writes)
//
// Requires DATABASE_URL in the environment (same variable the main app uses) — e.g. run this
// via `railway run node server/restore-backup.js backup.json --apply` against the target DB.
//
// Design goal: this can NEVER delete or overwrite existing data. Every insert uses
// "ON CONFLICT DO NOTHING", so restoring into a database that already has some/all of the rows
// is always a safe no-op for anything that already exists — it only fills in rows that are
// genuinely missing. There is no "wipe and replace" mode on purpose.
//
// Known limitation (by design, matches the backup email's own note): access_token,
// refresh_token, password_hash, and other credential columns are excluded from the backup for
// security, so restored shopify_stores rows will need the merchant to reconnect via Shopify
// re-auth, and restored admin_users/team_members rows will need a password reset — this script
// will print exactly which rows need that follow-up action.

const { Pool } = require('pg');
const fs = require('fs');

async function main() {
  const filePath = process.argv[2];
  const apply = process.argv.includes('--apply');

  if (!filePath) {
    console.error('Usage: node server/restore-backup.js <backup.json> [--apply]');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set in the environment — refusing to guess which database to restore into.');
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  let dump;
  try {
    dump = JSON.parse(raw);
  } catch (e) {
    console.error('Backup file is not valid JSON:', e.message);
    process.exit(1);
  }

  const tables = ['shopify_stores', 'returns', 'store_settings', 'team_members', 'admin_users', 'activity_log'];
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  console.log(`\n=== GoReturn Backup Restore ${apply ? '(APPLY MODE — will write)' : '(DRY RUN — no changes will be made)'} ===`);
  console.log(`Backup generated at: ${dump._meta?.generated_at || 'unknown'}`);

  let totalWouldInsert = 0;
  const needsReconnect = [];
  const needsPasswordReset = [];

  for (const table of tables) {
    const rows = dump[table];
    if (!Array.isArray(rows)) { console.log(`  ${table}: not present in this backup, skipping.`); continue; }
    if (!rows.length) { console.log(`  ${table}: 0 rows in backup.`); continue; }

    const columns = Object.keys(rows[0]);
    console.log(`  ${table}: ${rows.length} row(s) in backup, columns: ${columns.join(', ')}`);
    totalWouldInsert += rows.length;

    if (table === 'shopify_stores') rows.forEach(r => needsReconnect.push(r.shop_domain));
    if (table === 'admin_users' || table === 'team_members') rows.forEach(r => needsPasswordReset.push(`${table}: ${r.email}`));

    if (!apply) continue;

    for (const row of rows) {
      const cols = columns.filter(c => row[c] !== undefined);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
      const values = cols.map(c => row[c]);
      const conflictCol = table === 'shopify_stores' ? 'shop_domain' : 'id';
      try {
        await pool.query(
          `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders}) ON CONFLICT (${conflictCol}) DO NOTHING`,
          values
        );
      } catch (e) {
        console.error(`    Failed to restore ${table} row (id=${row.id}):`, e.message);
      }
    }
  }

  console.log(`\nTotal rows across all tables: ${totalWouldInsert}`);
  if (!apply) {
    console.log('\nThis was a DRY RUN — nothing was written. Re-run with --apply to actually restore.');
  } else {
    console.log('\nRestore complete (existing rows were left untouched — ON CONFLICT DO NOTHING).');
  }

  if (needsReconnect.length) {
    console.log(`\n⚠️  These stores will need to reconnect via Shopify re-auth (access_token was not in the backup):`);
    needsReconnect.forEach(s => console.log(`   - ${s}`));
  }
  if (needsPasswordReset.length) {
    console.log(`\n⚠️  These accounts will need a password reset (password_hash was not in the backup):`);
    needsPasswordReset.forEach(s => console.log(`   - ${s}`));
  }

  await pool.end();
}

main().catch(e => { console.error('Restore script error:', e); process.exit(1); });
