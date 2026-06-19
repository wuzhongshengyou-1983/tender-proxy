/**
 * Router 类型定义
 *
 * 灵感来源: 长风 lib/ai.js 的 5 provider 主备链
 */

export type ProviderName = 'openai' | 'anthropic' | 'deepseek' | 'siliconflow' | 'qwen' | 'minimax' | 'mock';

export type ProviderFailType = '402' | '401' | '429' | '5xx' | 'timeout' | 'parse_error' | 'unknown';

export interface ProviderConfig {
  name: ProviderName;
  /** API base URL */
  baseUrl: string;
  /** API key(从环境变量读) */
  apiKey: string;
  /** 支持的模型列表 */
  models: string[];
  /** 默认模型 */
  defaultModel: string;
  /** 自定义 headers(可选) */
  headers?: Record<string, string>;
  /** 是否禁用 */
  enabled: boolean;
  /** 协议类型(openai 兼容 / anthropic 原生) */
  protocol: 'openai' | 'anthropic';
  /** 优先级(数字越小越靠前) */
  priority: number;
}

export interface LLMRequest {
  /** 模型(可选,空则用 provider 默认) */
  model?: string;
  /** OpenAI 格式消息数组(由 protocol 层处理) */
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | unknown;
    name?: string;
    tool_call_id?: string;
    tool_calls?: unknown[];
  }>;
  /** 温度 0-2 */
  temperature?: number;
  /** 最大 tokens */
  maxTokens?: number;
  /** 流式(暂不支持) */
  stream?: boolean;
  /** 工具 */
  tools?: unknown[];
  /** 工具选择策略 */
  toolChoice?: unknown;
  /** 调用方 metadata */
  metadata?: {
    tenantId?: string;
    userId?: string;
    sessionId?: string;
    scopeId?: string;
  };
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMResponse {
  id: string;
  model: string;
  provider: ProviderName;
  content: string;
  /** tool calls(若有) */
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error';
  usage: LLMUsage;
  /** 实际耗时 ms */
  latencyMs: number;
  /** 尝试了哪些 provider */
  attempts: Array<{
    provider: ProviderName;
    model: string;
    success: boolean;
    failType?: ProviderFailType;
    errorMsg?: string;
    latencyMs: number;
  }>;
}

export class ProviderError extends Error {
  constructor(
    public readonly provider: ProviderName,
    public readonly failType: ProviderFailType,
    public readonly statusCode: number | null,
    message: string,
    public readonly latencyMs: number
  ) {
    super(`[${provider}] ${failType}: ${message}`);
    this.name = 'ProviderError';
  }

  isRetryable(): boolean {
    return ['402', '401', '429', '5xx', 'timeout'].includes(this.failType);
  }
}
