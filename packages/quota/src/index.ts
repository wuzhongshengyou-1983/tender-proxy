/**
 * @tender/quota — 配额系统
 *
 * 灵感来源: 长风 lib/quota.js + usage_counters 原子 UPSERT
 */

export {
  consume,
  refund,
  getQuota,
  todayDateString,
  buildScopeKey,
  setQuotaExceededHandler,
  MemoryQuotaStore,
  PLAN_LIMITS,
  type QuotaKind,
  type Plan,
  type QuotaStore,
  type ConsumeResult,
  type OnQuotaExceeded,
} from './quota.js';
