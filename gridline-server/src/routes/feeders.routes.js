const express = require('express');
const { pool } = require('../db');
const { versionedUpdate, VersionConflictError } = require('../utils/versioning');
const { recordChange, toEventPayload } = require('../utils/audit');
const { broadcastEvent } = require('../realtime/socket');
const { pickColumns } = require('../utils/fields');
const { requireRole } = require('../auth/auth.middleware');
const { inList } = require('../utils/cascade');

// Creating or deleting a feeder changes the network topology itself — restricted to admin/
// control_center. field_staff can still PATCH (switch on/off, edit details) via the routes below.
const canManageEntities = requireRole('admin', 'control_center');

const COLUMN_BY_FIELD = {
  state: 'state', name: 'name', kv: 'kv', location: 'location', poc: 'poc',
  risks: 'risks', lastTripped: 'last_tripped',
};

const router = express.Router();

function via(req) {
  return req.headers['x-client-type'] === 'mobile' ? 'mobile' : 'web';
}

router.post('/', canManageEntities, async (req, res) => {
  const { sectionId, name, kv, location, poc, state, risks, lastTripped } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  const { rows } = await pool.query(
    `insert into feeders (section_id, name, kv, location, poc, state, risks, last_tripped, updated_by)
     values ($1, $2, $3, $4, $5, coalesce($6, 'On'), $7, $8, $9) returning *`,
    [sectionId || null, name, kv || null, location || null, poc || null, state || null, risks || null,
      lastTripped || null, req.user.id]
  );
  const feeder = rows[0];

  const audit = await recordChange(pool, {
    entityType: 'feeder', entityId: feeder.id, action: 'create', entityLabel: feeder.name,
    newValue: feeder, performedBy: req.user.id, performedVia: via(req),
  });
  broadcastEvent(toEventPayload(audit, feeder, req.user));
  res.status(201).json(feeder);
});

router.patch('/:id', async (req, res) => {
  const { expectedVersion } = req.body || {};
  if (expectedVersion == null) return res.status(400).json({ error: 'expectedVersion is required' });

  const patch = pickColumns(req.body || {}, COLUMN_BY_FIELD);
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no updatable fields provided' });

  try {
    const before = await pool.query('select * from feeders where id = $1', [req.params.id]);
    const after = await versionedUpdate(pool, 'feeders', req.params.id, expectedVersion, patch, req.user.id);

    const changedField = Object.keys(patch)[0];
    const audit = await recordChange(pool, {
      entityType: 'feeder', entityId: after.id, action: 'update', fieldChanged: changedField,
      oldValue: before.rows[0] ? before.rows[0][changedField] : undefined,
      newValue: after[changedField], entityLabel: after.name,
      performedBy: req.user.id, performedVia: via(req),
    });
    broadcastEvent(toEventPayload(audit, after, req.user));
    res.json(after);
  } catch (err) {
    if (err instanceof VersionConflictError) {
      const current = await pool.query('select * from feeders where id = $1', [req.params.id]);
      return res.status(409).json({ error: 'version conflict', current: current.rows[0] });
    }
    if (err.name === 'NotFoundError') return res.status(404).json({ error: err.message });
    throw err;
  }
});

// Deleting a feeder cascades at the DB level via ON DELETE CASCADE FKs — every node/line/
// transformer/interlink hanging off it disappears in the same statement. Left alone, that would
// leave the audit trail with a single "feeder deleted" row and no memory of everything underneath
// it, which defeats the point of an audit log. So this collects each cascaded entity's id + label
// *before* deleting, then writes one audit_log row per entity (same pattern as utils/cascade.js's
// deleteNodeCascade/deleteLineCascade) inside the same transaction as the delete itself.
router.delete('/:id', canManageEntities, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const feederRes = await client.query('select * from feeders where id = $1', [req.params.id]);
    if (feederRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'feeder not found' });
    }
    const feeder = feederRes.rows[0];

    const nodeRes = await client.query('select id, label from nodes where feeder_id = $1', [req.params.id]);
    const lineRes = await client.query('select id, name from lines where feeder_id = $1', [req.params.id]);
    const nodeIds = nodeRes.rows.map((r) => r.id);
    const lineIds = lineRes.rows.map((r) => r.id);

    let transformerRows = [];
    let interlinkRows = [];
    if (nodeIds.length || lineIds.length) {
      const byNode = inList('node_id', nodeIds, 1);
      const byLine = inList('line_id', lineIds, 1 + byNode.params.length);
      const txRes = await client.query(
        `select id, name from transformers where (${byNode.sql}) or (${byLine.sql})`,
        [...byNode.params, ...byLine.params]
      );
      transformerRows = txRes.rows;
    }
    if (nodeIds.length) {
      const byA = inList('node_a_id', nodeIds, 1);
      const byB = inList('node_b_id', nodeIds, 1 + byA.params.length);
      const ilRes = await client.query(
        `select id, name from interlinks where (${byA.sql}) or (${byB.sql})`,
        [...byA.params, ...byB.params]
      );
      interlinkRows = ilRes.rows;
    }

    await client.query('delete from feeders where id = $1', [req.params.id]);

    const cascadedRows = [
      ...transformerRows.map((r) => ['transformer', r.id, r.name]),
      ...interlinkRows.map((r) => ['interlink', r.id, r.name]),
      ...lineRes.rows.map((r) => ['line', r.id, r.name]),
      ...nodeRes.rows.map((r) => ['node', r.id, r.label]),
    ];
    for (const [entityType, entityId, entityLabel] of cascadedRows) {
      await client.query(
        `insert into audit_log (entity_type, entity_id, action, entity_label, performed_by, performed_via)
         values ($1, $2, 'delete', $3, $4, $5)`,
        [entityType, entityId, entityLabel || null, req.user.id, via(req)]
      );
    }

    const audit = await recordChange(client, {
      entityType: 'feeder', entityId: feeder.id, action: 'delete', oldValue: feeder,
      entityLabel: feeder.name, performedBy: req.user.id, performedVia: via(req),
    });

    await client.query('COMMIT');

    broadcastEvent(toEventPayload(audit, null, req.user));
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
