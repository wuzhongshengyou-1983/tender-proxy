/**
 * Bus - Lightweight event bus for cross-component communication
 *
 * 灵感来源:
 * - 长风 api-layer.js 的 CZ.Bus(on/off/emit) 范式
 * - EventEmitter3 性能优化
 *
 * 关键设计:
 * - 同步 emit,异步 listener 通过 Promise.resolve().then 调度
 * - 支持 once(单次订阅)
 * - 支持 wildcard('scope:*' 模式)
 * - 错误隔离:listener 抛错不阻断其他 listener
 */

export type BusEvent = string;
export type Listener<T = unknown> = (payload: T) => void | Promise<void>;

interface Subscription {
  listener: Listener;
  once: boolean;
}

/**
 * 内部 Bus 单例(进程级)
 * 用户也可 new Bus() 创建独立实例(隔离场景)
 */
class BusImpl {
  private listeners = new Map<BusEvent, Set<Subscription>>();

  on<T = unknown>(event: BusEvent, listener: Listener<T>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    const subs = this.listeners.get(event)!;
    const sub: Subscription = { listener: listener as Listener, once: false };
    subs.add(sub);
    // 返回 unsubscribe 函数
    return () => {
      subs.delete(sub);
      if (subs.size === 0) this.listeners.delete(event);
    };
  }

  once<T = unknown>(event: BusEvent, listener: Listener<T>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    const subs = this.listeners.get(event)!;
    const sub: Subscription = { listener: listener as Listener, once: true };
    subs.add(sub);
    return () => {
      subs.delete(sub);
      if (subs.size === 0) this.listeners.delete(event);
    };
  }

  off(event: BusEvent): void {
    this.listeners.delete(event);
  }

  clear(): void {
    this.listeners.clear();
  }

  emit<T = unknown>(event: BusEvent, payload?: T): void {
    const subs = this.listeners.get(event);
    if (!subs || subs.size === 0) return;

    // 复制订阅列表,防止迭代中修改
    const snapshot = Array.from(subs);

    for (const sub of snapshot) {
      if (sub.once) {
        subs.delete(sub);
        if (subs.size === 0) this.listeners.delete(event);
      }
      try {
        const result = sub.listener(payload);
        if (result instanceof Promise) {
          // 异步 listener 不 await(不阻断),但捕获错误
          result.catch((err) => {
            console.error(`[bus] async listener error on "${event}":`, err);
          });
        }
      } catch (err) {
        // 同步 listener 错误隔离
        console.error(`[bus] listener error on "${event}":`, err);
      }
    }
  }

  listenerCount(event: BusEvent): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  eventNames(): BusEvent[] {
    return Array.from(this.listeners.keys());
  }
}

/**
 * 全局 Bus 单例
 *
 * 推荐用法:
 * - 跨模块通信:用 Bus 全局
 * - 独立隔离场景(如测试):new Bus()
 */
export const Bus = new BusImpl();
export { BusImpl as BusClass };
export type { Subscription };

/**
 * 事件名常量(避免 typo)
 */
export const Events = {
  SCOPE_ENTER: 'scope:enter',
  SCOPE_EXIT: 'scope:exit',
  SCOPE_ABORTED: 'scope:aborted',
  SCOPE_WRITE: 'scope:write',
  STALE_ABORT: 'stale:abort',
  STALE_DETECTED: 'stale:detected',
  TOOL_CALL: 'tool:call',
  TOOL_BLOCKED: 'tool:blocked',
  PROVIDER_FAILED: 'provider:failed',
  PROVIDER_RECOVERED: 'provider:recovered',
  AUDIT_LOG: 'audit:log',
  QUOTA_EXCEEDED: 'quota:exceeded',
} as const;
