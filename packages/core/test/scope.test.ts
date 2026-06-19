import { describe, it, expect, beforeEach } from 'vitest';
import {
  Scope,
  ScopeNS,
  ScopeAbortedError,
  NoActiveScopeError,
  runScope,
  Bus,
  Events,
  StaleGuard,
  guardAsync,
} from '../src/index.js';

describe('Scope — per-session state guard', () => {
  const baseOpts = {
    tenantId: 'tenant_A',
    userId: 'user_1',
    sessionId: 'session_abc',
  };

  describe('基础行为', () => {
    it('创建 scope 必须有 tenantId/userId/sessionId', () => {
      expect(() => new Scope({ tenantId: '', userId: 'u', sessionId: 's' } as never)).toThrow();
      expect(() => new Scope({ tenantId: 't', userId: '', sessionId: 's' } as never)).toThrow();
      expect(() => new Scope({ tenantId: 't', userId: 'u', sessionId: '' } as never)).toThrow();
    });

    it('set/get/has/delete 基础 CRUD', () => {
      const scope = new Scope(baseOpts);
      expect(scope.has('foo')).toBe(false);
      scope.set('foo', 'bar');
      expect(scope.has('foo')).toBe(true);
      expect(scope.get('foo')).toBe('bar');
      expect(scope.delete('foo')).toBe(true);
      expect(scope.has('foo')).toBe(false);
    });

    it('scopes/metadata 是只读', () => {
      const scope = new Scope({ ...baseOpts, scopes: ['read', 'write'] });
      expect(() => (scope.scopes as string[]).push('admin')).toThrow();
    });
  });

  describe('守门写入(核心创新)', () => {
    it('abort 后 set 抛 ScopeAbortedError', () => {
      const scope = new Scope(baseOpts);
      scope.set('foo', 'bar');
      scope.abort('switch-platform');
      expect(() => scope.set('foo', 'baz')).toThrow(ScopeAbortedError);
    });

    it('abort 触发所有 AbortController', () => {
      const scope = new Scope(baseOpts);
      const c1 = scope.registerAbortController();
      const c2 = scope.registerAbortController();
      expect(c1.signal.aborted).toBe(false);
      scope.abort('test');
      expect(c1.signal.aborted).toBe(true);
      expect(c2.signal.aborted).toBe(true);
    });

    it('abort 后 state 自动清空', () => {
      const scope = new Scope(baseOpts);
      scope.set('foo', 'bar');
      scope.set('baz', 'qux');
      scope.abort('test');
      expect(scope.snapshot()).toEqual({});
    });

    it('重复 abort 幂等', () => {
      const scope = new Scope(baseOpts);
      scope.abort('first');
      expect(() => scope.abort('second')).not.toThrow();
      expect(scope.abortedReason()).toBe('first');
    });
  });

  describe('AsyncLocalStorage with-scope 模式', () => {
    it('run() 中可 Scope.current() 拿到当前 scope', async () => {
      const scope = new Scope(baseOpts);
      await scope.run(async () => {
        const current = ScopeNS.current();
        expect(current.sessionId).toBe('session_abc');
      });
    });

    it('run() 外抛 NoActiveScopeError', () => {
      expect(() => ScopeNS.current()).toThrow(NoActiveScopeError);
    });

    it('run() 完成后自动 abort(默认行为)', async () => {
      const scope = new Scope(baseOpts);
      await scope.run(async () => {
        scope.set('foo', 'bar');
      });
      expect(scope.isAborted()).toBe(true);
    });

    it('runScope 工厂函数', async () => {
      const result = await runScope(baseOpts, async () => {
        const scope = ScopeNS.current();
        scope.set('answer', 42);
        return scope.get<number>('answer');
      });
      expect(result).toBe(42);
    });

    it('异步中也能 Scope.current()(AsyncLocalStorage 隔离)', async () => {
      const scope1 = new Scope({ ...baseOpts, sessionId: 's1' });
      const scope2 = new Scope({ ...baseOpts, sessionId: 's2' });

      const promises = [
        scope1.run(async () => {
          await new Promise((r) => setTimeout(r, 10));
          return ScopeNS.current().sessionId;
        }),
        scope2.run(async () => {
          await new Promise((r) => setTimeout(r, 5));
          return ScopeNS.current().sessionId;
        }),
      ];

      const [r1, r2] = await Promise.all(promises);
      expect(r1).toBe('s1');
      expect(r2).toBe('s2');
    });
  });

  describe('事件总线集成', () => {
    it('scope abort 广播 scope:aborted', () => {
      const events: unknown[] = [];
      const unsub = Bus.on(Events.SCOPE_ABORTED, (payload) => {
        events.push(payload);
      });

      const scope = new Scope(baseOpts);
      scope.abort('test');
      expect(events).toHaveLength(1);
      expect((events[0] as { reason: string }).reason).toBe('test');

      unsub();
    });

    it('scope set 广播 scope:write', () => {
      const events: string[] = [];
      const unsub = Bus.on(Events.SCOPE_WRITE, (payload) => {
        const p = payload as { key: string };
        events.push(p.key);
      });

      const scope = new Scope(baseOpts);
      scope.set('a', 1);
      scope.set('b', 2);
      expect(events).toEqual(['a', 'b']);

      unsub();
    });
  });
});

describe('StaleGuard — 异步 stale 守门', () => {
  const baseOpts = {
    tenantId: 'tenant_A',
    userId: 'user_1',
    sessionId: 'session_abc',
  };

  it('pin 后 isStale 初始 false', () => {
    const guard = new StaleGuard();
    const pin = guard.pin('url', 'http://a.com');
    expect(pin.isStale()).toBe(false);
  });

  it('markStale 后 isStale true', () => {
    const guard = new StaleGuard();
    const pin = guard.pin('url', 'http://a.com');
    pin.markStale('manual');
    expect(pin.isStale()).toBe(true);
  });

  it('scope abort 自动 markStale', async () => {
    const guard = new StaleGuard();
    const scope = new Scope(baseOpts);
    const pin = guard.pin('url', 'http://a.com', scope);

    // 等待事件循环传播
    scope.abort('test');
    await new Promise((r) => setImmediate(r));

    expect(pin.isStale()).toBe(true);
  });

  it('guardAsync 在 scope abort 时返回 undefined', async () => {
    const scope = new Scope(baseOpts);
    const result = await guardAsync(scope, { url: 'http://a.com' }, async (_snap, signal) => {
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(undefined));
        setTimeout(() => resolve('result'), 100);
      });
    });
    scope.abort('test');
    // 给 abort 一点时间传播
    await new Promise((r) => setTimeout(r, 10));
    expect(result).toBeUndefined();
  });
});

describe('真实场景模拟 — 长风 7 类污染 复现 + 修复', () => {
  it('场景 1: 切平台时 stale 数据不回流', async () => {
    // 模拟长风 v8.7.2:initPlatformTabs 切平台不清_lastAccountData
    // 修复:用 Scope,切平台 = scope.abort()

    const platformA = new Scope({
      tenantId: 't', userId: 'u', sessionId: 'douyin',
    });
    const platformB = new Scope({
      tenantId: 't', userId: 'u', sessionId: 'xiaohongshu',
    });

    // 平台 A 启动长 polling
    const pollPromise = platformA.run(async () => {
      const scope = ScopeNS.current();
      scope.set('_lastAccountData', { platform: 'douyin', name: '账号A' });
      // 模拟 polling 中
      await new Promise((r) => setTimeout(r, 50));
      // polling 完成时检查 scope 是否还活着
      if (scope.isAborted()) return null;
      return scope.get('_lastAccountData');
    });

    // 切换到平台 B = abort platformA
    platformA.abort('switch-to-xiaohongshu');

    const resultA = await pollPromise;
    expect(resultA).toBeNull(); // ✅ stale 数据被丢弃,不会污染 B

    // 平台 B 干净起步
    await platformB.run(async () => {
      const scope = ScopeNS.current();
      expect(scope.has('_lastAccountData')).toBe(false); // ✅ 没有 A 的残留
    });
  });

  it('场景 2: 诊断他人不污染本尊锁定画像', async () => {
    // 模拟长风 b0f55b9 修复:routeMine.isSwitch 没查 locked
    // 修复:用 scope 隔离,诊断他人 = 独立 scope,绝不动本尊 scope

    const myAccountScope = new Scope({
      tenantId: 't', userId: 'me', sessionId: 'my-locked',
      metadata: { positioning: { locked: true, niche: '命理' } },
    });

    // 在 myAccountScope 上锁定画像
    myAccountScope.set('positioning', { locked: true, niche: '命理' });
    myAccountScope.set('persona', '李总');

    // 诊断他人 — 独立 scope
    const otherScope = new Scope({
      tenantId: 't', userId: 'me', sessionId: 'diagnose-other',
    });

    await otherScope.run(async () => {
      const scope = ScopeNS.current();
      // 写入他人诊断数据到自己的 scope(隔离)
      scope.set('diagnosing', { nickname: '卷王之王', niche: '教育' });
    });

    // ✅ 本尊 scope 不受任何影响
    expect(myAccountScope.get('positioning')).toEqual({ locked: true, niche: '命理' });
    expect(myAccountScope.get('persona')).toBe('李总');
    expect(myAccountScope.has('diagnosing')).toBe(false);
  });

  it('场景 3: 异步 polling stale 守门', async () => {
    // 模拟 _pollFull / _pollAccountHealth 4 处复制粘贴
    // 修复:StaleGuard.pin + scope 联动

    const guard = new StaleGuard();
    const scope = new Scope({
      tenantId: 't', userId: 'u', sessionId: 's1',
    });

    const pin = guard.pin('accountUrl', 'http://platform-a/account/123', scope);

    // 启动 polling
    const pollPromise = (async () => {
      // 模拟 long polling
      await new Promise((r) => setTimeout(r, 30));
      // 完成时检查
      if (pin.isStale()) return 'STALE_DROPPED';
      return 'FRESH_DATA';
    })();

    // 中途切平台
    setTimeout(() => scope.abort('switch-platform'), 10);

    const result = await pollPromise;
    expect(result).toBe('STALE_DROPPED');
  });
});
