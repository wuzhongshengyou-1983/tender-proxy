import { describe, it, expect, beforeEach } from 'vitest';
import {
  consume,
  refund,
  getQuota,
  MemoryQuotaStore,
  PLAN_LIMITS,
  todayDateString,
} from '../src/index.js';

describe('Quota — 基础行为', () => {
  let store: MemoryQuotaStore;

  beforeEach(() => {
    store = new MemoryQuotaStore();
  });

  it('consume 单次', async () => {
    const r = await consume(store, 'tenant_A', 'llm', 'free');
    expect(r.count).toBe(1);
    expect(r.limit).toBe(50);
    expect(r.exceeded).toBe(false);
  });

  it('consume 接近限额时正常返回', async () => {
    for (let i = 0; i < 49; i++) {
      await consume(store, 'tenant_A', 'llm', 'free');
    }
    const r = await consume(store, 'tenant_A', 'llm', 'free');
    expect(r.count).toBe(50);
    expect(r.exceeded).toBe(false);
  });

  it('第 51 次 consume 超额 + 自动 refund', async () => {
    for (let i = 0; i < 50; i++) {
      await consume(store, 'tenant_A', 'llm', 'free');
    }
    const r = await consume(store, 'tenant_A', 'llm', 'free');
    expect(r.count).toBe(50);  // 退一格,保持 50
    expect(r.exceeded).toBe(true);
    expect(r.refunded).toBe(true);
  });

  it('不同 tenant 配额独立', async () => {
    await consume(store, 'tenant_A', 'llm', 'free');
    await consume(store, 'tenant_A', 'llm', 'free');
    await consume(store, 'tenant_B', 'llm', 'free');

    const a = await getQuota(store, 'tenant_A', 'llm', 'free');
    const b = await getQuota(store, 'tenant_B', 'llm', 'free');

    expect(a.count).toBe(2);
    expect(b.count).toBe(1);
  });

  it('不同 kind 配额独立', async () => {
    await consume(store, 'tenant_A', 'llm', 'free');
    await consume(store, 'tenant_A', 'rag', 'free');

    const llm = await getQuota(store, 'tenant_A', 'llm', 'free');
    const rag = await getQuota(store, 'tenant_A', 'rag', 'free');

    expect(llm.count).toBe(1);
    expect(rag.count).toBe(1);
  });

  it('refund 退还配额', async () => {
    await consume(store, 'tenant_A', 'llm', 'free');
    await consume(store, 'tenant_A', 'llm', 'free');
    await refund(store, 'tenant_A', 'llm');

    const r = await getQuota(store, 'tenant_A', 'llm', 'free');
    expect(r.count).toBe(1);
  });

  it('refund 不能为负数', async () => {
    await refund(store, 'tenant_A', 'llm');
    await refund(store, 'tenant_A', 'llm');

    const r = await getQuota(store, 'tenant_A', 'llm', 'free');
    expect(r.count).toBe(0);
  });

  it('PLAN_LIMITS 各档限额', () => {
    expect(PLAN_LIMITS.free.llm).toBe(50);
    expect(PLAN_LIMITS.pro.llm).toBe(10_000);
    expect(PLAN_LIMITS.enterprise.llm).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('todayDateString 格式正确', () => {
    expect(todayDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('Quota — 并发原子性(内存版模拟)', () => {
  it('并发 consume 100 次不应超额', async () => {
    const store = new MemoryQuotaStore();
    const promises = Array.from({ length: 100 }, () =>
      consume(store, 'tenant_A', 'llm', 'free')
    );
    const results = await Promise.all(promises);

    const exceeded = results.filter(r => r.exceeded).length;
    const succeeded = results.filter(r => !r.exceeded).length;

    expect(succeeded).toBe(50); // free 限额 50
    expect(exceeded).toBe(50);
  });
});
