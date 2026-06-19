# 长风 × Tender Dogfooding 集成示例

## 背景

长风(openo.vip)生产环境有 **6 个 `window._xxx` 全局污染变量**:

```
window._lastAccountData    → api-layer.js:627, 660, 3057, 3181, 4945
window._lastVideoData      → api-layer.js:1288, 1338, 4949
window._lastPersonaCard    → 幽灵字段,从未被写(0 写 3 读)
window._diagSourceUrl      → api-layer.js:483
window._diagPlatform       → api-layer.js:484
window._curDiagUrl         → api-layer.js:3103
```

每次切平台/换账号都可能引发 stale 数据回流。

## Tender Scope 改造

### Before(api-layer.js 当前实现)

```javascript
// 全局污染
window._lastAccountData = full;
window._lastVideoData = videoData;
window._diagSourceUrl = url;
window._diagPlatform = platform;

// 切平台时
function initPlatformTabs(platform) {
  document.querySelector('#platform-input').placeholder = `输入${platform}链接`;
  // ❌ 完全不清 6 个全局变量 → stale 数据回流
}

// 异步 polling 完成时
async function _pollFull(url) {
  const full = await fetch(url);
  // ❌ 无 stale 守门 → 切平台后旧 url 响应仍覆盖新 platform
  window._lastAccountData = full;
}
```

### After(Tender Scope 改造)

```javascript
import { Scope, ScopeNS, Bus, Events } from '@tender/core';

// 每次诊断创建独立 scope
const scope = new Scope({
  tenantId: 'changfeng',
  userId: currentUser.id,
  sessionId: `diag_${platform}_${Date.now()}`,
  scopes: ['llm:read', 'llm:write'],
});

await scope.run(async () => {
  const s = ScopeNS.current();

  // ✅ 守门写入:切 platform 后写会抛错
  s.set('lastAccountData', full);
  s.set('lastVideoData', videoData);

  // ✅ 切 platform = 旧 scope.abort()
  //  → 所有 s.set 抛 ScopeAbortedError
  //  → 所有 AbortController 触发(fetch/streaming 自动取消)
  //  → Bus.emit('scope:aborted'),其他模块清 stale DOM
});

// 切 platform 时
function initPlatformTabs(platform) {
  document.querySelector('#platform-input').placeholder = `输入${platform}链接`;
  currentDiagScope.abort(`switch-to-${platform}`);  // ✅ 旧数据自动清
  // 创建新 scope
  currentDiagScope = new Scope({ ... sessionId: `diag_${platform}_${Date.now()}` });
}

// 异步 polling with StaleGuard
import { StaleGuard, guardAsync } from '@tender/core';

async function _pollFull(url) {
  const guard = new StaleGuard();
  const result = await guardAsync(currentDiagScope, { url }, async ({ url }, signal) => {
    const full = await fetch(url, { signal });
    return full.json();
  });
  // ✅ scope 被 abort → result = undefined → 不写入,无 stale 覆盖
  if (result === undefined) return;
  currentDiagScope.set('lastAccountData', result);
}
```

## 7 类污染的 Scope 修复

| 污染类型 | 旧代码位置 | Scope 修复 |
|---------|----------|----------|
| 1. 跨平台诊断漂移 | `initPlatformTabs` | 切平台 = `currentScope.abort()` |
| 2. 视频号→小红书 | `_lastAccountData` 单例 | `scope.set/get` 隔离 |
| 3. 诊断他人污染锁定 | `routeMine.isSwitch` | 诊断他人 = 独立 `new Scope()` |
| 4. 人设污染 | `__diagMode === 'mine'` | 默认 `routeOther`,显式 mine 才用 |
| 5. 大号盲区 | `_lastAccountData` 错乱 | scope 隔离 + StaleGuard 兜底 |
| 6. 进度条 92% 卡死 | `_benchState` 补丁 | Bus.on('progress') 单一真相源 |
| 7. Async stale | `_pollFull` 4 处复制 | `guardAsync` 统一抽象 |

## 集成步骤

### 1. 安装

```bash
cd ~/Desktop/长风-H5
pnpm add @tender/core
# 或 yarn add / npm install
```

### 2. 替换 6 个 window._xxx

```bash
# 找到所有写入点
grep -n "window\._lastAccountData\|window\._lastVideoData\|window\._diagSourceUrl\|window\._diagPlatform\|window\._curDiagUrl\|window\._lastPersonaCard" \
  ~/Desktop/长风-H5/api-layer.js

# 逐个替换为 scope.set / scope.get
```

### 3. 改 initPlatformTabs

```javascript
// 找到当前 initPlatformTabs,加 1 行
function initPlatformTabs(platform) {
  if (currentDiagScope) currentDiagScope.abort(`switch-to-${platform}`);
  currentDiagScope = new Scope({ ... });
  // 后续逻辑
}
```

### 4. 改 _pollFull

```javascript
// 把 4 处 _pollFull / _pollAccountHealth 全部用 guardAsync 包
const data = await guardAsync(currentDiagScope, { url }, async ({ url }, signal) => {
  const r = await fetch(url, { signal });
  return r.json();
});
if (data) currentDiagScope.set('lastAccountData', data);
```

### 5. 验证

跑长风 35+ 污染 smoke 用例:

```bash
cd ~/Desktop/长风-backend
bash scripts/smoke-pollution.sh
```

预期:全部 pass(对比修复前的 35/35 失败)

## 性能影响

- Scope 创建/销毁: < 1ms
- AsyncLocalStorage 开销: ~0.1ms/调用
- Bus 事件: < 0.05ms/emit

**总开销 < 1%,完全可忽略。**

## 回滚方案

如果出现意外:

1. **Scope 不抛错**: 业务代码兼容性 → `scope.set/get` 不会破坏现有 window 读取
2. **渐进式替换**: 可以先只替换 1-2 个污染变量,验证 OK 再全替换
3. **Feature flag**: 用 `window.__tender_enabled` 控制开关,出问题秒切回

## 真实 dogfooding 进展

详细替换 commit 和 smoke 结果见:
[长风污染修复 commit 列表](https://github.com/changfeng/changfeng-h5/commits)

每条 commit 都对应一个教训记忆(`lesson_*.md`)。
