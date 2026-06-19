/**
 * Server 单例 stores(lazy initialization)
 *
 * 注意: SQLiteQuotaStore/SQLiteAuditSink 必须在 initDB() 之后才能实例化。
 * 用 getter 模式避免 ESM 顶层求值时 getDB() 抛错。
 */

import { getDB } from './db.js';
import { SQLiteQuotaStore, SQLiteAuditSink } from './db.js';
import { auditor } from '@tender/audit';
import { setQuotaExceededHandler } from '@tender/quota';

let _quotaStore: SQLiteQuotaStore | null = null;
let _auditSink: SQLiteAuditSink | null = null;
let _sinkAttached = false;

export function getQuotaStore(): SQLiteQuotaStore {
  if (!_quotaStore) {
    _quotaStore = new SQLiteQuotaStore(getDB());
    // 桥接 quota 超限 → audit
    setQuotaExceededHandler(async (event) => {
      const { audit } = await import('@tender/audit');
      audit.quotaExceeded({
        tenantId: event.tenantId,
        target: event.kind,
        meta: { plan: event.plan, limit: event.limit, count: event.count },
      });
    });
  }
  return _quotaStore;
}

export function getAuditSink(): SQLiteAuditSink {
  if (!_auditSink) {
    _auditSink = new SQLiteAuditSink(getDB());
  }
  if (!_sinkAttached) {
    auditor.addSink(_auditSink);
    _sinkAttached = true;
  }
  return _auditSink;
}

/**
 * 兼容旧 API:在 initDB 之前不要引用
 */
export const sqliteQuotaStore = new Proxy({} as SQLiteQuotaStore, {
  get(_target, prop) {
    return (getQuotaStore() as any)[prop];
  },
});
