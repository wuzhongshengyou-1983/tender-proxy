/**
 * StaleGuard - 异步操作 stale 守门(长风 api-layer.js 复制粘贴 4 次的统一抽象)
 *
 * 灵感来源:
 * - 长风 _pollFull / _pollAccountHealth 4 处复制粘贴的 url 守门(commit e58b5c1)
 * - React useEffect cleanup 模式
 * - Go context cancellation
 *
 * 核心创新:
 * 1. pin(key) 时拍快照,操作完成时 isStale(key) 一行判定
 * 2. 配合 Scope 的 AbortController,自动取消长任务
 * 3. Bus 事件订阅,stale 时自动广播(不再每个调用点复制)
 */

import { Bus, Events } from '../bus/index.js';
import type { Scope } from '../scope/index.js';

export interface StaleGuardOptions {
  /** 比较函数,默认 === 比较快照 */
  equals?: <T>(a: T, b: T) => boolean;
  /** stale 时是否触发 abort(默认 true) */
  abortOnStale?: boolean;
}

export interface PinResult<T> {
  /** 当前快照 */
  snapshot: T;
  /** 检查是否 stale,返回 true 表示应丢弃结果 */
  isStale: () => boolean;
  /** 标记 stale(主动触发) */
  markStale: (reason?: string) => void;
  /** stale 时调用,自动注册到 scope 的 abort 列表 */
  abort: () => void;
}

/**
 * StaleGuard 实例(可独立创建,或用全局单例)
 */
export class StaleGuard {
  private readonly equals: <T>(a: T, b: T) => boolean;
  private readonly abortOnStale: boolean;

  constructor(opts: StaleGuardOptions = {}) {
    this.equals = opts.equals ?? ((a, b) => a === b);
    this.abortOnStale = opts.abortOnStale ?? true;
  }

  /**
   * 在 scope 内拍快照
   *
   * @example
   * const guard = runScope.current().staleGuard();
   * const pin = guard.pin('userId', user.id);
   * const data = await fetchUser(pin.snapshot);
   * if (pin.isStale()) return;  // 用户已切换,丢弃结果
   */
  pin<T>(key: string, snapshot: T, scope?: Scope): PinResult<T> {
    let stale = false;
    let staleReason: string | null = null;

    const controller = scope ? scope.registerAbortController() : undefined;

    // 订阅 scope 的 abort
    let scopeUnsub: (() => void) | undefined;
    if (scope) {
      scopeUnsub = Bus.on(Events.SCOPE_ABORTED, (payload: unknown) => {
        const p = payload as { scope: { sessionId: string } };
        if (p.scope.sessionId === scope.sessionId) {
          markStale('scope-aborted');
        }
      });
    }

    function markStale(reason: string): void {
      if (stale) return;
      stale = true;
      staleReason = reason;
      if (controller && !controller.signal.aborted) {
        controller.abort(reason);
      }
      Bus.emit(Events.STALE_DETECTED, { key, snapshot, reason });
    }

    return {
      snapshot,
      isStale(): boolean {
        if (stale) return true;
        // 检查 scope 是否还活着
        if (scope?.isAborted()) {
          markStale('scope-aborted');
          return true;
        }
        return false;
      },
      markStale(reason?: string): void {
        markStale(reason ?? 'manual');
      },
      abort(): void {
        if (controller && !controller.signal.aborted) {
          controller.abort('explicit');
        }
        scopeUnsub?.();
      },
    } as PinResult<T> & { _reason: typeof staleReason };
  }

  /**
   * 检查两次快照是否一致(用于 callback/async polling)
   *
   * @example
   * const pin = guard.pin('url', currentUrl, scope);
   * await poll(async () => {
   *   const data = await fetch(currentUrl);
   *   if (pin.isStale()) return;  // url 已变,丢弃
   *   render(data);
   * });
   */
  diff<T>(current: T, pinned: T): boolean {
    return !this.equals(current, pinned);
  }
}

/**
 * 全局 StaleGuard 单例
 */
export const staleGuard = new StaleGuard();

/**
 * 辅助函数:在 scope 中跑一个异步函数,自动 stale 守门
 *
 * @example
 * const result = await guardAsync(scope, { url }, async (url) => {
 *   const res = await fetch(url);
 *   return res.json();
 * });
 * // 如果 scope 在 fetch 期间被 abort,这里自动返回 undefined
 */
export async function guardAsync<T, S>(
  scope: Scope,
  pinnedSnapshot: S,
  fn: (snapshot: S, signal: AbortSignal) => Promise<T>
): Promise<T | undefined> {
  const pin = staleGuard.pin('guardAsync', pinnedSnapshot, scope);
  try {
    return await fn(pinnedSnapshot, scope.registerAbortController().signal);
  } catch (err: unknown) {
    const e = err as { name?: string; code?: string };
    if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR') {
      return undefined;
    }
    if (pin.isStale()) {
      return undefined;
    }
    throw err;
  } finally {
    pin.abort();
  }
}
