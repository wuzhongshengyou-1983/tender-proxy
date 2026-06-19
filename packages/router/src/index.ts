/**
 * @tender/router — Provider 主备链 fallback
 *
 * 灵感来源:
 * - 长风 lib/ai.js(5 provider + _aiFailed Map 拉黑 + 并发信号量 + 超时按 token 缩放)
 * - smart-proxy _choose_provider(fail_streak 决策)
 */

export type {
  ProviderName,
  ProviderFailType,
  ProviderConfig,
  LLMRequest,
  LLMResponse,
  LLMUsage,
} from './types.js';
export { ProviderError } from './types.js';

export { callProvider, createMockProvider, type CallResult } from './provider.js';
export { ProviderRouter, createDefaultRouter, type RouterOptions } from './router.js';
