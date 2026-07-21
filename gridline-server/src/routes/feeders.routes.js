const express = require('express');
const { pool } = require('../db');
const { versionedUpdate, VersionConflictError } = require('../utils/versioning');
const { recordChange, toEventPayload } = require('../utils/audit');
const { broadcastEvent } = require('../realtime/socket');
const { pickColumns } = require('../utils/fields');

const COLUMN_BY_FIELD = {
  state: 'state', name: 'name', kv: 'kv', location: 'location', poc: 'poc',
  risks: 'risks', lastTripped: 'last_tripped',
};

const router = express.Router();

function via(req) {
  return req.headers['x-client-type'] === 'mobile' ? 'mobile' : 'web';
}

router.post('/', async (req, res) => {
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
    entityType: 'feeder', entityId: feeder.id, action: 'create',
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
      newValue: after[changedField],
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

router.delete('/:id', async (req, res) => {
  const { rows } = await pool.query('delete from feeders where id = $1 returning *', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'feeder not found' });

  const audit = await recordChange(pool, {
    entityType: 'feeder', entityId: req.params.id, action: 'delete', oldValue: rows[0],
    performedBy: req.user.id, performedVia: via(req),
  });
  broadcastEvent(toEventPayload(audit, null, req.user));
  res.status(204).end();
});

module.exports = router;
