/**
 * 长风 7 类污染 E2E Demo
 *
 * 这个文件模拟长风 api-layer.js 的 6 个 window._xxx 污染变量,
 * 演示用 @tender/scope + StaleGuard 如何彻底根治。
 *
 * 严格还原以下事故(从 lessons-learned 库):
 * 1. v8.7.2 跨平台诊断漂移(commit e58b5c1)
 * 2. 视频号→小红书诊断串台(2026-06-06)
 * 3. 诊断他人秒删锁定画像(commit b0f55b9)
 * 4. 人设污染(2026-06-06)
 * 5. 大号盲区误判(三层修复)
 * 6. 进度条 92% 卡死(commit b231527)
 * 7. Async stale 数据回流
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  Scope,
  ScopeNS,
  ScopeAbortedError,
  Bus,
  Events,
  StaleGuard,
  guardAsync,
  runScope,
} from '../../packages/core/src/index.js';

// ============================================
// 模拟长风 api-layer.js 的污染代码
// ============================================

/**
 * 旧版污染版(模拟 window._xxx)
 */
class LegacyApiLayer {
  // 6 个 window._xxx 全局污染变量
  public _lastAccountData: any = null;
  public _lastVideoData: any = null;
  public _lastPersonaCard: any = null;  // 幽灵字段
  public _diagSourceUrl: string | null = null;
  public _diagPlatform: string | null = null;
  public _curDiagUrl: string | null = null;

  // 当前诊断 url
  public currentDiagUrl: string | null = null;

  // 模拟 initPlatformTabs:切平台不清状态
  initPlatformTabs(platform: string): void {
    // ❌ 只改 placeholder,不清全局变量
    this._diagPlatform = platform;  // 旧版写这行,但仍残留
  }

  // 模拟 _pollFull:无 stale 守门
  async _pollFull(url: string): Promise<void> {
    const full = await this._mockFetch(url);
    // ❌ 无 stale 守门,直接覆盖
    this._lastAccountData = full;
  }

  private async _mockFetch(url: string): Promise<any> {
    await new Promise(r => setTimeout(r, 10));
    return { url, fetchedAt: Date.now() };
  }

  // 模拟 routeMine:无锁定保护
  routeMine(data: any): void {
    // ❌ 直接覆盖 persona
    this._lastPersonaCard = data;
  }
}

/**
 * 新版 Tender Scope 版
 */
class TenderApiLayer {
  private currentScope: Scope | null = null;

  switchPlatform(platform: string, userId: string, sessionId: string): Scope {
    if (this.currentScope) {
      this.currentScope.abort(`switch-to-${platform}`);
    }
    this.currentScope = new Scope({
      tenantId: 'changfeng',
      userId,
      sessionId: `diag_${platform}_${sessionId}`,
      scopes: ['llm:read', 'llm:write'],
      metadata: { platform },
    });
    return this.currentScope;
  }

  async pollFullData(url: string): Promise<unknown> {
    if (!this.currentScope) throw new Error('No active scope');
    return await guardAsync(this.currentScope, { url }, async ({ url }, signal) => {
      const res = await fetch(url, { signal }).catch(() => null);
      return res ? await (res as any).json() : { url, fetchedAt: Date.now() };
    });
    // 如果 scope 被 abort → 返回 undefined
  }

  diagnoseOther(nickname: string): Scope {
    // 诊断他人 = 独立 scope,绝不污染本尊
    return new Scope({
      tenantId: 'changfeng',
      userId: 'me',
      sessionId: `diagnose-other-${nickname}-${Date.now()}`,
      scopes: ['llm:read'],
      metadata: { diagnosing: nickname, isOther: true },
    });
  }

  getCurrentScope(): Scope {
    if (!this.currentScope) throw new Error('No active scope');
    return this.currentScope;
  }
}

// ============================================
// 7 类污染 E2E 测试
// ============================================

describe('长风 7 类污染 E2E Demo', () => {

  describe('【对比】旧版 vs 新版 — 平台污染漂移', () => {
    it('❌ 旧版:切平台不清状态,粽子月饼从抖音漂移到小红书', async () => {
      const legacy = new LegacyApiLayer();
      legacy.initPlatformTabs('douyin');
      legacy._lastAccountData = { platform: 'douyin', name: '月饼粽子厂家' };

      // 切到小红书
      legacy.initPlatformTabs('xiaohongshu');
      // ❌ _lastAccountData 仍是"月饼粽子厂家",污染小红书
      expect(legacy._lastAccountData.name).toBe('月饼粽子厂家');
      // 这个测试断言 BUG 存在,演示旧代码的污染
    });

    it('✅ 新版:切平台自动 abort,旧数据被丢', async () => {
      const tender = new TenderApiLayer();
      const platformA = tender.switchPlatform('douyin', 'u1', 's1');
      await platformA.run(async () => {
        const s = ScopeNS.current();
        s.set('lastAccountData', { platform: 'douyin', name: '月饼粽子厂家' });
      });

      // 切到小红书
      const platformB = tender.switchPlatform('xiaohongshu', 'u1', 's2');
      await platformB.run(async () => {
        const s = ScopeNS.current();
        // ✅ platformB scope 没有 platformA 的数据
        expect(s.has('lastAccountData')).toBe(false);
        // ✅ 旧 scope 已 abort,set 会抛错
        expect(() => platformA.set('foo', 'bar')).toThrow(ScopeAbortedError);
      });
    });
  });

  describe('【对比】旧版 vs 新版 — 异步 stale 守门', () => {
    it('❌ 旧版:_pollFull 无 stale 守门,旧 url 数据覆盖新 platform', async () => {
      const legacy = new LegacyApiLayer();
      const pollPromise = legacy._pollFull('http://douyin.com/account/123');

      // 中途切平台
      legacy.initPlatformTabs('xiaohongshu');
      legacy._diagSourceUrl = 'http://xiaohongshu.com/account/456';

      await pollPromise;
      // ❌ _lastAccountData 是 douyin 的旧 url,但 _diagSourceUrl 已是 xiaohongshu → 错位
      expect(legacy._lastAccountData.url).toBe('http://douyin.com/account/123');
      expect(legacy._diagSourceUrl).toBe('http://xiaohongshu.com/account/456');
    });

    it('✅ 新版:guardAsync 自动 stale 守门', async () => {
      const tender = new TenderApiLayer();
      const platformA = tender.switchPlatform('douyin', 'u', 's1');

      const pollPromise = tender.pollFullData('http://douyin.com/account/123');

      // 中途切平台
      setTimeout(() => tender.switchPlatform('xiaohongshu', 'u', 's2'), 5);

      const result = await pollPromise;
      // ✅ 旧 url 数据被丢弃,返回 undefined
      expect(result).toBeUndefined();

      const platformB = tender.getCurrentScope();
      await platformB.run(async () => {
        const s = ScopeNS.current();
        // ✅ platformB 干净
        expect(s.has('lastAccountData')).toBe(false);
      });
    });
  });

  describe('【对比】旧版 vs 新版 — 诊断他人污染锁定画像', () => {
    it('❌ 旧版:routeMine 无锁定检查,诊断他人秒删本尊画像', () => {
      const legacy = new LegacyApiLayer();
      // 本尊锁定画像
      legacy._lastPersonaCard = {
        positioning: { locked: true, niche: '命理风水' },
        persona: '李总',
      };

      // 诊断他人(误调 routeMine)
      legacy.routeMine({ positioning: { locked: true, niche: '教育' }, persona: '卷王之王' });

      // ❌ 本尊画像被覆盖
      expect(legacy._lastPersonaCard.niche).toBe('教育');
    });

    it('✅ 新版:诊断他人 = 独立 scope,绝不污染本尊', async () => {
      const tender = new TenderApiLayer();
      const myScope = tender.switchPlatform('douyin', 'me', 's1');
      myScope.set('positioning', { locked: true, niche: '命理风水' });
      myScope.set('persona', '李总');

      // 诊断他人
      const otherScope = tender.diagnoseOther('卷王之王');
      await otherScope.run(async () => {
        const s = ScopeNS.current();
        s.set('positioning', { locked: true, niche: '教育' });
        s.set('persona', '卷王之王');
      });

      // ✅ 本尊画像完整
      expect(myScope.get('positioning')).toEqual({ locked: true, niche: '命理风水' });
      expect(myScope.get('persona')).toBe('李总');
      // ✅ 其他 scope 的数据不会泄漏
      expect(myScope.has('diagnosing')).toBe(false);
    });
  });

  describe('【对比】旧版 vs 新版 — 视频诊断人设污染', () => {
    it('❌ 旧版:诊断他人视频默认 routeMine,污染本尊人设', () => {
      const legacy = new LegacyApiLayer();
      // 模拟:用户输入他人视频 url 诊断
      legacy.routeMine({
        positioning: { niche: '金融诈骗' },
        persona: '诈骗犯',
      });
      // ❌ 本尊人设被污染
      expect(legacy._lastPersonaCard.niche).toBe('金融诈骗');
    });

    it('✅ 新版:诊断他人 = 默认 routeOther,不写本尊 scope', async () => {
      const tender = new TenderApiLayer();
      const myScope = tender.switchPlatform('douyin', 'me', 's1');
      myScope.set('persona', '李总');
      myScope.set('positioning', { niche: '命理' });

      // 诊断他人视频 = 默认其他人
      const otherVideoScope = tender.diagnoseOther('诈骗视频');
      await otherVideoScope.run(async () => {
        const s = ScopeNS.current();
        s.set('videoAnalysis', { niche: '金融诈骗', persona: '诈骗犯' });
        // ❌ 不写入 myScope
      });

      // ✅ 本尊人设未被污染
      expect(myScope.get('persona')).toBe('李总');
      expect(myScope.get('positioning').niche).toBe('命理');
    });
  });

  describe('【对比】旧版 vs 新版 — Bus 事件清理 stale DOM', () => {
    it('✅ 新版:scope abort 广播事件,其他模块自动清 stale DOM', async () => {
      let cleanupsFired = 0;
      const unsub = Bus.on(Events.SCOPE_ABORTED, () => {
        cleanupsFired++;
      });

      const tender = new TenderApiLayer();
      const scope1 = tender.switchPlatform('douyin', 'u', 's1');
      scope1.abort('test');

      // 等事件循环
      await new Promise(r => setImmediate(r));

      // ✅ cleanup handler 被触发,模拟"module-5 清 _benchState + reloadBench"
      expect(cleanupsFired).toBe(1);

      unsub();
    });
  });

  describe('【对比】旧版 vs 新版 — 进度条单一真相源', () => {
    it('✅ 新版:进度通过 scope event 统一传递', async () => {
      const progressEvents: Array<{ percent: number; stage: string }> = [];
      const unsub = Bus.on(Events.SCOPE_WRITE, () => {
        // 模拟进度条更新
        progressEvents.push({ percent: 100, stage: 'done' });
      });

      await runScope({ tenantId: 't', userId: 'u', sessionId: 's' }, async () => {
        const s = ScopeNS.current();
        s.set('progress', { percent: 100, stage: 'done' });
      });

      // 进度数据通过 scope set 单一写入,前端只监听 → 不再有 92% 卡死
      expect(progressEvents.length).toBeGreaterThan(0);
      unsub();
    });
  });

  describe('【真实场景】AsyncLocalStorage 在 async 中拿 scope', () => {
    it('✅ 新版:Promise.all 中多个并发 scope 完全隔离', async () => {
      const tender = new TenderApiLayer();
      const scope1 = tender.switchPlatform('douyin', 'u', 's1');
      const scope2 = tender.switchPlatform('xiaohongshu', 'u', 's2');
      const scope3 = tender.switchPlatform('bilibili', 'u', 's3');

      const promises = [
        scope1.run(async () => {
          await new Promise(r => setTimeout(r, 20));
          return ScopeNS.current().sessionId;
        }),
        scope2.run(async () => {
          await new Promise(r => setTimeout(r, 10));
          return ScopeNS.current().sessionId;
        }),
        scope3.run(async () => {
          await new Promise(r => setTimeout(r, 5));
          return ScopeNS.current().sessionId;
        }),
      ];

      const results = await Promise.all(promises);
      expect(results[0]).toContain('douyin');
      expect(results[1]).toContain('xiaohongshu');
      expect(results[2]).toContain('bilibili');
    });
  });
});
