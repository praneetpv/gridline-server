// Verifies the new activity-log feature end to end: entity_label is captured at write time for
// creates/updates/deletes (including cascade deletes via a line and via a whole feeder), GET
// /api/audit joins the performer's username, and the response shape matches what the client's
// formatAuditLine()/describeAuditActivity() expect. Run with: node test/audit-log.test.js
process.env.JWT_SECRET = 'audit-log-test-secret';
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

  // Run every migration in order, same as the real migrate.js, so the entity_label column is there.
  const migrationsDir = path.join(__dirname, '../src/migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
      .replace(/create extension if not exists pgcrypto;/, '');
    await pool.query(sql);
  }
  console.log('[audit-log] all migrations applied to in-memory Postgres:', files.join(', '));

  const passwordHash = bcrypt.hashSync('testpass123', 4);
  await pool.query(
    `insert into users (name, email, password_hash, role) values ($1,$2,$3,'admin')`,
    ['KSEB Admin', 'admin@example.com', passwordHash]
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

  const login = await api('POST', '/api/auth/login', { email: 'admin@example.com', password: 'testpass123' });
  assert.strictEqual(login.status, 200, JSON.stringify(login.body));
  const token = login.body.token;
  console.log('[audit-log] login OK');

  // --- build a small network ---
  const feeder = await api('POST', '/api/feeders', { name: 'F1', kv: 11, state: 'On' }, token);
  assert.strictEqual(feeder.status, 201);
  const source = await api('POST', '/api/nodes', { feederId: feeder.body.id, kind: 'source', label: 'F1-Source' }, token);
  const ab = await api('POST', '/api/nodes', {
    feederId: feeder.body.id, kind: 'breaker', breakerType: 'AB', label: 'Medical College AB', state: 'Closed',
  }, token);
  assert.strictEqual(ab.status, 201);
  const line = await api('POST', '/api/lines', {
    feederId: feeder.body.id, fromNodeId: source.body.id, toNodeId: ab.body.id, name: 'L1',
  }, token);
  const rmu = await api('POST', '/api/nodes', {
    feederId: feeder.body.id, kind: 'breaker', breakerType: 'RMU', label: 'RMU-1', state: 'Closed',
  }, token);
  const line2 = await api('POST', '/api/lines', {
    feederId: feeder.body.id, fromNodeId: ab.body.id, toNodeId: rmu.body.id, name: 'L2',
  }, token);
  const tx = await api('POST', '/api/transformers', {
    name: 'TX-9', capacityKva: 100, poleName: 'P-1', nodeId: rmu.body.id,
  }, token);
  const interlink = await api('POST', '/api/interlinks', {
    name: 'TIE-2', nodeAId: ab.body.id, nodeBId: rmu.body.id, breakerType: 'AB', switchable: true,
  }, token);
  console.log('[audit-log] built feeder/source/AB/RMU/lines/transformer/interlink');

  // --- 1. AB state toggle -> exact example format ---
  const toggle = await api('PATCH', `/api/nodes/${ab.body.id}`, { state: 'Open', expectedVersion: ab.body.version }, token);
  assert.strictEqual(toggle.status, 200, JSON.stringify(toggle.body));

  const auditAfterToggle = await api('GET', `/api/audit?entityId=${ab.body.id}`, null, token);
  assert.strictEqual(auditAfterToggle.status, 200);
  const toggleRow = auditAfterToggle.body.find(r => r.field_changed === 'state');
  assert.ok(toggleRow, 'expected an audit row for the AB state change');
  assert.strictEqual(toggleRow.entity_label, 'Medical College AB', `expected entity_label 'Medical College AB', got ${toggleRow.entity_label}`);
  assert.strictEqual(toggleRow.new_value, 'Open');
  assert.strictEqual(toggleRow.performed_by_name, 'KSEB Admin', `expected performed_by_name 'KSEB Admin', got ${toggleRow.performed_by_name}`);
  console.log('[audit-log] AB toggle audit row: entity_label + new_value + performed_by_name all correct');

  // --- 2. Transformer multi-field update (load + fault together) ---
  const txUpdate = await api('PATCH', `/api/transformers/${tx.body.id}`, {
    loadR: 15, loadY: 14, loadB: 13, lastFaultDate: '2026-07-20T10:00', lastFaultReason: 'Overload trip',
  }, token);
  assert.strictEqual(txUpdate.status, 200, JSON.stringify(txUpdate.body));

  const auditAfterTx = await api('GET', `/api/audit?entityId=${tx.body.id}`, null, token);
  const txRow = auditAfterTx.body.find(r => r.action === 'update');
  assert.ok(txRow, 'expected an audit row for the transformer update');
  assert.strictEqual(txRow.entity_label, 'TX-9');
  assert.strictEqual(txRow.field_changed, null, 'transformer PATCH has no single field_changed — full row is old_value/new_value');
  assert.ok(txRow.old_value && txRow.new_value, 'expected full old_value/new_value rows for the transformer update');
  assert.strictEqual(txRow.new_value.last_fault_reason, 'Overload trip');
  console.log('[audit-log] transformer multi-field update audit row correct (entity_label, full old/new rows)');

  // --- 3. Direct delete (interlink) ---
  const delInterlink = await api('DELETE', `/api/interlinks/${interlink.body.id}`, null, token);
  assert.strictEqual(delInterlink.status, 204);
  const auditAfterInterlinkDelete = await api('GET', `/api/audit?entityId=${interlink.body.id}`, null, token);
  const delRow = auditAfterInterlinkDelete.body.find(r => r.action === 'delete');
  assert.ok(delRow, 'expected a delete audit row for the interlink');
  assert.strictEqual(delRow.entity_label, 'TIE-2');
  console.log('[audit-log] direct interlink delete audit row has correct entity_label');

  // --- 4. Cascade delete via line ("delete this branch") ---
  const delLine = await api('DELETE', `/api/lines/${line.body.id}`, null, token);
  assert.strictEqual(delLine.status, 204);
  const abDeleteAudit = await api('GET', `/api/audit?entityId=${ab.body.id}`, null, token);
  const abDeleteRow = abDeleteAudit.body.find(r => r.action === 'delete');
  assert.ok(abDeleteRow, 'expected a delete audit row for the cascaded AB node');
  assert.strictEqual(abDeleteRow.entity_label, 'Medical College AB', 'cascaded node delete should still carry its label');
  const txDeleteAudit = await api('GET', `/api/audit?entityId=${tx.body.id}`, null, token);
  const txDeleteRow = txDeleteAudit.body.find(r => r.action === 'delete');
  assert.ok(txDeleteRow, 'expected a delete audit row for the cascaded transformer');
  assert.strictEqual(txDeleteRow.entity_label, 'TX-9', 'cascaded transformer delete should still carry its label');
  console.log('[audit-log] cascade delete via line: cascaded node/transformer audit rows carry correct labels');

  // --- 5. Whole-feeder delete cascade (the new behavior added this session) ---
  const feeder2 = await api('POST', '/api/feeders', { name: 'F2', state: 'On' }, token);
  const source2 = await api('POST', '/api/nodes', { feederId: feeder2.body.id, kind: 'source', label: 'F2-Source' }, token);
  const ab2 = await api('POST', '/api/nodes', {
    feederId: feeder2.body.id, kind: 'breaker', breakerType: 'AB', label: 'Substation-9 AB', state: 'Closed',
  }, token);
  const line3 = await api('POST', '/api/lines', {
    feederId: feeder2.body.id, fromNodeId: source2.body.id, toNodeId: ab2.body.id, name: 'F2-L1',
  }, token);
  const tx2 = await api('POST', '/api/transformers', {
    name: 'TX-F2', capacityKva: 63, nodeId: ab2.body.id,
  }, token);

  const delFeeder = await api('DELETE', `/api/feeders/${feeder2.body.id}`, null, token);
  assert.strictEqual(delFeeder.status, 204, JSON.stringify(delFeeder.body));

  const feederDeleteAudit = await api('GET', `/api/audit?entityId=${feeder2.body.id}`, null, token);
  const feederDeleteRow = feederDeleteAudit.body.find(r => r.action === 'delete');
  assert.ok(feederDeleteRow, 'expected a delete audit row for the feeder itself');
  assert.strictEqual(feederDeleteRow.entity_label, 'F2');

  const nodeUnderFeederAudit = await api('GET', `/api/audit?entityId=${ab2.body.id}`, null, token);
  const nodeUnderFeederRow = nodeUnderFeederAudit.body.find(r => r.action === 'delete');
  assert.ok(nodeUnderFeederRow, 'expected a delete audit row for the node cascaded from the feeder delete');
  assert.strictEqual(nodeUnderFeederRow.entity_label, 'Substation-9 AB', 'feeder-cascaded node delete should carry its label');

  const txUnderFeederAudit = await api('GET', `/api/audit?entityId=${tx2.body.id}`, null, token);
  const txUnderFeederRow = txUnderFeederAudit.body.find(r => r.action === 'delete');
  assert.ok(txUnderFeederRow, 'expected a delete audit row for the transformer cascaded from the feeder delete');
  assert.strictEqual(txUnderFeederRow.entity_label, 'TX-F2', 'feeder-cascaded transformer delete should carry its label');

  const lineUnderFeederAudit = await api('GET', `/api/audit?entityId=${line3.body.id}`, null, token);
  const lineUnderFeederRow = lineUnderFeederAudit.body.find(r => r.action === 'delete');
  assert.ok(lineUnderFeederRow, 'expected a delete audit row for the line cascaded from the feeder delete');
  console.log('[audit-log] whole-feeder delete cascade: feeder + node + line + transformer all audited with correct labels');

  // --- 6. from/limit filters + the 14-day-window query the client actually issues ---
  const since = new Date();
  since.setDate(since.getDate() - 14);
  const recentWindow = await api('GET', `/api/audit?from=${encodeURIComponent(since.toISOString())}&limit=2000`, null, token);
  assert.strictEqual(recentWindow.status, 200);
  assert.ok(recentWindow.body.length > 0, 'expected the 14-day window query to return the rows just created');
  const futureWindow = await api('GET', `/api/audit?from=${encodeURIComponent(new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString())}`, null, token);
  assert.strictEqual(futureWindow.body.length, 0, 'a from-date a year in the future should return nothing');
  console.log('[audit-log] from/limit query params behave correctly (14-day window + far-future from)');

  server.close();
  console.log('\n[audit-log] ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error('\n[audit-log] FAILED:', err);
  process.exit(1);
});
