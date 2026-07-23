// Lightweight end-to-end smoke test that exercises the real Express app + socket.io layer against
// pg-mem (an in-memory Postgres-compatible engine) instead of a real Postgres server — useful for
// quickly proving the schema and route wiring are sound without provisioning a database. This is
// NOT a substitute for testing against real Postgres; pg-mem doesn't implement every Postgres
// feature. Run with `npm run smoke`.
process.env.JWT_SECRET = 'smoke-test-secret';
process.env.PORT = '0'; // let the OS pick a free port
process.env.CORS_ORIGIN = '*';
process.env.DATABASE_URL = 'postgres://ignored-because-pg-is-mocked-below';

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const bcrypt = require('bcryptjs');
const { newDb } = require('pg-mem');
const { io: ioClient } = require('socket.io-client');

async function main() {
  // --- swap the real 'pg' module for an in-memory pg-mem-backed one before any app code requires it ---
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  mem.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid',
    implementation: () => require('crypto').randomUUID(),
    impure: true, // must be re-evaluated per row, not folded into a single constant default
  });
  const pgAdapter = mem.adapters.createPg();
  const pgModulePath = require.resolve('pg');
  require.cache[pgModulePath] = { id: pgModulePath, filename: pgModulePath, loaded: true, exports: pgAdapter };

  const { pool } = require('../src/db');

  // --- run every real migration against pg-mem, in order (same as src/migrate.js) ---
  const migrationsDir = path.join(__dirname, '../src/migrations');
  const migrationFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of migrationFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
      .replace(/create extension if not exists pgcrypto;/, ''); // pg-mem has no extension system; gen_random_uuid is registered above instead
    await pool.query(sql);
  }
  console.log('[smoke] schema applied to in-memory Postgres:', migrationFiles.join(', '));

  // --- seed one admin user ---
  const passwordHash = bcrypt.hashSync('testpass123', 4);
  const userRes = await pool.query(
    `insert into users (name, email, password_hash, role) values ($1,$2,$3,'admin') returning id`,
    ['Smoke Admin', 'smoke@example.com', passwordHash]
  );
  console.log('[smoke] seeded user', userRes.rows[0].id);

  // --- boot the real app ---
  const { server } = require('../src/index');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`[smoke] server listening on ${base}`);

  async function api(method, urlPath, body, token) {
    const res = await fetch(base + urlPath, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  // 1. login
  const login = await api('POST', '/api/auth/login', { email: 'smoke@example.com', password: 'testpass123' });
  assert.strictEqual(login.status, 200, `login failed: ${JSON.stringify(login.body)}`);
  const token = login.body.token;
  console.log('[smoke] login OK');

  // 2. open a socket and collect broadcast events
  const events = [];
  const socket = ioClient(base, { auth: { token } });
  socket.on('network:event', (evt) => events.push(evt));
  await new Promise((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('connect_error', reject);
  });
  console.log('[smoke] socket connected');

  // 3. build a tiny network: feeder -> source -> AB -> (line) -> RMU, plus an interlink
  const feeder = await api('POST', '/api/feeders', { name: 'F1', kv: 11, state: 'On' }, token);
  assert.strictEqual(feeder.status, 201, JSON.stringify(feeder.body));

  const source = await api('POST', '/api/nodes', { feederId: feeder.body.id, kind: 'source', label: 'F1-Source' }, token);
  const ab = await api('POST', '/api/nodes', {
    feederId: feeder.body.id, kind: 'breaker', breakerType: 'AB', label: 'AB-1', state: 'Closed',
  }, token);
  assert.strictEqual(ab.status, 201, JSON.stringify(ab.body));

  const line = await api('POST', '/api/lines', {
    feederId: feeder.body.id, fromNodeId: source.body.id, toNodeId: ab.body.id, name: 'L1',
  }, token);
  assert.strictEqual(line.status, 201, JSON.stringify(line.body));

  const rmu = await api('POST', '/api/nodes', {
    feederId: feeder.body.id, kind: 'breaker', breakerType: 'RMU', label: 'RMU-1', state: 'Closed',
  }, token);
  const line2 = await api('POST', '/api/lines', {
    feederId: feeder.body.id, fromNodeId: ab.body.id, toNodeId: rmu.body.id, name: 'L2',
  }, token);
  console.log('[smoke] built feeder/source/AB/RMU/lines');

  // 3b. RMU per-bay toggle — exercises the lines PATCH camelCase->column mapping (breakerState -> breaker_state)
  const bayToggle = await api('PATCH', `/api/lines/${line2.body.id}`, {
    breakerState: 'Open', expectedVersion: line2.body.version,
  }, token);
  assert.strictEqual(bayToggle.status, 200, JSON.stringify(bayToggle.body));
  assert.strictEqual(bayToggle.body.breaker_state, 'Open');
  console.log('[smoke] RMU bay toggle (breakerState field mapping) OK');
  // put it back closed for the rest of the scenario
  const bayReclose = await api('PATCH', `/api/lines/${line2.body.id}`, {
    breakerState: 'Closed', expectedVersion: bayToggle.body.version,
  }, token);
  assert.strictEqual(bayReclose.status, 200, JSON.stringify(bayReclose.body));

  // 4. toggle the AB switch (the "closing an AB" scenario from the design discussion) and confirm
  //    the change is both persisted and broadcast in real time
  const toggle = await api('PATCH', `/api/nodes/${ab.body.id}`, { state: 'Open', expectedVersion: ab.body.version }, token);
  assert.strictEqual(toggle.status, 200, JSON.stringify(toggle.body));
  assert.strictEqual(toggle.body.state, 'Open');
  assert.strictEqual(toggle.body.version, ab.body.version + 1);
  console.log('[smoke] AB toggle OK, version bumped to', toggle.body.version);

  // 5. optimistic-locking conflict: reusing the now-stale expectedVersion must 409
  const staleToggle = await api('PATCH', `/api/nodes/${ab.body.id}`, { state: 'Closed', expectedVersion: ab.body.version }, token);
  assert.strictEqual(staleToggle.status, 409, `expected 409, got ${staleToggle.status}: ${JSON.stringify(staleToggle.body)}`);
  console.log('[smoke] version-conflict (409) OK');

  // 6. interlink guard: a non-switchable interlink must reject a state-change attempt
  const interlink = await api('POST', '/api/interlinks', {
    name: 'INTERLINK1', nodeAId: ab.body.id, nodeBId: rmu.body.id, breakerType: 'AB', switchable: false,
  }, token);
  assert.strictEqual(interlink.status, 201, JSON.stringify(interlink.body));
  assert.strictEqual(interlink.body.switch_state, 'NC', 'non-switchable interlink must load Closed');
  const blockedToggle = await api('PATCH', `/api/interlinks/${interlink.body.id}`, {
    switchState: 'NO', expectedVersion: interlink.body.version,
  }, token);
  assert.strictEqual(blockedToggle.status, 400, `expected 400, got ${blockedToggle.status}`);
  console.log('[smoke] non-switchable interlink guard OK');

  // 7. give the socket a moment to receive the broadcasts, then verify we got the events we expect
  await new Promise((resolve) => setTimeout(resolve, 200));
  const nodeUpdated = events.find((e) => e.type === 'node.updated' && e.entityId === ab.body.id);
  assert.ok(nodeUpdated, `expected a node.updated broadcast, got: ${JSON.stringify(events.map((e) => e.type))}`);
  assert.strictEqual(nodeUpdated.newValue, 'Open');
  console.log('[smoke] realtime broadcast for AB toggle received by socket client OK');

  // 8. "delete this branch" — deleting L1 (source -> AB) must cascade to AB, RMU, L2, and the interlink
  const del = await fetch(base + `/api/lines/${line.body.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(del.status, 204, `expected 204, got ${del.status}`);

  await new Promise((resolve) => setTimeout(resolve, 200));
  const lineDeleted = events.find((e) => e.type === 'line.deleted');
  assert.ok(lineDeleted, 'expected a line.deleted broadcast');
  assert.ok(lineDeleted.cascadedNodeIds.includes(ab.body.id), 'cascade should include the AB node');
  assert.ok(lineDeleted.cascadedNodeIds.includes(rmu.body.id), 'cascade should include the downstream RMU node');
  assert.ok(lineDeleted.cascadedLineIds.includes(line2.body.id), 'cascade should include the downstream line');
  assert.ok(lineDeleted.cascadedInterlinkIds.includes(interlink.body.id), 'cascade should include the interlink touching a removed node');

  const remainingNodes = await api('GET', '/api/network', null, token);
  const remainingIds = remainingNodes.body.nodes.map((n) => n.id);
  assert.ok(!remainingIds.includes(ab.body.id), 'AB node should be gone after cascade delete');
  assert.ok(remainingIds.includes(source.body.id), 'source node should NOT be deleted (only downstream of the deleted line)');
  console.log('[smoke] "delete this branch" cascade OK — AB/RMU/L2/interlink all removed, source preserved');

  socket.close();
  server.close();
  console.log('\n[smoke] ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error('\n[smoke] FAILED:', err);
  process.exit(1);
});
