const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Read-only query surface for control-center review ("who did what, when" — spec §1.8/§6).
// Every row in audit_log is kept forever (nothing here ever deletes/prunes it) — this endpoint's
// own `from`/`to`/`limit` are just query conveniences. The in-app activity log modal only ever asks
// for the last 14 days, but the full history stays queryable here (or directly in Postgres) for
// whatever inspection or auditing is needed later — this is the one surface, not two separate ones.
router.get('/', async (req, res) => {
  const { entityType, entityId, from, to, user } = req.query;
  const clauses = [];
  const values = [];

  if (entityType) { values.push(entityType); clauses.push(`a.entity_type = $${values.length}`); }
  if (entityId) { values.push(entityId); clauses.push(`a.entity_id = $${values.length}`); }
  if (from) { values.push(from); clauses.push(`a.performed_at >= $${values.length}`); }
  if (to) { values.push(to); clauses.push(`a.performed_at <= $${values.length}`); }
  if (user) { values.push(user); clauses.push(`a.performed_by = $${values.length}`); }

  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 2000) : 500;

  const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
  const { rows } = await pool.query(
    `select a.*, u.name as performed_by_name, u.role as performed_by_role
     from audit_log a
     left join users u on u.id = a.performed_by
     ${where}
     order by a.performed_at desc
     limit ${limit}`,
    values
  );
  res.json(rows);
});

module.exports = router;
