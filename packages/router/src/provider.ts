/**
 * Provider HTTP 调用层
 *
 * 负责:把 LLMRequest 转为各 provider 的 HTTP 请求,返回 LLMResponse 或抛 ProviderError
 *
 * 关键设计:
 * - 每个 provider 一个函数,统一签名
 * - 不依赖第三方 LLM 库(直接用 fetch)
 * - 超时按 token 预算缩放(长风 lib/ai.js 范式)
 */

import type { LLMRequest, LLMResponse, ProviderName, ProviderConfig } from './types.js';
import { ProviderError } from './types.js';

interface CallResult {
  content: string;
  toolCalls?: LLMResponse['toolCalls'];
  usage: LLMResponse['usage'];
  finishReason: LLMResponse['finishReason'];
  model: string;
}

/**
 * 计算超时(按 maxTokens 缩放)
 *
 * 长风 lib/ai.js L155 公式: timeout = min(75s, 30s + maxTokens*14/1000)
 */
function calcTimeoutMs(maxTokens: number | undefined): number {
  const tokens = maxTokens ?? 2000;
  return Math.min(75_000, 30_000 + tokens * 14);
}

async function callOpenAICompatible(
  config: ProviderConfig,
  req: LLMRequest
): Promise<CallResult> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const model = req.model ?? config.defaultModel;

  const body: Record<string, unknown> = {
    model,
    messages: req.messages,
    stream: false,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.tools) body.tools = req.tools;
  if (req.toolChoice) body.tool_choice = req.toolChoice;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
    ...config.headers,
  };

  const controller = new AbortController();
  const timeoutMs = calcTimeoutMs(req.maxTokens);
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    const e = err as { name?: string; message?: string };
    if (e.name === 'AbortError') {
      throw new ProviderError(config.name, 'timeout', null, `timeout after ${timeoutMs}ms`, timeoutMs);
    }
    throw new ProviderError(config.name, 'unknown', null, e.message ?? 'fetch failed', 0);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const failType = mapStatusToFailType(res.status);
    const text = await res.text().catch(() => '');
    throw new ProviderError(config.name, failType, res.status, text.slice(0, 200), 0);
  }

  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    throw new ProviderError(config.name, 'parse_error', res.status, 'invalid JSON response', 0);
  }

  const choices = data.choices as Array<{
    message: { role: string; content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
    finish_reason: string;
  }> | undefined;

  if (!choices || choices.length === 0) {
    throw new ProviderError(config.name, 'parse_error', res.status, 'no choices', 0);
  }

  const choice = choices[0];
  const usage = (data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }) as {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };

  const toolCalls = choice.message.tool_calls?.map(tc => {
    try {
      return {
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>,
      };
    } catch {
      return { id: tc.id, name: tc.function.name, arguments: {} as Record<string, unknown> };
    }
  });

  return {
    content: choice.message.content ?? '',
    toolCalls,
    usage: {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    },
    finishReason: mapFinishReason(choice.finish_reason),
    model,
  };
}

async function callAnthropic(
  config: ProviderConfig,
  req: LLMRequest
): Promise<CallResult> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/v1/messages`;
  const model = req.model ?? config.defaultModel;

  // 提取 system message
  const system = req.messages.find(m => m.role === 'system');
  const nonSystem = req.messages.filter(m => m.role !== 'system');

  const body: Record<string, unknown> = {
    model,
    messages: nonSystem,
    max_tokens: req.maxTokens ?? 4096,
  };
  if (system && typeof system.content === 'string') body.system = system.content;
  if (req.temperature !== undefined) body.temperature = req.temperature;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': config.apiKey,
    'anthropic-version': '2023-06-01',
    ...config.headers,
  };

  const controller = new AbortController();
  const timeoutMs = calcTimeoutMs(req.maxTokens);
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    const e = err as { name?: string; message?: string };
    if (e.name === 'AbortError') {
      throw new ProviderError(config.name, 'timeout', null, `timeout after ${timeoutMs}ms`, timeoutMs);
    }
    throw new ProviderError(config.name, 'unknown', null, e.message ?? 'fetch failed', 0);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const failType = mapStatusToFailType(res.status);
    const text = await res.text().catch(() => '');
    throw new ProviderError(config.name, failType, res.status, text.slice(0, 200), 0);
  }

  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new ProviderError(config.name, 'parse_error', res.status, 'invalid JSON response', 0);
  }

  const content = data.content as Array<{ type: string; text?: string }> | undefined;
  if (!content) throw new ProviderError(config.name, 'parse_error', res.status, 'no content', 0);

  const text = content.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
  const usage = (data.usage ?? { input_tokens: 0, output_tokens: 0 }) as {
    input_tokens: number;
    output_tokens: number;
  };

  return {
    content: text,
    usage: {
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      totalTokens: usage.input_tokens + usage.output_tokens,
    },
    finishReason: data.stop_reason === 'max_tokens' ? 'length' : 'stop',
    model,
  };
}

export async function callProvider(
  config: ProviderConfig,
  req: LLMRequest
): Promise<CallResult> {
  if (config.protocol === 'anthropic') {
    return callAnthropic(config, req);
  }
  return callOpenAICompatible(config, req);
}

// ============================================
// 流式调用(OpenAI 兼容 SSE)
// ============================================

/**
 * OpenAI 兼容 provider 的流式调用
 *
 * 返回 AsyncIterable<OpenAIStreamChunk>,每个 chunk 是 OpenAI SSE 一行解析后的对象
 *
 * 调用方负责把 chunk 序列化成 SSE 格式输出给客户端
 *
 * 调用完成时,自动累加 usage(从最后一个 usage 字段抓)
 */
export async function* callProviderStream(
  config: ProviderConfig,
  req: LLMRequest
): AsyncGenerator<OpenAIStreamChunk, void, void> {
  if (config.protocol === 'anthropic') {
    // v1.0.1 实现:Anthropic 协议翻译
    throw new ProviderError(config.name, 'unknown', null, 'anthropic streaming not yet implemented', 0);
  }

  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const model = req.model ?? config.defaultModel;

  const body: Record<string, unknown> = {
    model,
    messages: req.messages,
    stream: true,  // 强制流式
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.tools) body.tools = req.tools;
  if (req.toolChoice) body.tool_choice = req.toolChoice;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
    Accept: 'text/event-stream',
    ...config.headers,
  };

  const controller = new AbortController();
  const timeoutMs = calcTimeoutMs(req.maxTokens);
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    const e = err as { name?: string; message?: string };
    if (e.name === 'AbortError') {
      throw new ProviderError(config.name, 'timeout', null, `timeout after ${timeoutMs}ms`, timeoutMs);
    }
    throw new ProviderError(config.name, 'unknown', null, e.message ?? 'fetch failed', 0);
  }

  if (!res.ok) {
    clearTimeout(timer);
    const failType = mapStatusToFailType(res.status);
    const text = await res.text().catch(() => '');
    throw new ProviderError(config.name, failType, res.status, text.slice(0, 200), 0);
  }

  if (!res.body) {
    clearTimeout(timer);
    throw new ProviderError(config.name, 'parse_error', res.status, 'no response body', 0);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 格式:data: {json}\n\n
      // 切分行
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';  // 最后一行可能不完整

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === 'data: [DONE]') {
          // OpenAI 流结束标记
          return;
        }
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        try {
          const chunk = JSON.parse(data) as OpenAIStreamChunk;
          yield chunk;
        } catch {
          // 跳过无法解析的 chunk
          continue;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

/**
 * OpenAI SSE chunk 类型(只声明我们用到的字段)
 */
export interface OpenAIStreamChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

function mapStatusToFailType(status: number): ProviderError['failType'] {
  if (status === 402) return '402';
  if (status === 401 || status === 403) return '401';
  if (status === 429) return '429';
  if (status >= 500 && status < 600) return '5xx';
  return 'unknown';
}

function mapFinishReason(reason: string): LLMResponse['finishReason'] {
  switch (reason) {
    case 'stop':
    case 'end_turn':
      return 'stop';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'error';
  }
}

/**
 * 创建 Mock provider(测试用,不发起真实 HTTP)
 */
export function createMockProvider(
  config: Partial<ProviderConfig> & { name: ProviderName; failType?: ProviderError['failType']; response?: CallResult }
): ProviderConfig {
  return {
    name: config.name,
    baseUrl: 'http://mock',
    apiKey: 'mock-key',
    models: config.models ?? ['mock-model'],
    defaultModel: config.defaultModel ?? 'mock-model',
    enabled: true,
    protocol: 'openai',
    priority: config.priority ?? 0,
  };
}

export type { CallResult };
