// Verifies PATCH /api/network/section — the lightweight "just edit the section name and its hover
// details (e.g. control-room phone numbers)" endpoint, as distinct from the wholesale POST /replace.
// Covers: field_staff AND admin AND control_center all rejected (403) — this route is super_admin
// only, the same narrow gate as /replace, NOT the wider admin/control_center/super_admin circle
// ordinary entity management uses — a missing/blank sectionName rejected with 400, creating a
// section from scratch when none exists yet (insert path), updating an existing section in place
// (update path, without touching any feeder/node/line), the details array round-tripping through the
// jsonb column correctly, and the single audit_log row using the reused entity_type='feeder' +
// '__section_update__' sentinel pattern (same convention __network_replace__ established). Run with:
// node test/section-update.test.js
process.env.JWT_SECRET = 'section-update-test-secret';
process.env.PORT = '0';
process.env.CORS_ORIGIN = '*';
process.env.DATABASE_URL = 'postgres://ignored-because-pg-is-mocked-below';

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const bcrypt = require('bcryptjs');
const { newDb } = require('pg-mem');

async function main() {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  mem.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid',
    implementation: () => require('crypto').randomUUID(),
    impure: true,
  });
  const pgAdapter = mem.adapters.createPg();
  const pgModulePath = require.resolve('pg');
  require.cache[pgModulePath] = { id: pgModulePath, filename: pgModulePath, loaded: true, exports: pgAdapter };

  const { pool } = require('../src/db');

  const migrationsDir = path.join(__dirname, '../src/migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
      .replace(/create extension if not exists pgcrypto;/, '');
    await pool.query(sql);
  }
  console.log('[section-update] all migrations applied to in-memory Postgres:', files.join(', '));

  const passwordHash = bcrypt.hashSync('testpass123', 4);
  await pool.query(`insert into users (name, email, password_hash, role) values ($1,$2,$3,'admin')`,
    ['KSEB Admin', 'admin@example.com', passwordHash]);
  await pool.query(`insert into users (name, email, password_hash, role) values ($1,$2,$3,'control_center')`,
    ['Control Center', 'control@example.com', passwordHash]);
  await pool.query(`insert into users (name, email, password_hash, role) values ($1,$2,$3,'super_admin')`,
    ['KSEB Super Admin', 'super@example.com', passwordHash]);
  await pool.query(`insert into users (name, email, password_hash, role) values ($1,$2,$3,'field_staff')`,
    ['KSEB Field', 'field@example.com', passwordHash]);

  const { server } = require('../src/index');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function api(method, urlPath, body, token) {
    const res = await fetch(base + urlPath, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  async function login(email) {
    const res = await api('POST', '/api/auth/login', { email, password: 'testpass123' });
    assert.strictEqual(res.status, 200, `login failed for ${email}: ${JSON.stringify(res.body)}`);
    return res.body.token;
  }

  const adminToken = await login('admin@example.com');
  const controlToken = await login('control@example.com');
  const superToken = await login('super@example.com');
  const fieldToken = await login('field@example.com');
  console.log('[section-update] logged in as admin/control_center/super_admin/field_staff');

  // --- 1. field_staff, admin, AND control_center must all be rejected — this route is
  //     super_admin-only, same narrow gate as POST /replace, not the wider admin/control_center/
  //     super_admin circle ordinary entity management (feeders/nodes/lines/etc.) uses. ---
  const fieldAttempt = await api('PATCH', '/api/network/section', { sectionName: 'ShouldNotLand' }, fieldToken);
  assert.strictEqual(fieldAttempt.status, 403, `expected 403 for field_staff, got ${fieldAttempt.status}`);
  console.log('[section-update] field_staff -> 403 OK');
  const adminAttempt = await api('PATCH', '/api/network/section', { sectionName: 'ShouldNotLand' }, adminToken);
  assert.strictEqual(adminAttempt.status, 403, `expected 403 for plain admin, got ${adminAttempt.status}`);
  console.log('[section-update] admin -> 403 OK (super_admin-only — plain admin is not enough here)');
  const controlAttempt = await api('PATCH', '/api/network/section', { sectionName: 'ShouldNotLand' }, controlToken);
  assert.strictEqual(controlAttempt.status, 403, `expected 403 for control_center, got ${controlAttempt.status}`);
  console.log('[section-update] control_center -> 403 OK (super_admin-only)');

  // --- 2. missing/blank sectionName rejected with 400, no section row created ---
  const blankName = await api('PATCH', '/api/network/section', { sectionName: '   ' }, superToken);
  assert.strictEqual(blankName.status, 400, `expected 400 for blank sectionName, got ${blankName.status}`);
  const missingName = await api('PATCH', '/api/network/section', {}, superToken);
  assert.strictEqual(missingName.status, 400, 'missing sectionName should also 400');
  const stillEmpty = await api('GET', '/api/network', null, superToken);
  assert.strictEqual(stillEmpty.body.sections.length, 0, 'no section row should exist yet');
  console.log('[section-update] blank/missing sectionName rejected with 400, no section row created');

  // --- 3. create path: no section exists yet -> super_admin's PATCH creates one ---
  const created = await api('PATCH', '/api/network/section', {
    sectionName: 'Thevakkal',
    sectionDetails: [{ label: 'Circle', value: 'Ernakulam' }, { label: 'Control Room Phone', value: '0480-1234567' }],
  }, superToken);
  assert.strictEqual(created.status, 200, JSON.stringify(created.body));
  assert.strictEqual(created.body.name, 'Thevakkal');
  assert.strictEqual(created.body.details['Control Room Phone'], '0480-1234567');
  assert.strictEqual(created.body.details['Circle'], 'Ernakulam');
  console.log('[section-update] super_admin created section from scratch (insert path) with correct details');

  const afterCreate = await api('GET', '/api/network', null, superToken);
  assert.strictEqual(afterCreate.body.sections.length, 1, 'exactly one section row after create');
  assert.strictEqual(afterCreate.body.sections[0].name, 'Thevakkal');
  console.log('[section-update] GET /api/network reflects the newly created section');

  // --- 4. update path: super_admin edits the existing row in place (still exactly one row) ---
  const updated = await api('PATCH', '/api/network/section', {
    sectionName: 'Thevakkal',
    sectionDetails: [
      { label: 'Circle', value: 'Ernakulam' },
      { label: 'Control Room Phone', value: '0480-7654321' }, // changed
      { label: 'Division', value: 'Aluva' }, // added
    ],
  }, superToken);
  assert.strictEqual(updated.status, 200, JSON.stringify(updated.body));
  assert.strictEqual(updated.body.details['Control Room Phone'], '0480-7654321', 'phone number should be updated');
  assert.strictEqual(updated.body.details['Division'], 'Aluva', 'new detail row should be added');
  console.log('[section-update] super_admin updated existing section in place (update path)');

  const afterUpdate = await api('GET', '/api/network', null, superToken);
  assert.strictEqual(afterUpdate.body.sections.length, 1, 'still exactly one section row after update, not a duplicate');
  assert.strictEqual(afterUpdate.body.sections[0].details['Control Room Phone'], '0480-7654321');
  console.log('[section-update] GET /api/network confirms exactly one row, with the updated phone number');

  // --- 5. removing a detail row (sending a shorter sectionDetails array) actually removes it,
  //     rather than merging with what was there before ---
  const shrunk = await api('PATCH', '/api/network/section', {
    sectionName: 'Thevakkal',
    sectionDetails: [{ label: 'Control Room Phone', value: '0480-1112223' }],
  }, superToken);
  assert.strictEqual(shrunk.status, 200, JSON.stringify(shrunk.body));
  assert.strictEqual(Object.keys(shrunk.body.details).length, 1, 'sending only 1 detail row should replace the whole details object, not merge');
  console.log('[section-update] details object is fully replaced (not merged) on each save');

  // --- 6. exactly one audit_log row per PATCH, using the reused entity_type='feeder' +
  //     '__section_update__' sentinel, same convention as __network_replace__ ---
  const auditRes = await api('GET', '/api/audit?limit=2000', null, superToken);
  const sectionRows = auditRes.body.filter((r) => r.field_changed === '__section_update__');
  assert.strictEqual(sectionRows.length, 3, `expected 3 section-update audit rows (create + 2 updates), got ${sectionRows.length}`);
  assert.ok(sectionRows.every((r) => r.entity_type === 'feeder' && r.action === 'update'));
  assert.ok(sectionRows.every((r) => r.performed_by_name === 'KSEB Super Admin'), 'every section-update row should be attributed to super_admin');
  console.log('[section-update] audit_log rows correct (entity_type, action, sentinel, performer)');

  server.close();
  console.log('\n[section-update] ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error('\n[section-update] FAILED:', err);
  process.exit(1);
});
