import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';

export interface AuditEvent {
  userId?: string | null;
  businessId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
  requestId?: string | null;
}

/**
 * Keys whose values must never reach the audit table. The audit log is the one
 * place that records what people did, which makes it exactly the place someone
 * would go looking for what people typed.
 */
const REDACT = /pass|secret|token|authorization|cookie|account_number|routing_number|ssn|tax_id/i;

export function redact(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!detail) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (REDACT.test(k)) out[k] = '[redacted]';
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = redact(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}

/**
 * Writes an audit row. Pass the transaction client when the event describes a
 * change: the audit entry then commits or rolls back with the change itself,
 * so the log can never claim something happened that did not.
 */
export async function audit(e: AuditEvent, client?: PoolClient): Promise<void> {
  const q = client ?? getPool();
  await q.query(
    `INSERT INTO audit_log (user_id, business_id, action, entity, entity_id, detail, ip, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      e.userId ?? null,
      e.businessId ?? null,
      e.action,
      e.entity,
      e.entityId ?? null,
      JSON.stringify(redact(e.detail)),
      e.ip ?? null,
      e.requestId ?? null,
    ],
  );
}
