const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Read-only query surface for control-center review ("who did what, when" — spec §1.8/§6).
router.get('/', async (req, res) => {
  const { entityType, entityId, from, to, user } = req.query;
  const clauses = [];
  const values = [];

  if (entityType) { values.push(entityType); clauses.push(`entity_type = $${values.length}`); }
  if (entityId) { values.push(entityId); clauses.push(`entity_id = $${values.length}`); }
  if (from) { values.push(from); clauses.push(`performed_at >= $${values.length}`); }
  if (to) { values.push(to); clauses.push(`performed_at <= $${values.length}`); }
  if (user) { values.push(user); clauses.push(`performed_by = $${values.length}`); }

  const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
  const { rows } = await pool.query(
    `select * from audit_log ${where} order by performed_at desc limit 500`,
    values
  );
  res.json(rows);
});

module.exports = router;
