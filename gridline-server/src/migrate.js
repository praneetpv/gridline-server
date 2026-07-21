// Tiny migration runner — reads every .sql file in src/migrations in filename order and
// executes it. No down-migrations / rollback tracking here on purpose: this is a scaffold,
// not a production migration framework. Swap in Knex/node-pg-migrate/Prisma Migrate later
// if the schema needs to evolve with proper versioned migrations.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function migrate() {
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`Running migration ${file}...`);
    await pool.query(sql);
  }
  console.log('Migrations complete.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed', err);
  process.exit(1);
});
