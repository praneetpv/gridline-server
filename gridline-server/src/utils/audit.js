// Writes one audit_log row per mutation (see spec §1.8) and returns the exact payload shape
// the realtime layer broadcasts to every connected client (spec §3) — the audit trail and the
// live event are deliberately the same object, since a client subscribing "live" is really just
// tailing the audit log in real time.

async function recordChange(client, { entityType, entityId, action, fieldChanged, oldValue, newValue, performedBy, performedVia }) {
  const { rows } = await client.query(
    `insert into audit_log (entity_type, entity_id, action, field_changed, old_value, new_value, performed_by, performed_via)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning *`,
    [entityType, entityId, action, fieldChanged || null, oldValue != null ? JSON.stringify(oldValue) : null,
      newValue != null ? JSON.stringify(newValue) : null, performedBy, performedVia]
  );
  return rows[0];
}

/** Shapes an audit_log row (plus the user who made the change) into the WebSocket event payload. */
function toEventPayload(auditRow, entity, user) {
  const typeSuffix = auditRow.action === 'delete' ? 'deleted' : auditRow.action === 'create' ? 'created' : 'updated';
  return {
    type: `${auditRow.entity_type}.${typeSuffix}`,
    entityId: auditRow.entity_id,
    field: auditRow.field_changed || undefined,
    oldValue: auditRow.old_value || undefined,
    newValue: auditRow.new_value || undefined,
    entity: entity || undefined,
    version: entity && entity.version != null ? entity.version : undefined,
    performedBy: user ? { id: user.id, name: user.name, role: user.role } : undefined,
    performedVia: auditRow.performed_via,
    performedAt: auditRow.performed_at,
  };
}

module.exports = { recordChange, toEventPayload };
