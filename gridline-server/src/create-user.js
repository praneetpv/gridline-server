// One-off CLI to provision a user, since there's deliberately no self-service signup endpoint
// (see README "no signup endpoint by design"). Run inside the backend container, e.g.:
//   docker compose exec backend node src/create-user.js "Control Room" control@utility.example a-real-password admin
//
// Roles: field_staff | control_center | admin
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

async function main() {
  const [name, email, password, role = 'control_center'] = process.argv.slice(2);
  if (!name || !email || !password) {
    console.error('Usage: node src/create-user.js "<name>" <email> <password> [role]');
    console.error('Roles: field_staff | control_center | admin (default: control_center)');
    process.exit(1);
  }
  if (!['field_staff', 'control_center', 'admin'].includes(role)) {
    console.error(`Invalid role "${role}". Must be one of: field_staff, control_center, admin`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `insert into users (name, email, password_hash, role) values ($1, $2, $3, $4)
     on conflict (email) do update set password_hash = excluded.password_hash, name = excluded.name, role = excluded.role
     returning id, name, email, role`,
    [name, email, passwordHash, role]
  );
  console.log('User ready:', rows[0]);
  await pool.end();
}

main().catch((err) => {
  console.error('Failed to create user:', err);
  process.exit(1);
});
