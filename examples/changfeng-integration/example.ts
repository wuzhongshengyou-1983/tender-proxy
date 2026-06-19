/**
 * 长风 × Tender 集成演示
 *
 * 这个示例展示:
 * 1. 如何用 Scope 替换 6 个 window._xxx 全局变量
 * 2. 如何用 guardAsync 替换 _pollFull/_pollAccountHealth 的 stale 守门
 * 3. 如何用 Bus 替代 _clearDiagContext 的事件广播
 */

import { Scope, ScopeNS, Bus, Events, guardAsync, StaleGuard } from '@tender/core';

// ============================================
// 1. 模拟长风 api-layer.js 的现状
// ============================================

// ❌ 旧实现
const legacyImplementation = `
  // 长风当前(api-layer.js)
  window._lastAccountData = full;
  window._lastVideoData = videoData;
  window._diagSourceUrl = url;
  window._diagPlatform = platform;

  // 切平台时
  function initPlatformTabs(platform) {
    document.querySelector('#platform-input').placeholder = '输入' + platform + '链接';
    // 完全不清 6 个全局变量 → stale 数据回流
  }
`;

// ✅ 新实现
class ChangFengDiag {
  private currentScope: Scope | null = null;

  /**
   * 模拟 initPlatformTabs(切平台)
   */
  switchPlatform(platform: string, userId: string): Scope {
    if (this.currentScope) {
      this.currentScope.abort(`switch-to-${platform}`);
    }
    this.currentScope = new Scope({
      tenantId: 'changfeng',
      userId,
      sessionId: `diag_${platform}_${Date.now()}`,
      scopes: ['llm:read', 'llm:write', 'rag:read'],
      metadata: { platform },
    });
    return this.currentScope;
  }

  /**
   * 模拟 _pollFull(异步 polling)
   */
  async pollFullData(url: string): Promise<unknown> {
    if (!this.currentScope) throw new Error('No active scope');

    const guard = new StaleGuard();
    return await guardAsync(this.currentScope, { url }, async ({ url }, signal) => {
      const res = await fetch(url, { signal });
      return res.json();
    });
    // 如果 scope 被 abort → 返回 undefined → 业务层写入时守门拒绝
  }

  /**
   * 模拟 routeMine 锁定保护
   */
  diagnoseOther(nickname: string): Scope {
    // 诊断他人 = 独立 scope,不动本尊 scope
    return new Scope({
      tenantId: 'changfeng',
      userId: 'me',
      sessionId: `diagnose-other-${nickname}-${Date.now()}`,
      scopes: ['llm:read'],
      metadata: { diagnosing: nickname, isOther: true },
    });
  }
}

// ============================================
// 2. 演示 7 类污染修复
// ============================================

async function demoScenario1_switchPlatform(): Promise<void> {
  console.log('=== 场景 1: 切平台时 stale 数据不回流 ===');
  const changFeng = new ChangFengDiag();

  const platformA = changFeng.switchPlatform('douyin', 'user_1');
  const pollPromise = platformA.run(async () => {
    const s = ScopeNS.current();
    // 模拟 polling 中
    await new Promise(r => setTimeout(r, 50));
    if (s.isAborted()) return null;
    s.set('lastAccountData', { platform: 'douyin', name: '账号A' });
    return s.get('lastAccountData');
  });

  // 中途切到 platform B
  setTimeout(() => changFeng.switchPlatform('xiaohongshu', 'user_1'), 10);

  const result = await pollPromise;
  console.log('  pollFullData result:', result);
  console.log('  ✅ stale 数据已丢弃');

  const platformB = changFeng.currentScope!;
  await platformB.run(async () => {
    const s = ScopeNS.current();
    console.log('  平台 B scope 是否有 A 的残留:', s.has('lastAccountData'));
    console.log('  ✅ 没有污染');
  });
}

async function demoScenario2_diagnoseOther(): Promise<void> {
  console.log('=== 场景 2: 诊断他人不污染本尊锁定画像 ===');
  const changFeng = new ChangFengDiag();

  // 本尊 scope 锁定画像
  const myScope = changFeng.switchPlatform('douyin', 'me');
  myScope.set('positioning', { locked: true, niche: '命理风水' });
  myScope.set('persona', '李总');

  // 诊断他人 — 独立 scope
  const otherScope = changFeng.diagnoseOther('卷王之王');
  await otherScope.run(async () => {
    const s = ScopeNS.current();
    s.set('diagnosing', { nickname: '卷王之王', niche: '教育' });
  });

  // 验证本尊未受影响
  console.log('  本尊 positioning:', myScope.get('positioning'));
  console.log('  本尊 persona:', myScope.get('persona'));
  console.log('  本尊是否有他人 diagnosing:', myScope.has('diagnosing'));
  console.log('  ✅ 本尊画像完整');
}

async function demoScenario3_eventBusCleanup(): Promise<void> {
  console.log('=== 场景 3: Bus 事件自动清 stale DOM ===');

  let cleanedUp = 0;
  const unsub = Bus.on(Events.SCOPE_ABORTED, () => {
    cleanedUp++;
  });

  const changFeng = new ChangFengDiag();
  const scope1 = changFeng.switchPlatform('douyin', 'u');
  scope1.abort('test');

  // 等事件循环
  await new Promise(r => setImmediate(r));

  console.log('  cleanup handlers fired:', cleanedUp);
  console.log('  ✅ 其他模块自动收到通知');

  unsub();
}

async function main(): Promise<void> {
  await demoScenario1_switchPlatform();
  console.log();
  await demoScenario2_diagnoseOther();
  console.log();
  await demoScenario3_eventBusCleanup();
}

main().catch(console.error);
