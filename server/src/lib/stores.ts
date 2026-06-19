/**
 * Server 单例 stores
 */

import { getDB } from './db.js';
import { SQLiteQuotaStore, SQLiteAuditSink } from './db.js';
import { auditor } from '@tender/audit';

export const sqliteQuotaStore = new SQLiteQuotaStore(getDB());
export const sqliteAuditSink = new SQLiteAuditSink(getDB());

// 自动挂载 audit sink
auditor.addSink(sqliteAuditSink);
