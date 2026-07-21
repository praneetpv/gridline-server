const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const { rows } = await pool.query('select * from users where email = $1', [email]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  const token = jwt.sign(
    {
      id: user.id,
      name: user.name,
      role: user.role,
      assignedSectionIds: user.assigned_section_ids,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
  );

  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

// Logout is stateless on the server (JWTs aren't tracked server-side in this scaffold) — the
// client just discards its token. If you need forced invalidation (e.g. a compromised device),
// add a token-blocklist table or move to short-lived tokens + refresh tokens.
router.post('/logout', (req, res) => {
  res.json({ ok: true });
});

module.exports = router;
