const express = require('express');
const { pool } = require('../db');
const { versionedUpdate, VersionConflictError } = require('../utils/versioning');
const { recordChange, toEventPayload } = require('../utils/audit');
const { deleteNodeCascade } = require('../utils/cascade');
const { broadcastEvent } = require('../realtime/socket');

const router = express.Router();

function via(req) {
  return req.headers['x-client-type'] === 'mobile' ? 'mobile' : 'web';
}

router.post('/', async (req, res) => {
  const { feederId, kind, breakerType, label, state } = req.body || {};
  if (!feederId || !kind || !label) {
    return res.status(400).json({ error: 'feederId, kind, and label are required' });
  }
  if (kind === 'breaker' && !breakerType) {
    return res.status(400).json({ error: 'breakerType is required when kind is "breaker"' });
  }

  const { rows } = await pool.query(
    `insert into nodes (feeder_id, kind, breaker_type, label, state, updated_by)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [feederId, kind, kind === 'source' ? null : breakerType, label, state || null, req.user.id]
  );
  const node = rows[0];

  const audit = await recordChange(pool, {
    entityType: 'node', entityId: node.id, action: 'create',
    newValue: node, performedBy: req.user.id, performedVia: via(req),
  });
  broadcastEvent(toEventPayload(audit, node, req.user));
  res.status(201).json(node);
});

// AB/RMU open-close, or a label correction. Split/Tap have no `state` to toggle (see the
// kind/breaker_type check constraint) — the client already gates the toggle button on
// SWITCHABLE_TYPES, but the server enforces it too rather than trusting the client.
router.patch('/:id', async (req, res) => {
  const { expectedVersion, ...fields } = req.body || {};
  if (expectedVersion == null) return res.status(400).json({ error: 'expectedVersion is required' });

  const allowed = ['state', 'label'];
  const patch = Object.fromEntries(Object.entries(fields).filter(([k]) => allowed.includes(k)));
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no updatable fields provided' });

  if (patch.state) {
    const nodeRow = await pool.query('select breaker_type from nodes where id = $1', [req.params.id]);
    const breakerType = nodeRow.rows[0]?.breaker_type;
    if (!['AB', 'RMU'].includes(breakerType)) {
      return res.status(400).json({ error: `${breakerType || 'this node'} has no switch to toggle` });
    }
  }

  try {
    const before = await pool.query('select * from nodes where id = $1', [req.params.id]);
    const after = await versionedUpdate(pool, 'nodes', req.params.id, expectedVersion, patch, req.user.id);

    const changedField = Object.keys(patch)[0];
    const audit = await recordChange(pool, {
      entityType: 'node', entityId: after.id, action: 'update', fieldChanged: changedField,
      oldValue: before.rows[0] ? before.rows[0][changedField] : undefined,
      newValue: after[changedField],
      performedBy: req.user.id, performedVia: via(req),
    });
    broadcastEvent(toEventPayload(audit, after, req.user));
    res.json(after);
  } catch (err) {
    if (err instanceof VersionConflictError) {
      const current = await pool.query('select * from nodes where id = $1', [req.params.id]);
      return res.status(409).json({ error: 'version conflict', current: current.rows[0] });
    }
    if (err.name === 'NotFoundError') return res.status(404).json({ error: err.message });
    throw err;
  }
});

// Direct node deletion — see utils/cascade.js deleteNodeCascade for when this is (and isn't) the
// right entry point versus DELETE /api/lines/:id.
router.delete('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await deleteNodeCascade(client, req.params.id, req.user.id, via(req));
    await client.query('COMMIT');

    broadcastEvent({
      type: 'node.deleted',
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
