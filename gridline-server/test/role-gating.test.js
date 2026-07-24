// Verifies the server-side role enforcement added on top of the client-side UI hiding: field_staff
// must be rejected (403) from creating/deleting any entity, but must still be able to PATCH
// (toggle a switch, edit details) — while control_center/admin/super_admin all keep full
// create/delete access to entities. super_admin additionally gets exclusive access to POST
// /api/network/replace (the Import-Excel-then-Save wipe-and-replace feature), which is covered in
// more depth in network-replace.test.js — this file just confirms plain admin does NOT have that
// one exclusive route, and super_admin has ordinary entity CRUD like admin/control_center.
// Same pg-mem harness as test/smoke.test.js. Run with: node test/role-gating.test.js
process.env.JWT_SECRET = 'role-gating-test-secret';
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
  const migrationFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of migrationFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
      .replace(/create extension if not exists pgcrypto;/, '');
    await pool.query(sql);
  }
  console.log('[role-gating] schema applied to in-memory Postgres:', migrationFiles.join(', '));

  async function seedUser(name, email, role) {
    const passwordHash = bcrypt.hashSync('testpass123', 4);
    const res = await pool.query(
      `insert into users (name, email, password_hash, role) values ($1,$2,$3,$4) returning id`,
      [name, email, passwordHash, role]
    );
    return res.rows[0].id;
  }
  await seedUser('Smoke Admin', 'admin@example.com', 'admin');
  await seedUser('Smoke Field Staff', 'field@example.com', 'field_staff');
  await seedUser('Smoke Control Center', 'control@example.com', 'control_center');
  await seedUser('Smoke Super Admin', 'super@example.com', 'super_admin');
  console.log('[role-gating] seeded admin/field_staff/control_center/super_admin users');

  const { server } = require('../src/index');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`[role-gating] server listening on ${base}`);

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
  const fieldToken = await login('field@example.com');
  const controlToken = await login('control@example.com');
  const superToken = await login('super@example.com');
  console.log('[role-gating] logged in as all four roles');

  const feeder = await api('POST', '/api/feeders', { name: 'F1', kv: 11, state: 'On' }, adminToken);
  assert.strictEqual(feeder.status, 201, JSON.stringify(feeder.body));
  const source = await api('POST', '/api/nodes', { feederId: feeder.body.id, kind: 'source', label: 'F1-Source' }, adminToken);
  const ab = await api('POST', '/api/nodes', {
    feederId: feeder.body.id, kind: 'breaker', breakerType: 'AB', label: 'AB-1', state: 'Closed',
  }, adminToken);
  assert.strictEqual(ab.status, 201, JSON.stringify(ab.body));
  console.log('[role-gating] admin created feeder + source + AB node OK');

  const fieldCreateFeeder = await api('POST', '/api/feeders', { name: 'F2', state: 'On' }, fieldToken);
  assert.strictEqual(fieldCreateFeeder.status, 403, `expected 403, got ${fieldCreateFeeder.status}: ${JSON.stringify(fieldCreateFeeder.body)}`);
  console.log('[role-gating] field_staff POST /api/feeders -> 403 OK');

  const fieldCreateNode = await api('POST', '/api/nodes', {
    feederId: feeder.body.id, kind: 'breaker', breakerType: 'AB', label: 'AB-2', state: 'Closed',
  }, fieldToken);
  assert.strictEqual(fieldCreateNode.status, 403, `expected 403, got ${fieldCreateNode.status}`);
  console.log('[role-gating] field_staff POST /api/nodes -> 403 OK');

  const fieldToggle = await api('PATCH', `/api/nodes/${ab.body.id}`, { state: 'Open', expectedVersion: ab.body.version }, fieldToken);
  assert.strictEqual(fieldToggle.status, 200, `expected 200, got ${fieldToggle.status}: ${JSON.stringify(fieldToggle.body)}`);
  assert.strictEqual(fieldToggle.body.state, 'Open');
  console.log('[role-gating] field_staff PATCH /api/nodes/:id (operate AB switch) -> 200 OK');

  const fieldDelete = await api('DELETE', `/api/nodes/${ab.body.id}`, null, fieldToken);
  assert.strictEqual(fieldDelete.status, 403, `expected 403, got ${fieldDelete.status}: ${JSON.stringify(fieldDelete.body)}`);
  console.log('[role-gating] field_staff DELETE /api/nodes/:id -> 403 OK');

  const stillThere = await api('GET', '/api/network', null, adminToken);
  assert.ok(stillThere.body.nodes.some((n) => n.id === ab.body.id), 'AB node should still exist after a rejected field_staff delete');
  console.log('[role-gating] AB node confirmed still present after rejected delete');

  const controlCreate = await api('POST', '/api/feeders', { name: 'F3', state: 'On' }, controlToken);
  assert.strictEqual(controlCreate.status, 201, `expected 201, got ${controlCreate.status}: ${JSON.stringify(controlCreate.body)}`);
  console.log('[role-gating] control_center POST /api/feeders -> 201 OK');

  const controlDelete = await api('DELETE', `/api/feeders/${controlCreate.body.id}`, null, controlToken);
  assert.strictEqual(controlDelete.status, 204, `expected 204, got ${controlDelete.status}`);
  console.log('[role-gating] control_center DELETE /api/feeders/:id -> 204 OK');

  const noAuth = await api('POST', '/api/feeders', { name: 'F4' }, null);
  assert.strictEqual(noAuth.status, 401, `expected 401, got ${noAuth.status}`);
  console.log('[role-gating] no token -> 401 OK (role check never overrides auth check)');

  // super_admin has every ordinary entity-management capability admin/control_center have...
  const superCreate = await api('POST', '/api/feeders', { name: 'F5', state: 'On' }, superToken);
  assert.strictEqual(superCreate.status, 201, `expected 201, got ${superCreate.status}: ${JSON.stringify(superCreate.body)}`);
  const superDelete = await api('DELETE', `/api/feeders/${superCreate.body.id}`, null, superToken);
  assert.strictEqual(superDelete.status, 204, `expected 204, got ${superDelete.status}`);
  console.log('[role-gating] super_admin POST/DELETE /api/feeders -> 201/204 OK (same as admin/control_center)');

  // ...PLUS the one route plain admin/control_center do NOT have: network replace. Full coverage of
  // that route (payload handling, id resolution, audit row, etc.) lives in network-replace.test.js —
  // this is just the cross-role-boundary check that belongs here alongside the others.
  const superReplace = await api('POST', '/api/network/replace', { feeders: [{ id: 'f1', name: 'ReplacedBySuperAdmin' }] }, superToken);
  assert.strictEqual(superReplace.status, 200, `expected 200, got ${superReplace.status}: ${JSON.stringify(superReplace.body)}`);
  const adminReplace = await api('POST', '/api/network/replace', { feeders: [{ id: 'f1', name: 'ShouldBeRejected' }] }, adminToken);
  assert.strictEqual(adminReplace.status, 403, `expected 403 for plain admin, got ${adminReplace.status}`);
  const controlReplace = await api('POST', '/api/network/replace', { feeders: [{ id: 'f1', name: 'ShouldBeRejected' }] }, controlToken);
  assert.strictEqual(controlReplace.status, 403, `expected 403 for control_center, got ${controlReplace.status}`);
  console.log('[role-gating] POST /api/network/replace: super_admin -> 200, admin -> 403, control_center -> 403');

  server.close();
  console.log('\n[role-gating] ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error('\n[role-gating] FAILED:', err);
  process.exit(1);
});
