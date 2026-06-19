/**
 * Audit 审计模块
 *
 * 灵感来源: 长风 lib/audit.js(失败不阻断主流程 + 长度截断)
 *
 * 关键设计:
 * 1. 失败静默(不阻断主流程)
 * 2. meta 长度硬截断(防注入)
 * 3. 通用 audit() 入口,8 个便捷 wrapper
 */

import { Bus, Events } from '@tender/core';

export type AuditAction =
  | 'llm.call'
  | 'llm.stream'
  | 'rag.upsert'
  | 'rag.query'
  | 'tool.call'
  | 'tool.blocked'
  | 'auth.login'
  | 'auth.register'
  | 'auth.api_key.created'
  | 'admin.tenant.create'
  | 'admin.user.update'
  | 'admin.audit.export'
  | 'billing.view'
  | 'quota.exceeded'
  | 'provider.failed'
  | 'scope.aborted'
  | 'custom';

export interface AuditEvent {
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  action: AuditAction;
  target?: string;
  meta?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  status?: 'ok' | 'error';
  errorCode?: string;
}

export interface AuditSink {
  insert(event: AuditEvent & { createdAt: number }): Promise<void> | void;
}

/**
 * 默认内存 sink(测试用)
 */
export class MemoryAuditSink implements AuditSink {
  events: Array<AuditEvent & { createdAt: number }> = [];
  async insert(event: AuditEvent & { createdAt: number }): Promise<void> {
    this.events.push(event);
  }
}

const META_MAX_KEYS = 32;
const META_MAX_VALUE_LEN = 200;

function sanitizeMeta(meta?: Record<string, unknown>): Record<string, unknown> {
  if (!meta) return {};
  const keys = Object.keys(meta).slice(0, META_MAX_KEYS);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const val = meta[key];
    if (typeof val === 'string') {
      result[key] = val.slice(0, META_MAX_VALUE_LEN);
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      result[key] = val;
    } else if (val === null || val === undefined) {
      result[key] = null;
    } else {
      // 对象/数组 → JSON.stringify 截断
      try {
        result[key] = JSON.stringify(val).slice(0, META_MAX_VALUE_LEN);
      } catch {
        result[key] = '[unserializable]';
      }
    }
  }
  return result;
}

/**
 * 全局审计器
 */
export class Auditor {
  private sinks: AuditSink[] = [];

  addSink(sink: AuditSink): void {
    this.sinks.push(sink);
  }

  /**
   * 写入审计事件(失败静默,不阻断主流程)
   */
  async audit(event: AuditEvent): Promise<void> {
    const sanitized: AuditEvent & { createdAt: number } = {
      ...event,
      meta: sanitizeMeta(event.meta),
      createdAt: Date.now(),
    };

    // 广播事件
    Bus.emit(Events.AUDIT_LOG, sanitized);

    // 写入所有 sink
    for (const sink of this.sinks) {
      try {
        await sink.insert(sanitized);
      } catch (err) {
        // 失败不阻断(长风 lib/audit.js 范式)
        console.error('[audit] sink insert failed:', err);
      }
    }
  }
}

export const auditor = new Auditor();

/**
 * 便捷 wrapper(对照长风 lib/audit.js 的 auditXxx 系列)
 */
export const audit = {
  llmCall: (e: Omit<AuditEvent, 'action'>) =>
    auditor.audit({ ...e, action: 'llm.call' }),
  ragQuery: (e: Omit<AuditEvent, 'action'>) =>
    auditor.audit({ ...e, action: 'rag.query' }),
  toolCall: (e: Omit<AuditEvent, 'action'>) =>
    auditor.audit({ ...e, action: 'tool.call' }),
  toolBlocked: (e: Omit<AuditEvent, 'action'>) =>
    auditor.audit({ ...e, action: 'tool.blocked', status: 'error' }),
  login: (e: Omit<AuditEvent, 'action'>) =>
    auditor.audit({ ...e, action: 'auth.login' }),
  register: (e: Omit<AuditEvent, 'action'>) =>
    auditor.audit({ ...e, action: 'auth.register' }),
  bindPlatform: (e: Omit<AuditEvent, 'action'>) =>
    auditor.audit({ ...e, action: 'custom', target: 'bind_platform' }),
  exportData: (e: Omit<AuditEvent, 'action'>) =>
    auditor.audit({ ...e, action: 'admin.audit.export' }),
  quotaExceeded: (e: Omit<AuditEvent, 'action'>) =>
    auditor.audit({ ...e, action: 'quota.exceeded', status: 'error' }),
  custom: (e: Omit<AuditEvent, 'action'>) =>
    auditor.audit({ ...e, action: 'custom' }),
};
