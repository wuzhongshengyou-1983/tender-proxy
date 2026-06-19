/**
 * @tender/core — Tender 平台核心抽象层
 *
 * 这是平台心脏,沉淀长风 7 类 context pollution 的修复范式:
 * 1. Scope 守门(切平台/换账号自动清状态)
 * 2. StaleGuard 异步守门(杜绝 stale 数据回流)
 * 3. Bus 事件总线(让 stale 守门不再复制粘贴)
 *
 * 设计哲学:
 * - 默认隔离 > 默认共享
 * - 守门写入 > 信任调用方
 * - 显式状态 > 隐式全局态
 */

// ============ 事件总线 ============
export {
  Bus,
  BusClass,
  Events,
  type BusEvent,
  type Listener,
  type Subscription,
} from './bus/index.js';

// ============ Scope 守门 ============
export {
  Scope,
  ScopeNS,
  runScope,
  ScopeAbortedError,
  NoActiveScopeError,
  type ScopeOptions,
} from './scope/index.js';

// ============ StaleGuard 异步守门 ============
export {
  StaleGuard,
  staleGuard,
  guardAsync,
  type StaleGuardOptions,
  type PinResult,
} from './stale-guard/index.js';
