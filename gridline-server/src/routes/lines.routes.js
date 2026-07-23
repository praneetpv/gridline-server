const express = require('express');
const { pool } = require('../db');
const { versionedUpdate, VersionConflictError } = require('../utils/versioning');
const { recordChange, toEventPayload } = require('../utils/audit');
const { deleteLineCascade } = require('../utils/cascade');
const { broadcastEvent } = require('../realtime/socket');
const { pickColumns } = require('../utils/fields');
const { requireRole } = require('../auth/auth.middleware');

const COLUMN_BY_FIELD = { breakerState: 'breaker_state', name: 'name' };

const router = express.Router();

function via(req) {
  return req.headers['x-client-type'] === 'mobile' ? 'mobile' : 'web';
}

// Creating or deleting a line changes the network topology itself — restricted to admin/
// control_center. field_staff can still PATCH (open/close an RMU bay, rename) below.
const canManageEntities = requireRole('admin', 'control_center');

router.post('/', canManageEntities, async (req, res) => {
  const { feederId, fromNodeId, toNodeId, name, breakerState } = req.body || {};
  if (!feederId || !fromNodeId || !toNodeId || !name) {
    return res.status(400).json({ error: 'feederId, fromNodeId, toNodeId, and name are required' });
  }

  const { rows } = await pool.query(
    `insert into lines (feeder_id, from_node_id, to_node_id, name, breaker_state, updated_by)
     values ($1, $2, $3, $4, coalesce($5, 'Closed'), $6) returning *`,
    [feederId, fromNodeId, toNodeId, name, breakerState || null, req.user.id]
  );
  const line = rows[0];

  const audit = await recordChange(pool, {
    entityType: 'line', entityId: line.id, action: 'create', entityLabel: line.name,
    newValue: line, performedBy: req.user.id, performedVia: via(req),
  });
  broadcastEvent(toEventPayload(audit, line, req.user));
  res.status(201).json(line);
});

// RMU per-bay open/close, or a name correction.
router.patch('/:id', async (req, res) => {
  const { expectedVersion } = req.body || {};
  if (expectedVersion == null) return res.status(400).json({ error: 'expectedVersion is required' });

  const patch = pickColumns(req.body || {}, COLUMN_BY_FIELD);
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no updatable fields provided' });

  try {
    const before = await pool.query('select * from lines where id = $1', [req.params.id]);
    const after = await versionedUpdate(pool, 'lines', req.params.id, expectedVersion, patch, req.user.id);

    const changedField = Object.keys(patch)[0];
    const audit = await recordChange(pool, {
      entityType: 'line', entityId: after.id, action: 'update', fieldChanged: changedField,
      oldValue: before.rows[0] ? before.rows[0][changedField] : undefined,
      newValue: after[changedField], entityLabel: after.name,
      performedBy: req.user.id, performedVia: via(req),
    });
    broadcastEvent(toEventPayload(audit, after, req.user));
    res.json(after);
  } catch (err) {
    if (err instanceof VersionConflictError) {
      const current = await pool.query('select * from lines where id = $1', [req.params.id]);
      return res.status(409).json({ error: 'version conflict', current: current.rows[0] });
    }
    if (err.name === 'NotFoundError') return res.status(404).json({ error: err.message });
    throw err;
  }
});

// "Delete this branch" (see the client's confirm dialog) — cascades to everything downstream.
router.delete('/:id', canManageEntities, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await deleteLineCascade(client, req.params.id, req.user.id, via(req));
    await client.query('COMMIT');

    broadcastEvent({
      type: 'line.deleted',
      entityId: req.params.id,
      cascadedNodeIds: result.deletedNodeIds,
      cascadedLineIds: result.deletedLineIds,
      cascadedTransformerIds: result.deletedTransformerIds,
      cascadedInterlinkIds: result.deletedInterlinkIds,
      performedBy: { id: req.user.id, name: req.user.name, role: req.user.role },
      performedVia: via(req),
      performedAt: new Date().toISOString(),
    });
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.name === 'NotFoundError') return res.status(404).json({ error: err.message });
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
