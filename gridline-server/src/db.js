// Postgres connection pool. A single shared pool is used across the whole app; routes/utils
// import { pool } from here rather than each opening their own connection.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  // Idle client errors (e.g. the DB restarting) shouldn't crash the whole server.
  console.error('Unexpected Postgres pool error', err);
});

module.exports = { pool };
