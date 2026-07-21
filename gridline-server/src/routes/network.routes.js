// Full-snapshot endpoint — used on initial client load and on socket reconnect (spec §3: "on
// reconnect, just re-fetch the current full state wholesale rather than replaying missed events").
const express = require('express');
const { pool } = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  const [sections, feeders, nodes, lines, transformers, interlinks] = await Promise.all([
    pool.query('select * from sections order by name'),
    pool.query('select * from feeders order by name'),
    pool.query('select * from nodes order by label'),
    pool.query('select * from lines order by name'),
    pool.query('select * from transformers order by name'),
    pool.query('select * from interlinks order by name'),
  ]);

  res.json({
    sections: sections.rows,
    feeders: feeders.rows,
    nodes: nodes.rows,
    lines: lines.rows,
    transformers: transformers.rows,
    interlinks: interlinks.rows,
  });
});

module.exports = router;
