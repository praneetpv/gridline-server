// Full-snapshot endpoint — used on initial client load and on socket reconnect (spec §3: "on
// reconnect, just re-fetch the current full state wholesale rather than replaying missed events").
const express = require('express');
const { pool } = require('../db');
const { recordChange } = require('../utils/audit');
const { broadcastEvent } = require('../realtime/socket');
const { requireRole } = require('../auth/auth.middleware');

const router = express.Router();

function via(req) {
  return req.headers['x-client-type'] === 'mobile' ? 'mobile' : 'web';
}

async function fetchFullSnapshot(client) {
  const [sections, feeders, nodes, lines, transformers, interlinks] = await Promise.all([
    client.query('select * from sections order by name'),
    client.query('select * from feeders order by name'),
    client.query('select * from nodes order by label'),
    client.query('select * from lines order by name'),
    client.query('select * from transformers order by name'),
    client.query('select * from interlinks order by name'),
  ]);
  return {
    sections: sections.rows,
    feeders: feeders.rows,
    nodes: nodes.rows,
    lines: lines.rows,
    transformers: transformers.rows,
    interlinks: interlinks.rows,
  };
}

router.get('/', async (req, res) => {
  const snapshot = await fetchFullSnapshot(pool);
  res.json(snapshot);
});

// Wholesale "Import Excel, then Save" flow for Realtime view: replaces the ENTIRE live network
// with whatever was just imported client-side (see gridline.html's buildStateFromWorkbookData —
// the exact same parser Simulator already uses, so one Excel template works for both views). This
// is by a wide margin the most destructive endpoint in the API — every existing feeder/node/line/
// transformer/interlink is gone the instant this commits, which is why it's gated to admin only
// (every other create/delete route also allows control_center; this one deliberately doesn't) and
// why the client shows an explicit "this will remove existing data" confirmation before ever
// calling it (see the client's showReplaceNetworkWarning).
//
// The payload carries the client's own locally-generated ids (e.g. "f1", "n3" — see addFeederRaw
// et al. in gridline.html) so it can describe relationships (a node's feederId, a line's
// fromNodeId/toNodeId, etc.) without the real database ids that don't exist yet. Those get resolved
// to freshly-generated uuids in dependency order (feeders -> nodes -> lines -> transformers ->
// interlinks) inside one transaction, so the whole replace either fully lands or fully rolls back —
// there's no partially-imported network possible even if something in the file is malformed partway
// through.
router.post('/replace', requireRole('admin'), async (req, res) => {
  const { sectionName, sectionDetails, feeders, nodes, lines, transformers, interlinks } = req.body || {};
  if (!Array.isArray(feeders) || feeders.length === 0) {
    return res.status(400).json({ error: 'feeders is required and must be a non-empty array' });
  }
  const safeNodes = Array.isArray(nodes) ? nodes : [];
  const safeLines = Array.isArray(lines) ? lines : [];
  const safeTransformers = Array.isArray(transformers) ? transformers : [];
  const safeInterlinks = Array.isArray(interlinks) ? interlinks : [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Counts of what's about to be wiped, for the audit row's old_value summary.
    const before = await Promise.all([
      client.query('select count(*)::int as n from feeders'),
      client.query('select count(*)::int as n from nodes'),
      client.query('select count(*)::int as n from lines'),
      client.query('select count(*)::int as n from transformers'),
      client.query('select count(*)::int as n from interlinks'),
    ]);
    const oldCounts = {
      feeders: before[0].rows[0].n, nodes: before[1].rows[0].n, lines: before[2].rows[0].n,
      transformers: before[3].rows[0].n, interlinks: before[4].rows[0].n,
    };

    // Wipe every feeder (cascades nodes/lines/transformers/interlinks at the DB level via ON DELETE
    // CASCADE — see 001_init.sql) and every section row. One deployment holds exactly one network/
    // section at a time today (see GET /api/network's `sections[0]` convention, already relied on
    // by the client) — clearing the sections table too, rather than leaving old rows behind,
    // guarantees there's exactly one afterward instead of depending on "order by name" to surface
    // the right one.
    await client.query('delete from feeders');
    await client.query('delete from sections');

    let sectionId = null;
    const trimmedSectionName = (sectionName || '').trim();
    if (trimmedSectionName) {
      const detailsObj = Array.isArray(sectionDetails)
        ? Object.fromEntries(sectionDetails.filter((d) => d && d.label).map((d) => [d.label, d.value]))
        : {};
      const sectionRes = await client.query(
        'insert into sections (name, details) values ($1, $2) returning id',
        [trimmedSectionName, JSON.stringify(detailsObj)]
      );
      sectionId = sectionRes.rows[0].id;
    }

    // local id (as sent by the client) -> freshly generated real uuid
    const feederIdMap = new Map();
    const nodeIdMap = new Map();
    const lineIdMap = new Map();

    for (const f of feeders) {
      if (!f || !f.id || !f.name) continue;
      const { rows } = await client.query(
        `insert into feeders (section_id, name, kv, location, poc, state, risks, last_tripped, updated_by)
         values ($1, $2, $3, $4, $5, coalesce($6, 'On'), $7, $8, $9) returning id`,
        [sectionId, f.name, f.kv || null, f.location || null, f.poc || null, f.state || null,
          f.risks || null, f.lastTripped || null, req.user.id]
      );
      feederIdMap.set(f.id, rows[0].id);
    }

    for (const n of safeNodes) {
      if (!n || !n.id || !n.feederId || !feederIdMap.has(n.feederId)) continue;
      const { rows } = await client.query(
        `insert into nodes (feeder_id, kind, breaker_type, label, state, updated_by)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [feederIdMap.get(n.feederId), n.kind, n.kind === 'source' ? null : n.breakerType,
          n.label, n.state || null, req.user.id]
      );
      nodeIdMap.set(n.id, rows[0].id);
    }

    for (const l of safeLines) {
      if (!l || !l.id || !l.feederId || !feederIdMap.has(l.feederId)) continue;
      if (!nodeIdMap.has(l.fromNodeId) || !nodeIdMap.has(l.toNodeId)) continue;
      const { rows } = await client.query(
        `insert into lines (feeder_id, from_node_id, to_node_id, name, breaker_state, updated_by)
         values ($1, $2, $3, $4, coalesce($5, 'Closed'), $6) returning id`,
        [feederIdMap.get(l.feederId), nodeIdMap.get(l.fromNodeId), nodeIdMap.get(l.toNodeId),
          l.name, l.breakerState || null, req.user.id]
      );
      lineIdMap.set(l.id, rows[0].id);
    }

    for (const t of safeTransformers) {
      if (!t || !t.name) continue;
      const realNodeId = t.nodeId ? nodeIdMap.get(t.nodeId) : null;
      const realLineId = t.lineId ? lineIdMap.get(t.lineId) : null;
      if ((!!realNodeId) === (!!realLineId)) continue; // exactly one of the two must resolve
      await client.query(
        `insert into transformers (
           name, capacity_kva, pole_name, load_r, load_y, load_b, load_captured_at,
           last_fault_date, last_fault_reason, node_id, line_id, updated_by
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          t.name, t.capacity || null, t.poleName || null,
          t.loadR !== undefined && t.loadR !== '' ? t.loadR : null,
          t.loadY !== undefined && t.loadY !== '' ? t.loadY : null,
          t.loadB !== undefined && t.loadB !== '' ? t.loadB : null,
          t.loadCapturedAt || null, t.lastFaultDate || null, t.lastFaultReason || null,
          realNodeId, realLineId, req.user.id,
        ]
      );
    }

    let interlinkCount = 0;
    for (const il of safeInterlinks) {
      if (!il || !il.name || !nodeIdMap.has(il.nodeAId) || !nodeIdMap.has(il.nodeBId)) continue;
      const initialState = il.switchable ? (il.switchState === 'NO' ? 'NO' : 'NC') : 'NC';
      await client.query(
        `insert into interlinks (name, node_a_id, node_b_id, breaker_type, switchable, switch_state, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [il.name, nodeIdMap.get(il.nodeAId), nodeIdMap.get(il.nodeBId), il.breakerType || 'AB',
          !!il.switchable, initialState, req.user.id]
      );
      interlinkCount++;
    }

    const newCounts = {
      feeders: feederIdMap.size, nodes: nodeIdMap.size, lines: lineIdMap.size,
      transformers: safeTransformers.length, interlinks: interlinkCount,
    };

    // One consolidated row for the whole operation rather than one per entity (which could be
    // thousands of rows for a full section) — reuses the already-allowed entity_type = 'feeder'
    // (no schema change needed) with a distinctive field_changed sentinel so the client's
    // describeAuditActivity() can recognize and format this as a network-wide event rather than an
    // edit to one specific feeder. entityId is a fixed nil uuid (this row doesn't describe any one
    // real feeder) rather than the new section id, so every network-replace event is easy to find
    // by entityId if ever needed later.
    const audit = await recordChange(client, {
      entityType: 'feeder', entityId: '00000000-0000-0000-0000-000000000000',
      action: 'update', fieldChanged: '__network_replace__',
      entityLabel: trimmedSectionName || '(unnamed section)',
      oldValue: oldCounts, newValue: newCounts,
      performedBy: req.user.id, performedVia: via(req),
    });

    const snapshot = await fetchFullSnapshot(client);
    await client.query('COMMIT');

    broadcastEvent({
      type: 'network.replaced',
      entityLabel: audit.entity_label,
      newValue: newCounts,
      performedBy: { id: req.user.id, name: req.user.name, role: req.user.role },
      performedVia: via(req),
      performedAt: audit.performed_at,
    });

    res.json(snapshot);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
