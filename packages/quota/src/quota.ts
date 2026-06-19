/**
 * Quota 配额系统
 *
 * 灵感来源: 长风 lib/quota.js + usage_counters 表
 *
 * 关键设计:
 * 1. (scope, key, day) 通用计数器,支持任意 kind(llm/rag/tool)
 * 2. UPSERT 原子自增(防并发 race)
 * 3. consume() 超额自动 refund(响应 ok 才扣,失败退)
 * 4. 多种 plan 限额
 */

import { Bus, Events } from '@tender/core';

export type QuotaKind = 'llm' | 'rag' | 'tool';

export type Plan = 'free' | 'pro' | 'enterprise';

/**
 * 配额超限回调(可选,不强制依赖 @tender/audit)
 */
export type OnQuotaExceeded = (event: {
  tenantId: string;
  kind: QuotaKind;
  plan: Plan;
  count: number;
  limit: number;
}) => void | Promise<void>;

let _onQuotaExceeded: OnQuotaExceeded | null = null;

/**
 * 设置配额超限回调(由 server 注入,把 quota 事件桥接到 audit)
 */
export function setQuotaExceededHandler(handler: OnQuotaExceeded | null): void {
  _onQuotaExceeded = handler;
}

/**
 * 各 plan 的限额(按日)
 *
 * 设计原则:免费档严控防白嫖,enterprise 几乎不限
 */
export const PLAN_LIMITS: Record<Plan, Record<QuotaKind, number>> = {
  free: { llm: 50, rag: 20, tool: 10 },
  pro: { llm: 10_000, rag: 5_000, tool: 1_000 },
  enterprise: { llm: Number.MAX_SAFE_INTEGER, rag: Number.MAX_SAFE_INTEGER, tool: Number.MAX_SAFE_INTEGER },
};

/**
 * 行级接口(允许接入任何存储:SQLite/Postgres/Redis)
 *
 * 调用方需要提供 atomicIncrement(scope, key, day, n) 方法
 */
export interface QuotaStore {
  /**
   * 原子:把 (scope, key, day) 的计数 +n,返回新值
   */
  atomicIncrement(scope: string, key: string, day: string, n: number): Promise<number> | number;

  /**
   * 把 (scope, key, day) 的计数 -n(用于 refund),返回新值
   */
  atomicDecrement(scope: string, key: string, day: string, n: number): Promise<number> | number;

  /**
   * 读当前计数
   */
  get(scope: string, key: string, day: string): Promise<number> | number;
}

export interface ConsumeResult {
  /** 当前计数(含本次) */
  count: number;
  /** 该 plan 的限额 */
  limit: number;
  /** 是否超额 */
  exceeded: boolean;
  /** 是否已 refund */
  refunded: boolean;
}

/**
 * 工厂:从 plan+kind 生成 (scope, key, day) tuple
 */
export function todayDateString(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function buildScopeKey(tenantId: string, kind: QuotaKind): { scope: string; key: string } {
  return { scope: `${tenantId}:${kind}`, key: tenantId };
}

/**
 * 查询当前用量
 */
export async function getQuota(
  store: QuotaStore,
  tenantId: string,
  kind: QuotaKind,
  plan: Plan
): Promise<{ count: number; limit: number }> {
  const { scope, key } = buildScopeKey(tenantId, kind);
  const day = todayDateString();
  const count = await store.get(scope, key, day);
  return { count, limit: PLAN_LIMITS[plan][kind] };
}

/**
 * 消费一次配额(原子)
 *
 * @example
 * const result = await consume(store, tenantId, 'llm', 'pro');
 * if (result.exceeded) {
 *   return reply.code(429).send({ error: 'quota_exceeded' });
 * }
 * try {
 *   const llmResp = await router.route(req);
 *   return reply.send(llmResp);
 * } catch (err) {
 *   await refund(store, tenantId, 'llm');  // 失败退还
 *   throw err;
 * }
 */
export async function consume(
  store: QuotaStore,
  tenantId: string,
  kind: QuotaKind,
  plan: Plan
): Promise<ConsumeResult> {
  const { scope, key } = buildScopeKey(tenantId, kind);
  const day = todayDateString();
  const limit = PLAN_LIMITS[plan][kind];

  const count = await store.atomicIncrement(scope, key, day, 1);

  if (count > limit) {
    // 超额,立即退一格
    await store.atomicDecrement(scope, key, day, 1);
    Bus.emit(Events.QUOTA_EXCEEDED, { tenantId, kind, plan, count: count - 1, limit });
    // 触发回调(由 server 注入 audit)
    if (_onQuotaExceeded) {
      await _onQuotaExceeded({ tenantId, kind, plan, count: count - 1, limit });
    }
    return { count: count - 1, limit, exceeded: true, refunded: true };
  }

  return { count, limit, exceeded: false, refunded: false };
}

/**
 * 退还配额(失败回滚用)
 */
export async function refund(
  store: QuotaStore,
  tenantId: string,
  kind: QuotaKind,
  n = 1
): Promise<number> {
  const { scope, key } = buildScopeKey(tenantId, kind);
  const day = todayDateString();
  return store.atomicDecrement(scope, key, day, n);
}

/**
 * 内存版 store(测试用)
 */
export class MemoryQuotaStore implements QuotaStore {
  private data = new Map<string, number>();

  private _key(scope: string, key: string, day: string): string {
    return `${scope}|${key}|${day}`;
  }

  async atomicIncrement(scope: string, key: string, day: string, n: number): Promise<number> {
    const k = this._key(scope, key, day);
    const current = this.data.get(k) ?? 0;
    const next = current + n;
    this.data.set(k, next);
    return next;
  }

  async atomicDecrement(scope: string, key: string, day: string, n: number): Promise<number> {
    const k = this._key(scope, key, day);
    const current = this.data.get(k) ?? 0;
    const next = Math.max(0, current - n);
    this.data.set(k, next);
    return next;
  }

  async get(scope: string, key: string, day: string): Promise<number> {
    return this.data.get(this._key(scope, key, day)) ?? 0;
  }
}
