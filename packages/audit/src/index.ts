/**
 * @tender/audit — 多租户审计日志
 *
 * 灵感来源: 长风 lib/audit.js(失败不阻断 + 长度截断 + 8 埋点)
 */

export {
  Auditor,
  MemoryAuditSink,
  auditor,
  audit,
  type AuditAction,
  type AuditEvent,
  type AuditSink,
} from './audit.js';
