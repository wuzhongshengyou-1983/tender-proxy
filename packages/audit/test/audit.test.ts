import { describe, it, expect, beforeEach } from 'vitest';
import { Auditor, MemoryAuditSink, auditor, audit } from '../src/index.js';

describe('Audit — 基础行为', () => {
  let sink: MemoryAuditSink;
  let localAuditor: Auditor;

  beforeEach(() => {
    sink = new MemoryAuditSink();
    localAuditor = new Auditor();
    localAuditor.addSink(sink);
  });

  it('audit() 写入 sink', async () => {
    await localAuditor.audit({
      tenantId: 't1', userId: 'u1', action: 'llm.call',
      target: 'deepseek', meta: { tokens: 100 },
    });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0].tenantId).toBe('t1');
    expect(sink.events[0].action).toBe('llm.call');
  });

  it('meta 长度截断(防注入)', async () => {
    await localAuditor.audit({
      tenantId: 't1', action: 'custom',
      meta: { longString: 'A'.repeat(1000) },
    });
    const val = sink.events[0].meta!.longString as string;
    expect(val.length).toBe(200); // META_MAX_VALUE_LEN
  });

  it('meta keys 数量截断', async () => {
    const meta: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) meta[`key_${i}`] = 'v';
    await localAuditor.audit({ tenantId: 't', action: 'custom', meta });
    expect(Object.keys(sink.events[0].meta!).length).toBeLessThanOrEqual(32);
  });

  it('对象类型 meta → JSON.stringify 截断', async () => {
    await localAuditor.audit({
      tenantId: 't', action: 'custom',
      meta: { big: { nested: { deep: 'value'.repeat(100) } } },
    });
    expect(typeof sink.events[0].meta!.big).toBe('string');
  });

  it('sink 失败不阻断主流程', async () => {
    const failingSink = {
      insert: () => Promise.reject(new Error('disk full')),
    };
    const goodSink = new MemoryAuditSink();
    const auditor2 = new Auditor();
    auditor2.addSink(failingSink);
    auditor2.addSink(goodSink);

    await expect(auditor2.audit({ tenantId: 't', action: 'custom' })).resolves.toBeUndefined();
    expect(goodSink.events).toHaveLength(1);
  });

  it('事件带 createdAt 时间戳', async () => {
    const before = Date.now();
    await localAuditor.audit({ tenantId: 't', action: 'custom' });
    const after = Date.now();
    const ts = sink.events[0].createdAt;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe('便捷 wrapper', () => {
  let sink: MemoryAuditSink;
  let localAuditor: Auditor;

  beforeEach(() => {
    sink = new MemoryAuditSink();
    localAuditor = new Auditor();
    localAuditor.addSink(sink);
  });

  it('audit.llmCall → action: llm.call', async () => {
    await audit.llmCall({ tenantId: 't', userId: 'u', target: 'deepseek', meta: { tokens: 100 } });
    expect(sink.events[0].action).toBe('llm.call');
  });

  it('audit.toolBlocked → status: error', async () => {
    await audit.toolBlocked({ tenantId: 't', target: 'evil_tool' });
    expect(sink.events[0].status).toBe('error');
    expect(sink.events[0].action).toBe('tool.blocked');
  });

  it('audit.quotaExceeded → status: error', async () => {
    await audit.quotaExceeded({ tenantId: 't', userId: 'u', target: 'deepseek' });
    expect(sink.events[0].status).toBe('error');
  });
});
