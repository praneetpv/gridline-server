// Optimistic-locking helper (see spec §4). Every mutable table has a `version` integer.
// A PATCH must supply the `expectedVersion` it read; the UPDATE is conditioned on both the
// row id AND that version, so if someone else changed the row first, zero rows are affected
// and we know to return 409 rather than silently overwriting a stale read.

class VersionConflictError extends Error {
  constructor(table, id) {
    super(`Version conflict updating ${table} ${id}`);
    this.name = 'VersionConflictError';
    this.table = table;
    this.id = id;
  }
}

/**
 * Runs a conditional UPDATE and returns the fresh row, or throws VersionConflictError if the
 * row's current version didn't match `expectedVersion` (either someone else updated it since,
 * or the id doesn't exist).
 *
 * @param {import('pg').PoolClient | import('pg').Pool} db
 * @param {string} table
 * @param {string} id
 * @param {number} expectedVersion
 * @param {Record<string, any>} fields - columns to set, e.g. { state: 'Open' }
 * @param {string} updatedBy - user id performing the change
 */
async function versionedUpdate(db, table, id, expectedVersion, fields, updatedBy) {
  const setCols = Object.keys(fields);
  const setClause = setCols.map((col, i) => `${col} = $${i + 1}`).join(', ');
  const values = setCols.map((col) => fields[col]);

  const query = `
    update ${table}
    set ${setClause}, version = version + 1, updated_at = now(), updated_by = $${values.length + 1}
    where id = $${values.length + 2} and version = $${values.length + 3}
    returning *
  `;
  const params = [...values, updatedBy, id, expectedVersion];
  const result = await db.query(query, params);

  if (result.rowCount === 0) {
    // Distinguish "doesn't exist" from "version mismatch" so the caller can 404 vs 409.
    const existing = await db.query(`select id, version from ${table} where id = $1`, [id]);
    if (existing.rowCount === 0) {
      const notFound = new Error(`${table} ${id} not found`);
      notFound.name = 'NotFoundError';
      throw notFound;
    }
    throw new VersionConflictError(table, id);
  }
  return result.rows[0];
}

module.exports = { versionedUpdate, VersionConflictError };
