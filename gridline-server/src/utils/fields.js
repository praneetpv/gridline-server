// Every route accepts camelCase field names on the wire (matching the client's own field naming)
// and translates them to the actual snake_case DB column before touching Postgres. This keeps the
// HTTP contract idiomatic JSON regardless of what the column happens to be called.

/**
 * Picks only the keys in `columnByField` out of `body`, translating each to its column name.
 * @param {Record<string, any>} body - raw request body (may contain other keys, e.g. expectedVersion)
 * @param {Record<string, string>} columnByField - camelCase field name -> snake_case column name
 * @returns {Record<string, any>} column-keyed object suitable for versionedUpdate()
 */
function pickColumns(body, columnByField) {
  const patch = {};
  for (const [field, column] of Object.entries(columnByField)) {
    if (body[field] !== undefined) patch[column] = body[field];
  }
  return patch;
}

module.exports = { pickColumns };
