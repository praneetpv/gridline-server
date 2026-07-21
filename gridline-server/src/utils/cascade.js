// Port of the client's collectSubtree()/deleteLine() logic (gridline.html) to the server side.
// "Delete this branch" always starts from a *line* (the branch's incoming feed) — deleting that
// line removes it plus every node/line/transformer/interlink downstream of its to-node, exactly
// like the confirm dialog in the client says it will.

// Builds a `column in ($1, $2, ...)` fragment against `values`, starting placeholder numbering at
// `startIndex` (1-based) so it can be spliced into a larger parameterized query. Deliberately used
// instead of `= any($1::uuid[])` — functionally equivalent in real Postgres, but a plain IN list is
// the more broadly portable form across pg-compatible engines/tooling. Returns a condition that's
// always false (rather than invalid SQL) when `values` is empty.
function inList(column, values, startIndex) {
  if (!values.length) return { sql: 'false', params: [] };
  const placeholders = values.map((_, i) => `$${startIndex + i}`).join(', ');
  return { sql: `${column} in (${placeholders})`, params: values };
}

/**
 * Walks the tree from `rootNodeId` outward along outgoing lines (from_node_id -> to_node_id),
 * collecting every node and line in the subtree (rootNodeId included).
 */
async function collectSubtree(client, rootNodeId) {
  const nodeIds = new Set([rootNodeId]);
  const lineIds = new Set();
  let frontier = [rootNodeId];

  while (frontier.length) {
    const { sql, params } = inList('from_node_id', frontier, 1);
    const { rows } = await client.query(`select id, to_node_id from lines where ${sql}`, params);
    const nextFrontier = [];
    for (const row of rows) {
      lineIds.add(row.id);
      if (!nodeIds.has(row.to_node_id)) {
        nodeIds.add(row.to_node_id);
        nextFrontier.push(row.to_node_id);
      }
    }
    frontier = nextFrontier;
  }

  return { nodeIds, lineIds };
}

/**
 * Shared teardown once we know exactly which node/line ids are being removed: gathers the
 * transformers/interlinks that hang off them, deletes everything child-first, and writes one
 * audit_log row per affected entity. Returns the full id sets so the route handler can broadcast
 * a single event with everything clients need to remove from their canvas in one pass.
 */
async function deleteCollectedSubtree(client, { nodeIdArr, lineIdArr }, userId, via) {
  const byNode = inList('node_id', nodeIdArr, 1);
  const byLine = inList('line_id', lineIdArr, 1 + byNode.params.length);
  const txRes = await client.query(
    `select id from transformers where (${byNode.sql}) or (${byLine.sql})`,
    [...byNode.params, ...byLine.params]
  );

  const byNodeA = inList('node_a_id', nodeIdArr, 1);
  const byNodeB = inList('node_b_id', nodeIdArr, 1 + byNodeA.params.length);
  const interlinkRes = await client.query(
    `select id from interlinks where (${byNodeA.sql}) or (${byNodeB.sql})`,
    [...byNodeA.params, ...byNodeB.params]
  );

  const transformerIdArr = txRes.rows.map((r) => r.id);
  const interlinkIdArr = interlinkRes.rows.map((r) => r.id);

  // Delete children before parents to respect FKs even though most are already ON DELETE CASCADE
  // — being explicit here means the audit trail records each entity individually.
  if (transformerIdArr.length) {
    const { sql, params } = inList('id', transformerIdArr, 1);
    await client.query(`delete from transformers where ${sql}`, params);
  }
  if (interlinkIdArr.length) {
    const { sql, params } = inList('id', interlinkIdArr, 1);
    await client.query(`delete from interlinks where ${sql}`, params);
  }
  if (lineIdArr.length) {
    const { sql, params } = inList('id', lineIdArr, 1);
    await client.query(`delete from lines where ${sql}`, params);
  }
  {
    const { sql, params } = inList('id', nodeIdArr, 1);
    await client.query(`delete from nodes where ${sql}`, params);
  }

  const auditRows = [
    ...transformerIdArr.map((id) => ['transformer', id]),
    ...interlinkIdArr.map((id) => ['interlink', id]),
    ...lineIdArr.map((id) => ['line', id]),
    ...nodeIdArr.map((id) => ['node', id]),
  ];
  for (const [entityType, entityId] of auditRows) {
    await client.query(
      `insert into audit_log (entity_type, entity_id, action, performed_by, performed_via)
       values ($1, $2, 'delete', $3, $4)`,
      [entityType, entityId, userId, via]
    );
  }

  return {
    deletedLineIds: lineIdArr,
    deletedNodeIds: nodeIdArr,
    deletedTransformerIds: transformerIdArr,
    deletedInterlinkIds: interlinkIdArr,
  };
}

/**
 * Deletes a line and everything downstream of it (mirrors the client's deleteLine(), which is
 * what the "Delete this branch" confirm dialog actually calls). `client` must be a checked-out
 * pg client with an active BEGIN.
 */
async function deleteLineCascade(client, lineId, userId, via) {
  const lineRes = await client.query('select * from lines where id = $1', [lineId]);
  if (lineRes.rowCount === 0) {
    const err = new Error(`line ${lineId} not found`);
    err.name = 'NotFoundError';
    throw err;
  }
  const line = lineRes.rows[0];

  const { nodeIds, lineIds } = await collectSubtree(client, line.to_node_id);
  lineIds.add(lineId);

  return deleteCollectedSubtree(client, { nodeIdArr: [...nodeIds], lineIdArr: [...lineIds] }, userId, via);
}

/**
 * Deletes a node directly and everything downstream of it. The UI never calls this for an
 * ordinary branch (that goes through deleteLineCascade via the node's incoming line instead) —
 * this covers removing an entire source/root and its whole feeder subtree, or a standalone node
 * that has no incoming line at all.
 */
async function deleteNodeCascade(client, nodeId, userId, via) {
  const nodeRes = await client.query('select id from nodes where id = $1', [nodeId]);
  if (nodeRes.rowCount === 0) {
    const err = new Error(`node ${nodeId} not found`);
    err.name = 'NotFoundError';
    throw err;
  }

  const { nodeIds, lineIds } = await collectSubtree(client, nodeId);
  return deleteCollectedSubtree(client, { nodeIdArr: [...nodeIds], lineIdArr: [...lineIds] }, userId, via);
}

module.exports = { collectSubtree, deleteLineCascade, deleteNodeCascade };
