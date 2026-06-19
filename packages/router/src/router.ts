/**
 * Provider 路由器 — 主备链 + 失败自愈 + 并发控制
 *
 * 灵感来源:
 * - 长风 lib/ai.js L60-74 _aiAcquire/_aiRelease(并发信号量)
 * - 长风 lib/ai.js L44-57 _aiFailed Map(402/401 拉黑 10 分钟)
 * - smart-proxy _choose_provider(fail_streak 决策)
 *
 * 关键设计:
 * 1. 失败 provider 临时拉黑(避免空跑)
 * 2. 并发信号量防止打爆 provider
 * 3. 主备链按 priority 排序
 * 4. 所有尝试记录在 attempts[],便于诊断
 */

import { Bus, Events } from '@tender/core';
import type {
  LLMRequest,
  LLMResponse,
  ProviderConfig,
  ProviderName,
  ProviderFailType,
} from './types.js';
import { ProviderError } from './types.js';
import { callProvider } from './provider.js';

export interface RouterOptions {
  /** Provider 列表(按 priority 升序) */
  providers: ProviderConfig[];
  /** 全局并发上限,默认 20 */
  maxConcurrency?: number;
  /** 队列上限,默认 100 */
  maxQueue?: number;
  /** 失败拉黑时长(ms),默认 10 分钟(长风范式) */
  blockDurationMs?: number;
  /** 单次请求最长等待(ms),默认 75s */
  overallTimeoutMs?: number;
}

interface BlockedProvider {
  failType: ProviderFailType;
  blockedUntil: number;
}

/**
 * 全局路由器
 */
export class ProviderRouter {
  private readonly providers: ProviderConfig[];
  private readonly maxConcurrency: number;
  private readonly maxQueue: number;
  private readonly blockDurationMs: number;
  private readonly overallTimeoutMs: number;

  /** 失败拉黑:provider+failType → 解除时间 */
  private blocked = new Map<string, BlockedProvider>();
  /** 并发计数 */
  private inFlight = 0;
  /** 队列等待 */
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(opts: RouterOptions) {
    this.providers = [...opts.providers].sort((a, b) => a.priority - b.priority);
    this.maxConcurrency = opts.maxConcurrency ?? 20;
    this.maxQueue = opts.maxQueue ?? 100;
    this.blockDurationMs = opts.blockDurationMs ?? 10 * 60 * 1000;
    this.overallTimeoutMs = opts.overallTimeoutMs ?? 75_000;
  }

  /**
   * 路由一次请求
   *
   * @example
   * const router = new ProviderRouter({ providers: [deepseekCfg, siliconCfg] });
   * const resp = await router.route({
   *   messages: [{ role: 'user', content: 'hi' }],
   *   metadata: { tenantId: 't', userId: 'u' },
   * });
   */
  async route(req: LLMRequest): Promise<LLMResponse> {
    await this._acquire();

    const startTs = Date.now();
    const attempts: LLMResponse['attempts'] = [];
    const candidates = this._selectCandidates();

    if (candidates.length === 0) {
      this._release();
      throw new Error('No available provider (all blocked or disabled)');
    }

    let lastError: ProviderError | null = null;

    for (const provider of candidates) {
      const providerStart = Date.now();
      try {
        const result = await Promise.race([
          callProvider(provider, req),
          this._timeoutAfter(this.overallTimeoutMs, provider.name),
        ]);

        const latencyMs = Date.now() - providerStart;
        attempts.push({
          provider: provider.name,
          model: result.model,
          success: true,
          latencyMs,
        });

        this._release();
        return {
          id: `tender-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          model: result.model,
          provider: provider.name,
          content: result.content,
          toolCalls: result.toolCalls,
          finishReason: result.finishReason,
          usage: result.usage,
          latencyMs: Date.now() - startTs,
          attempts,
        };
      } catch (err) {
        const latencyMs = Date.now() - providerStart;
        if (err instanceof ProviderError) {
          lastError = err;
          attempts.push({
            provider: err.provider,
            model: req.model ?? provider.defaultModel,
            success: false,
            failType: err.failType,
            errorMsg: err.message,
            latencyMs,
          });

          if (err.isRetryable()) {
            this._markFailed(provider.name, err.failType);
            Bus.emit(Events.PROVIDER_FAILED, {
              provider: provider.name,
              failType: err.failType,
              latencyMs,
            });
            continue; // 试下一个
          }

          // 不可重试错误(4xx 其他),直接抛
          this._release();
          throw err;
        }

        // 非 ProviderError(意外错误)
        this._release();
        const e = err as Error;
        throw new Error(`Router unexpected error: ${e?.message ?? String(err)}`);
      }
    }

    this._release();
    throw new Error(
      `All ${candidates.length} providers failed. Last: ${lastError?.message ?? 'unknown'}`
    );
  }

  // ============ 内部方法 ============

  /**
   * 选择可用 candidates(过滤掉已 block 的)
   */
  private _selectCandidates(): ProviderConfig[] {
    const now = Date.now();
    return this.providers.filter(p => {
      if (!p.enabled) return false;
      if (!p.apiKey && p.name !== 'mock') return false;
      // 检查是否有任何 block
      let blocked = false;
      for (const [, info] of this.blocked) {
        if (info.blockedUntil > now) {
          // 需要对比 provider name,但 key 是 provider+failType,所以遍历检查
        }
      }
      // 更精确:对每个 (provider, failType) 检查
      for (const [key, info] of this.blocked) {
        if (key.startsWith(`${p.name}:`) && info.blockedUntil > now) {
          blocked = true;
          break;
        }
      }
      return !blocked;
    });
  }

  /**
   * 标记 provider 失败(临时拉黑)
   */
  private _markFailed(provider: ProviderName, failType: ProviderFailType): void {
    const key = `${provider}:${failType}`;
    const blockedUntil = Date.now() + this.blockDurationMs;
    this.blocked.set(key, { failType, blockedUntil });

    // 定时清理(避免 Map 无限增长)
    setTimeout(() => {
      const entry = this.blocked.get(key);
      if (entry && entry.blockedUntil <= Date.now()) {
        this.blocked.delete(key);
      }
    }, this.blockDurationMs + 1000);

    Bus.emit(Events.PROVIDER_FAILED, { provider, failType, blockedUntil });
  }

  /**
   * 获取阻塞状态(供监控/debug)
   */
  getBlockedProviders(): Array<{ provider: ProviderName; failType: ProviderFailType; blockedUntil: number }> {
    const now = Date.now();
    const result: Array<{ provider: ProviderName; failType: ProviderFailType; blockedUntil: number }> = [];
    for (const [key, info] of this.blocked) {
      if (info.blockedUntil > now) {
        const [provider, failType] = key.split(':') as [ProviderName, ProviderFailType];
        result.push({ provider, failType, blockedUntil: info.blockedUntil });
      }
    }
    return result;
  }

  /**
   * 强制解除 provider 阻塞(管理 API 用)
   */
  unblock(provider: ProviderName, failType?: ProviderFailType): number {
    let count = 0;
    for (const [key] of this.blocked) {
      if (key.startsWith(`${provider}:`) && (!failType || key === `${provider}:${failType}`)) {
        this.blocked.delete(key);
        count++;
      }
    }
    return count;
  }

  // ============ 并发信号量(长风 _aiAcquire 范式) ============

  private async _acquire(): Promise<void> {
    if (this.inFlight < this.maxConcurrency) {
      this.inFlight++;
      return;
    }
    if (this.queue.length >= this.maxQueue) {
      throw new Error(`Router queue full (${this.queue.length}/${this.maxQueue})`);
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  private _release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next.resolve();
    } else {
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  private async _timeoutAfter(ms: number, provider: ProviderName): Promise<never> {
    return new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new ProviderError(provider, 'timeout', null, `overall timeout ${ms}ms`, ms));
      }, ms);
    });
  }

  // ============ 监控 ============

  getStats() {
    return {
      inFlight: this.inFlight,
      queueLength: this.queue.length,
      blockedCount: this.getBlockedProviders().length,
      providerCount: this.providers.length,
    };
  }
}

/**
 * 工厂:从环境变量创建默认路由器(DS→SF→QWEN→MM)
 */
export function createDefaultRouter(opts?: Partial<RouterOptions>): ProviderRouter {
  const providers: ProviderConfig[] = [];

  const dsKey = process.env.TENDER_DEEPSEEK_API_KEY;
  if (dsKey) {
    providers.push({
      name: 'deepseek',
      baseUrl: process.env.TENDER_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
      apiKey: dsKey,
      models: ['deepseek-chat', 'deepseek-reasoner'],
      defaultModel: process.env.TENDER_DEEPSEEK_MODEL ?? 'deepseek-chat',
      enabled: true,
      protocol: 'openai',
      priority: 1,
    });
  }

  const sfKey = process.env.TENDER_SILICONFLOW_API_KEY;
  if (sfKey) {
    providers.push({
      name: 'siliconflow',
      baseUrl: process.env.TENDER_SILICONFLOW_BASE_URL ?? 'https://api.siliconflow.cn/v1',
      apiKey: sfKey,
      models: ['Qwen/Qwen2.5-7B-Instruct', 'Pro/Qwen/Qwen2-VL-7B-Instruct', 'sensevoice-1', 'BAAI/bge-m3'],
      defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
      enabled: true,
      protocol: 'openai',
      priority: 2,
    });
  }

  const qwenKey = process.env.TENDER_QWEN_API_KEY;
  if (qwenKey) {
    providers.push({
      name: 'qwen',
      baseUrl: process.env.TENDER_QWEN_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode',
      apiKey: qwenKey,
      models: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
      defaultModel: 'qwen-plus',
      enabled: true,
      protocol: 'openai',
      priority: 3,
    });
  }

  const minimaxKey = process.env.TENDER_MINIMAX_API_KEY;
  if (minimaxKey) {
    providers.push({
      name: 'minimax',
      baseUrl: process.env.TENDER_MINIMAX_BASE_URL ?? 'https://api.minimaxi.com/v1',
      apiKey: minimaxKey,
      models: ['MiniMax-Text-01', 'abab6.5s-chat'],
      defaultModel: 'MiniMax-Text-01',
      enabled: true,
      protocol: 'openai',
      priority: 4,
    });
  }

  if (providers.length === 0) {
    console.warn('[router] No providers configured. Set TENDER_DEEPSEEK_API_KEY etc.');
  }

  return new ProviderRouter({ providers, ...opts });
}
