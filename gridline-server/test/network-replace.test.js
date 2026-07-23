// Verifies POST /api/network/replace — the "Import Excel, then Save" wholesale wipe-and-replace
// used by Realtime view. Covers: admin-only gating, rejecting an empty/missing feeders array
// (refuses to wipe the DB for a bad payload), a full replace correctly resolving the client's local
// ids into real relationships (feeder -> node -> line -> transformer/interlink), the old network
// actually being gone afterward, the single consolidated audit_log row, and the sections table
// ending up with exactly the one new section. Run with: node test/network-replace.test.js
process.env.JWT_SECRET = 'network-replace-test-secret';
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
  console.log('[network-replace] all migrations applied to in-memory Postgres:', files.join(', '));

  const passwordHash = bcrypt.hashSync('testpass123', 4);
  await pool.query(
    `insert into users (name, email, password_hash, role) values ($1,$2,$3,'admin')`,
    ['KSEB Admin', 'admin@example.com', passwordHash]
  );
  await pool.query(
    `insert into users (name, email, password_hash, role) values ($1,$2,$3,'control_center')`,
    ['Control Center', 'control@example.com', passwordHash]
  );

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

  const adminLogin = await api('POST', '/api/auth/login', { email: 'admin@example.com', password: 'testpass123' });
  assert.strictEqual(adminLogin.status, 200, JSON.stringify(adminLogin.body));
  const adminToken = adminLogin.body.token;
  const controlLogin = await api('POST', '/api/auth/login', { email: 'control@example.com', password: 'testpass123' });
  const controlToken = controlLogin.body.token;
  console.log('[network-replace] logged in as admin + control_center');

  // --- seed an "old" network directly through the normal per-entity API, to prove it gets wiped ---
  const oldFeeder = await api('POST', '/api/feeders', { name: 'OldFeeder', state: 'On' }, adminToken);
  assert.strictEqual(oldFeeder.status, 201);
  const oldSource = await api('POST', '/api/nodes', { feederId: oldFeeder.body.id, kind: 'source', label: 'Old Source' }, adminToken);
  const oldAb = await api('POST', '/api/nodes', {
    feederId: oldFeeder.body.id, kind: 'breaker', breakerType: 'AB', label: 'Old AB', state: 'Closed',
  }, adminToken);
  await api('POST', '/api/lines', {
    feederId: oldFeeder.body.id, fromNodeId: oldSource.body.id, toNodeId: oldAb.body.id, name: 'OldLine',
  }, adminToken);
  console.log('[network-replace] seeded an old network (1 feeder, 2 nodes, 1 line)');

  // --- 1. control_center must be rejected (admin-only, unlike every other create/delete route) ---
  const rejected = await api('POST', '/api/network/replace', {
    feeders: [{ id: 'f1', name: 'ShouldNotLand' }],
  }, controlToken);
  assert.strictEqual(rejected.status, 403, `expected 403 for control_center, got ${rejected.status}: ${JSON.stringify(rejected.body)}`);
  console.log('[network-replace] control_center -> 403 OK (admin-only)');

  // --- 2. empty/missing feeders array must be rejected, not silently wipe the DB ---
  const emptyPayload = await api('POST', '/api/network/replace', { feeders: [] }, adminToken);
  assert.strictEqual(emptyPayload.status, 400, `expected 400 for empty feeders, got ${emptyPayload.status}`);
  const missingPayload = await api('POST', '/api/network/replace', {}, adminToken);
  assert.strictEqual(missingPayload.status, 400, 'missing feeders array should also 400');
  const stillThere = await api('GET', '/api/network', null, adminToken);
  assert.strictEqual(stillThere.body.feeders.length, 1, 'old feeder must still exist after a rejected empty/invalid replace');
  console.log('[network-replace] empty/missing feeders array rejected with 400, old data untouched');

  // --- 3. a full replace: 2 feeders, an interlink tying them, a node-attached transformer, a
  //     line-attached transformer, using the client's local id scheme (f1/n1/l1/t1/interlink1 style) ---
  const payload = {
    sectionName: 'Thevakkal',
    sectionDetails: [{ label: 'Circle', value: 'Ernakulam' }],
    feeders: [
      { id: 'f1', name: 'Thevakkal Feeder', kv: '11', state: 'On' },
      { id: 'f2', name: 'Kangarappady Feeder', kv: '11', state: 'On' },
    ],
    nodes: [
      { id: 's1', feederId: 'f1', kind: 'source', label: 'F1 Source' },
      { id: 'ab1', feederId: 'f1', kind: 'breaker', breakerType: 'AB', label: 'Thevakkal School AB', state: 'Closed' },
      { id: 'rmu1', feederId: 'f1', kind: 'breaker', breakerType: 'RMU', label: 'Vayanacode RMU', state: 'Closed' },
      { id: 's2', feederId: 'f2', kind: 'source', label: 'F2 Source' },
      { id: 'ab2', feederId: 'f2', kind: 'breaker', breakerType: 'AB', label: 'Kangarappady AB', state: 'Open' },
    ],
    lines: [
      { id: 'l1', feederId: 'f1', fromNodeId: 's1', toNodeId: 'ab1', name: 'L1', breakerState: 'Closed' },
      { id: 'l2', feederId: 'f1', fromNodeId: 'ab1', toNodeId: 'rmu1', name: 'L2', breakerState: 'Closed' },
      { id: 'l3', feederId: 'f2', fromNodeId: 's2', toNodeId: 'ab2', name: 'L3', breakerState: 'Closed' },
    ],
    transformers: [
      { id: 't1', name: 'Vayanacode TX', capacity: 100, nodeId: 'rmu1' },
      { id: 't2', name: 'Line-tapped TX', capacity: 63, lineId: 'l3' },
    ],
    interlinks: [
      { id: 'interlink1', name: 'INTERLINK1', nodeAId: 'ab1', nodeBId: 'ab2', breakerType: 'AB', switchable: true, switchState: 'NO' },
    ],
  };
  const replaced = await api('POST', '/api/network/replace', payload, adminToken);
  assert.strictEqual(replaced.status, 200, JSON.stringify(replaced.body));
  console.log('[network-replace] full replace request accepted (200)');

  // --- 4. the response is a full fresh snapshot; verify shape/counts directly ---
  assert.strictEqual(replaced.body.feeders.length, 2, 'response snapshot should have exactly the 2 new feeders');
  assert.strictEqual(replaced.body.nodes.length, 5, 'response snapshot should have exactly the 5 new nodes');
  assert.strictEqual(replaced.body.lines.length, 3, 'response snapshot should have exactly the 3 new lines');
  assert.strictEqual(replaced.body.transformers.length, 2, 'response snapshot should have exactly the 2 new transformers');
  assert.strictEqual(replaced.body.interlinks.length, 1, 'response snapshot should have exactly the 1 new interlink');
  assert.strictEqual(replaced.body.sections.length, 1, 'exactly one section row after replace');
  assert.strictEqual(replaced.body.sections[0].name, 'Thevakkal');
  console.log('[network-replace] response snapshot has correct counts + section name');

  // --- 5. the OLD network is genuinely gone, not just appended-past ---
  const oldFeederStillThere = replaced.body.feeders.some((f) => f.name === 'OldFeeder');
  assert.ok(!oldFeederStillThere, 'the old feeder must be gone after replace');
  console.log('[network-replace] old feeder confirmed gone after replace');

  // --- 6. relationships resolved correctly: node-attached and line-attached transformers, the
  //     interlink tying the two feeders together via their real (not local) node ids ---
  const newFeederByName = Object.fromEntries(replaced.body.feeders.map((f) => [f.name, f]));
  const newNodeByLabel = Object.fromEntries(replaced.body.nodes.map((n) => [n.label, n]));
  const rmuNode = newNodeByLabel['Vayanacode RMU'];
  const vayanacodeTx = replaced.body.transformers.find((t) => t.name === 'Vayanacode TX');
  assert.strictEqual(vayanacodeTx.node_id, rmuNode.id, 'node-attached transformer resolved to the real (mapped) node id');
  const lineTaggedTx = replaced.body.transformers.find((t) => t.name === 'Line-tapped TX');
  const l3 = replaced.body.lines.find((l) => l.name === 'L3');
  assert.strictEqual(lineTaggedTx.line_id, l3.id, 'line-attached transformer resolved to the real (mapped) line id');
  const thevakkalAb = newNodeByLabel['Thevakkal School AB'];
  const kangarappadyAb = newNodeByLabel['Kangarappady AB'];
  const il = replaced.body.interlinks[0];
  assert.ok(
    (il.node_a_id === thevakkalAb.id && il.node_b_id === kangarappadyAb.id) ||
    (il.node_a_id === kangarappadyAb.id && il.node_b_id === thevakkalAb.id),
    'interlink resolved to the real node ids of both endpoints, tying the two feeders'
  );
  // kv is a numeric column -- real Postgres's pg driver returns it as a string, pg-mem returns a
  // real number, so compare numerically rather than asserting one exact JS type across both.
  assert.strictEqual(Number(newFeederByName['Thevakkal Feeder'].kv), 11);
  console.log('[network-replace] every relationship (node-tx, line-tx, cross-feeder interlink) resolved correctly');

  // --- 7. exactly one consolidated audit_log row for the whole operation, with old/new counts.
  //     Reuses entity_type='feeder' (no schema change) with a distinctive field_changed sentinel —
  //     see the comment in network.routes.js for why. ---
  const auditRes = await api('GET', '/api/audit?limit=2000', null, adminToken);
  const networkRows = auditRes.body.filter((r) => r.field_changed === '__network_replace__');
  assert.strictEqual(networkRows.length, 1, `expected exactly 1 network-replace audit row, got ${networkRows.length}`);
  const networkRow = networkRows[0];
  assert.strictEqual(networkRow.entity_type, 'feeder');
  assert.strictEqual(networkRow.entity_label, 'Thevakkal');
  assert.strictEqual(networkRow.action, 'update');
  assert.strictEqual(networkRow.old_value.feeders, 1, 'old_value should record the pre-replace feeder count');
  assert.strictEqual(networkRow.new_value.feeders, 2, 'new_value should record the post-replace feeder count');
  assert.strictEqual(networkRow.new_value.interlinks, 1);
  assert.strictEqual(networkRow.performed_by_name, 'KSEB Admin');
  console.log('[network-replace] single consolidated audit_log row correct (label, old/new counts, performer)');

  // --- 8. a second replace with no sectionName still works (feeders get section_id null, and the
  //     old section row from the previous replace is cleared rather than left orphaned) ---
  const secondReplace = await api('POST', '/api/network/replace', {
    feeders: [{ id: 'x1', name: 'NoSectionFeeder', state: 'On' }],
  }, adminToken);
  assert.strictEqual(secondReplace.status, 200, JSON.stringify(secondReplace.body));
  assert.strictEqual(secondReplace.body.sections.length, 0, 'no sectionName provided -> no section row created, and the old one is cleared');
  assert.strictEqual(secondReplace.body.feeders.length, 1);
  assert.strictEqual(secondReplace.body.feeders[0].name, 'NoSectionFeeder');
  console.log('[network-replace] replace with no sectionName clears the old section row and works correctly');

  server.close();
  console.log('\n[network-replace] ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error('\n[network-replace] FAILED:', err);
  process.exit(1);
});
