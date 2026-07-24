const express = require('express');
const { pool } = require('../db');
const { recordChange, toEventPayload } = require('../utils/audit');
const { broadcastEvent } = require('../realtime/socket');
const { requireRole } = require('../auth/auth.middleware');

const router = express.Router();

function via(req) {
  return req.headers['x-client-type'] === 'mobile' ? 'mobile' : 'web';
}

// Creating or deleting a transformer changes the network topology itself — restricted to admin/
// control_center/super_admin. field_staff can still PATCH (capacity/pole/load-reading/
// fault-history) below.
const canManageEntities = requireRole('admin', 'control_center', 'super_admin');

router.post('/', canManageEntities, async (req, res) => {
  const {
    name, capacityKva, nodeId, lineId,
    poleName, loadR, loadY, loadB, loadCapturedAt, lastFaultDate, lastFaultReason,
  } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  if ((!!nodeId) === (!!lineId)) {
    return res.status(400).json({ error: 'exactly one of nodeId or lineId is required' });
  }

  const { rows } = await pool.query(
    `insert into transformers (
       name, capacity_kva, pole_name, load_r, load_y, load_b, load_captured_at,
       last_fault_date, last_fault_reason, node_id, line_id, updated_by
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning *`,
    [
      name, capacityKva || null, poleName || null, loadR || null, loadY || null, loadB || null,
      loadCapturedAt || null, lastFaultDate || null, lastFaultReason || null,
      nodeId || null, lineId || null, req.user.id,
    ]
  );
  const tx = rows[0];

  const audit = await recordChange(pool, {
    entityType: 'transformer', entityId: tx.id, action: 'create', entityLabel: tx.name,
    newValue: tx, performedBy: req.user.id, performedVia: via(req),
  });
  broadcastEvent(toEventPayload(audit, tx, req.user));
  res.status(201).json(tx);
});

// Transformers aren't switchable, so no version-conflict dance here — just plain field updates
// (name/capacity/pole/load-reading/fault-history corrections).
router.patch('/:id', async (req, res) => {
  const {
    name, capacityKva, poleName, loadR, loadY, loadB, loadCapturedAt, lastFaultDate, lastFaultReason,
  } = req.body || {};
  const columnByField = {
    name: 'name', capacityKva: 'capacity_kva', poleName: 'pole_name', loadR: 'load_r', loadY: 'load_y',
    loadB: 'load_b', loadCapturedAt: 'load_captured_at', lastFaultDate: 'last_fault_date',
    lastFaultReason: 'last_fault_reason',
  };
  const fields = { name, capacityKva, poleName, loadR, loadY, loadB, loadCapturedAt, lastFaultDate, lastFaultReason };
  const sets = [];
  const values = [];
  for (const [field, column] of Object.entries(columnByField)) {
    if (fields[field] !== undefined) { sets.push(`${column} = $${values.length + 1}`); values.push(fields[field]); }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'no updatable fields provided' });

  const before = await pool.query('select * from transformers where id = $1', [req.params.id]);
  if (before.rowCount === 0) return res.status(404).json({ error: 'transformer not found' });

  values.push(req.user.id, req.params.id);
  const { rows } = await pool.query(
    `update transformers set ${sets.join(', ')}, updated_at = now(), updated_by = $${values.length - 1}
     where id = $${values.length} returning *`,
    values
  );
  const after = rows[0];

  const audit = await recordChange(pool, {
    entityType: 'transformer', entityId: after.id, action: 'update', entityLabel: after.name,
    oldValue: before.rows[0], newValue: after, performedBy: req.user.id, performedVia: via(req),
  });
  broadcastEvent(toEventPayload(audit, after, req.user));
  res.json(after);
});

router.delete('/:id', canManageEntities, async (req, res) => {
  const { rows } = await pool.query('delete from transformers where id = $1 returning *', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'transformer not found' });

  const audit = await recordChange(pool, {
    entityType: 'transformer', entityId: req.params.id, action: 'delete', oldValue: rows[0],
    entityLabel: rows[0].name, performedBy: req.user.id, performedVia: via(req),
  });
  broadcastEvent(toEventPayload(audit, null, req.user));
  res.status(204).end();
});

module.exports = router;
