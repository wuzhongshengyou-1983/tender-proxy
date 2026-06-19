/**
 * Scope - Per-session state guard (the heart of Tender)
 *
 * 灵感来源:
 * - Vercel AI SDK AbstractChat 每个实例独立 id + state(源码: github.com/vercel/ai)
 * - 长风 v8.7.2 _clearDiagContext + 事件总线(commit e58b5c1)
 * - LangGraph checkpoint_ns subgraph 隔离
 *
 * 核心创新:
 * 1. 强制 AsyncLocalStorage-based with-scope 模式
 * 2. abort 时所有挂在 scope 上的 AbortController 自动触发
 * 3. 切 scope 自动清旧 scope 状态(防 stale 数据回流)
 * 4. Bus 事件订阅模式让 stale 守门不再复制粘贴 4 次
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Bus, Events } from '../bus/index.js';

export class ScopeAbortedError extends Error {
  constructor(public readonly key: string, public readonly reason: string) {
    super(`Scope aborted: cannot set "${key}" (reason: ${reason})`);
    this.name = 'ScopeAbortedError';
  }
}

export class NoActiveScopeError extends Error {
  constructor() {
    super('No active scope - call Scope.enter() first or use Scope.run()');
    this.name = 'NoActiveScopeError';
  }
}

export interface ScopeOptions {
  tenantId: string;
  userId: string;
  sessionId: string;
  scopes?: string[];
  ttlMs?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Scope 实例 — 一次会话 = 一个 Scope
 *
 * 每个请求创建一个 Scope,通过 Scope.run() 或 Scope.enter()/exit()
 * 嵌套使用,类似 with-scope 模式。
 */
export class Scope {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly scopes: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly ttlMs: number;

  private _state = new Map<string, unknown>();
  private _abortControllers = new Set<AbortController>();
  private _aborted = false;
  private _abortedReason: string | null = null;
  private _lastActiveAt: number;

  constructor(opts: ScopeOptions) {
    if (!opts.tenantId || !opts.userId || !opts.sessionId) {
      throw new Error('Scope requires tenantId, userId, sessionId');
    }
    this.tenantId = opts.tenantId;
    this.userId = opts.userId;
    this.sessionId = opts.sessionId;
    this.scopes = Object.freeze([...(opts.scopes ?? [])]);
    this.metadata = Object.freeze({ ...(opts.metadata ?? {}) });
    this.createdAt = Date.now();
    this.ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000; // 默认 24h
    this._lastActiveAt = this.createdAt;

    Bus.emit(Events.SCOPE_ENTER, { scope: this.toDescriptor() });
  }

  // ============ 守门写入(关键创新) ============

  /**
   * 守门写入 — 切平台/换账号/异步 abort 时,旧写入会被拒绝
   *
   * @example
   * scope.set('lastVideoData', { ... });  // 正常
   * scope.abort('switch-platform');
   * scope.set('lastVideoData', { ... });  // throw ScopeAbortedError
   */
  set<T = unknown>(key: string, value: T): void {
    if (this._aborted) {
      throw new ScopeAbortedError(key, this._abortedReason ?? 'aborted');
    }
    this._state.set(key, value);
    this._lastActiveAt = Date.now();
    Bus.emit(Events.SCOPE_WRITE, {
      scope: this.toDescriptor(),
      key,
      // 不 emit value,避免循环引用和大对象
      hasValue: true,
    });
  }

  /**
   * 获取值(无守门)
   */
  get<T = unknown>(key: string): T | undefined {
    return this._state.get(key) as T | undefined;
  }

  /**
   * 是否存在
   */
  has(key: string): boolean {
    return this._state.has(key);
  }

  /**
   * 删除某个 key(不触发 abort,常用于业务清理)
   */
  delete(key: string): boolean {
    return this._state.delete(key);
  }

  // ============ AbortController 管理 ============

  /**
   * 注册一个 AbortController,scope abort 时自动触发
   *
   * @example
   * const controller = scope.registerAbortController();
   * fetch(url, { signal: controller.signal });
   * // 当 scope.abort() 被调用,fetch 自动取消
   */
  registerAbortController(controller?: AbortController): AbortController {
    if (this._aborted) {
      const c = controller ?? new AbortController();
      c.abort(this._abortedReason ?? 'scope-already-aborted');
      return c;
    }
    const c = controller ?? new AbortController();
    this._abortControllers.add(c);
    return c;
  }

  /**
   * 注销 AbortController(scope abort 不会触发它)
   */
  unregisterAbortController(controller: AbortController): void {
    this._abortControllers.delete(controller);
  }

  // ============ 切 scope(关键:自动清状态) ============

  /**
   * 终止 scope — 触发所有注册的 AbortController + 清状态 + 广播事件
   *
   * 切平台/换账号/退出登录/换链接时调用,杜绝 stale 数据回流
   *
   * @example
   * const scope1 = new Scope({ ... });
   * scope1.run(() => { ... });
   * scope1.abort('switch-platform');  // 旧数据自动清
   * const scope2 = new Scope({ ... });  // 新 scope,空白起步
   */
  abort(reason: string): void {
    if (this._aborted) return;
    this._aborted = true;
    this._abortedReason = reason;

    // 1. 触发所有 AbortController(让 fetch/streaming 取消)
    for (const c of this._abortControllers) {
      try {
        c.abort(reason);
      } catch (err) {
        console.error('[scope] AbortController.abort() failed:', err);
      }
    }
    this._abortControllers.clear();

    // 2. 清状态
    this._state.clear();

    // 3. 广播事件(让其他模块清 stale DOM/缓存)
    Bus.emit(Events.SCOPE_ABORTED, {
      scope: this.toDescriptor(),
      reason,
    });
  }

  /**
   * 是否已 abort
   */
  isAborted(): boolean {
    return this._aborted;
  }

  /**
   * 获取 abort 原因
   */
  abortedReason(): string | null {
    return this._abortedReason;
  }

  // ============ AsyncLocalStorage 集成 ============

  /**
   * 在 scope 上下文中运行 fn,支持 await/异步
   *
   * @example
   * await scope.run(async () => {
   *   const current = Scope.current();
   *   current.set('user', { id: 1 });
   *   await fetch(url);  // 异步中也能 Scope.current() 拿到同一个 scope
   * });
   */
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    return scopeStorage.run(this, async () => {
      try {
        return await fn();
      } finally {
        if (!this._aborted) {
          this.abort('run-completed');
        }
      }
    });
  }

  /**
   * 同步版 run(无需 await 时)
   */
  runSync<T>(fn: () => T): T {
    let result!: T;
    scopeStorage.run(this, () => {
      result = fn();
    });
    return result;
  }

  // ============ 元数据 ============

  /**
   * 最后活跃时间
   */
  lastActiveAt(): number {
    return this._lastActiveAt;
  }

  /**
   * 距离过期剩余毫秒
   */
  remainingTtlMs(): number {
    return Math.max(0, this.createdAt + this.ttlMs - Date.now());
  }

  /**
   * 是否过期
   */
  isExpired(): boolean {
    return this.remainingTtlMs() === 0;
  }

  /**
   * 序列化为可传输描述符
   */
  toDescriptor() {
    return {
      tenantId: this.tenantId,
      userId: this.userId,
      sessionId: this.sessionId,
      scopes: [...this.scopes],
      aborted: this._aborted,
      createdAt: this.createdAt,
    };
  }

  /**
   * 获取当前 state 快照(用于持久化/调试)
   */
  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this._state);
  }
}

// ============ AsyncLocalStorage — 让 async 也能拿到当前 scope ============

const scopeStorage = new AsyncLocalStorage<Scope>();

/**
 * Scope 命名空间(类方法,类似 Python's contextvars)
 */
export const ScopeNS = {
  /**
   * 获取当前活跃 scope
   * @throws NoActiveScopeError
   */
  current(): Scope {
    const scope = scopeStorage.getStore();
    if (!scope) throw new NoActiveScopeError();
    return scope;
  },

  /**
   * 尝试获取,返回 undefined 而非抛错
   */
  tryCurrent(): Scope | undefined {
    return scopeStorage.getStore();
  },

  /**
   * 进入 scope,返回 exit 函数
   */
  enter(scope: Scope): () => void {
    const prev = scopeStorage.getStore();
    scopeStorage.enterWith(scope);
    return () => {
      if (prev) {
        scopeStorage.enterWith(prev);
      } else {
        scopeStorage.enterWith(undefined as unknown as Scope);
      }
    };
  },

  /**
   * 在 scope 中运行 fn
   */
  async run<T>(scope: Scope, fn: () => Promise<T> | T): Promise<T> {
    return scope.run(fn);
  },
};

// ============ 工厂函数(常用入口) ============

/**
 * 快速创建并运行 scope
 *
 * @example
 * await runScope({ tenantId, userId, sessionId }, async () => {
 *   const scope = Scope.current();
 *   scope.set('foo', 'bar');
 * });
 */
export async function runScope<T>(
  opts: ScopeOptions,
  fn: () => Promise<T> | T
): Promise<T> {
  const scope = new Scope(opts);
  return scope.run(fn);
}

// ============ 类型导出 ============

export type { Subscription } from '../bus/index.js';
