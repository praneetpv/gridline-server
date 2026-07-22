// Verifies the server-side role enforcement added on top of the client-side UI hiding: field_staff
// must be rejected (403) from creating/deleting any entity, but must still be able to PATCH
// (toggle a switch, edit details) — while control_center (and admin) keep full create/delete access.
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

  const schemaSql = fs.readFileSync(path.join(__dirname, '../src/migrations/001_init.sql'), 'utf8')
    .replace(/create extension if not exists pgcrypto;/, '');
  await pool.query(schemaSql);
  console.log('[role-gating] schema applied to in-memory Postgres');

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
  console.log('[role-gating] seeded admin/field_staff/control_center users');

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
  console.log('[role-gating] logged in as all three roles');

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

  server.close();
  console.log('\n[role-gating] ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error('\n[role-gating] FAILED:', err);
  process.exit(1);
});
