const express = require('express');
const { pool } = require('../db');
const { versionedUpdate, VersionConflictError } = require('../utils/versioning');
const { recordChange, toEventPayload } = require('../utils/audit');
const { broadcastEvent } = require('../realtime/socket');
const { pickColumns } = require('../utils/fields');
const { requireRole } = require('../auth/auth.middleware');

const COLUMN_BY_FIELD = {
  switchState: 'switch_state', name: 'name', switchable: 'switchable', breakerType: 'breaker_type',
};

const router = express.Router();

function via(req) {
  return req.headers['x-client-type'] === 'mobile' ? 'mobile' : 'web';
}

// Creating or deleting a ring interlink changes the network topology itself — restricted to
// admin/control_center. field_staff can still PATCH (open/close a switchable interlink) below.
const canManageEntities = requireRole('admin', 'control_center');

router.post('/', canManageEntities, async (req, res) => {
  const { name, nodeAId, nodeBId, breakerType, switchable, switchState } = req.body || {};
  if (!name || !nodeAId || !nodeBId || !breakerType) {
    return res.status(400).json({ error: 'name, nodeAId, nodeBId, and breakerType are required' });
  }

  // Every interlink always loads Closed, full stop — same rule as the client's
  // buildStateFromWorkbookData: a non-switchable ring has no intermediate switch of its own, so
  // its state is never anything but NC. A switchable one can be created NO if that's the true
  // as-built state, but the common case is NC either way.
  const initialState = switchable ? (switchState === 'NO' ? 'NO' : 'NC') : 'NC';

  const { rows } = await pool.query(
    `insert into interlinks (name, node_a_id, node_b_id, breaker_type, switchable, switch_state, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [name, nodeAId, nodeBId, breakerType, !!switchable, initialState, req.user.id]
  );
  const interlink = rows[0];

  const audit = await recordChange(pool, {
    entityType: 'interlink', entityId: interlink.id, action: 'create', entityLabel: interlink.name,
    newValue: interlink, performedBy: req.user.id, performedVia: via(req),
  });
  broadcastEvent(toEventPayload(audit, interlink, req.user));
  res.status(201).json(interlink);
});

router.patch('/:id', async (req, res) => {
  const { expectedVersion } = req.body || {};
  if (expectedVersion == null) return res.status(400).json({ error: 'expectedVersion is required' });

  const patch = pickColumns(req.body || {}, COLUMN_BY_FIELD);
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no updatable fields provided' });

  // Mirrors the client's toggleInterlinkState guard: a non-switchable ring has no physical switch
  // of its own — the normal case in India is to operate the AB switches at its two endpoints
  // instead, so this rejects a state change on anything not explicitly marked switchable.
  if (patch.switch_state) {
    const row = await pool.query('select switchable from interlinks where id = $1', [req.params.id]);
    if (!row.rows[0]?.switchable) {
      return res.status(400).json({ error: 'this interlink has no switch of its own — operate the AB switches at its endpoints instead' });
    }
  }

  try {
    const before = await pool.query('select * from interlinks where id = $1', [req.params.id]);
    const after = await versionedUpdate(pool, 'interlinks', req.params.id, expectedVersion, patch, req.user.id);

    const changedField = Object.keys(patch)[0];
    const audit = await recordChange(pool, {
      entityType: 'interlink', entityId: after.id, action: 'update', fieldChanged: changedField,
      oldValue: before.rows[0] ? before.rows[0][changedField] : undefined,
      newValue: after[changedField], entityLabel: after.name,
      performedBy: req.user.id, performedVia: via(req),
    });
    broadcastEvent(toEventPayload(audit, after, req.user));
    res.json(after);
  } catch (err) {
    if (err instanceof VersionConflictError) {
      const current = await pool.query('select * from interlinks where id = $1', [req.params.id]);
      return res.status(409).json({ error: 'version conflict', current: current.rows[0] });
    }
    if (err.name === 'NotFoundError') return res.status(404).json({ error: err.message });
    throw err;
  }
});

router.delete('/:id', canManageEntities, async (req, res) => {
  const { rows } = await pool.query('delete from interlinks where id = $1 returning *', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'interlink not found' });

  const audit = await recordChange(pool, {
    entityType: 'interlink', entityId: req.params.id, action: 'delete', oldValue: rows[0],
    entityLabel: rows[0].name, performedBy: req.user.id, performedVia: via(req),
  });
  broadcastEvent(toEventPayload(audit, null, req.user));
  res.status(204).end();
});

module.exports = router;
