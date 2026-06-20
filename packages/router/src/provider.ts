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
    yield* callAnthropicStream(config, req);
    return;
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

// ============================================
// Anthropic 流式 SSE 翻译 → OpenAI 兼容
// ============================================

/**
 * Anthropic Messages API SSE 流式调用
 *
 * Anthropic SSE 格式:
 *   event: message_start
 *   data: {"type":"message_start","message":{...}}
 *
 *   event: content_block_start
 *   data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
 *
 *   event: content_block_stop
 *   data: {"type":"content_block_stop","index":0}
 *
 *   event: message_delta
 *   data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}
 *
 *   event: message_stop
 *   data: {"type":"message_stop"}
 *
 *   event: ping  (跳过)
 *   event: error (翻译成 error chunk)
 *
 *   (可选 tool_use 流式)
 *   event: content_block_start (type=tool_use)
 *   event: content_block_delta (type=input_json_delta, partial_json 累积)
 *
 * 翻译成 OpenAI SSE 格式的 chunks
 */
export async function* callAnthropicStream(
  config: ProviderConfig,
  req: LLMRequest
): AsyncGenerator<OpenAIStreamChunk, void, void> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/v1/messages`;
  const model = req.model ?? config.defaultModel;

  // 提取 system message
  const system = req.messages.find(m => m.role === 'system');
  const nonSystem = req.messages.filter(m => m.role !== 'system');

  const body: Record<string, unknown> = {
    model,
    messages: nonSystem.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : (m.content as any),
    })),
    max_tokens: req.maxTokens ?? 4096,
    stream: true,
  };
  if (system && typeof system.content === 'string') body.system = system.content;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools) {
    body.tools = (req.tools as any[]).map(t => ({
      name: t.function?.name ?? t.name,
      description: t.function?.description ?? t.description,
      input_schema: t.function?.parameters ?? t.input_schema ?? { type: 'object' },
    }));
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': config.apiKey,
    'anthropic-version': '2023-06-01',
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

  // tool_use 流式累积:index → { id, name, inputJson }
  const toolAcc = new Map<number, { id: string; name: string; inputJson: string }>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Anthropic SSE:event 行 + data 行 + 空行
      // 用空行切分
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const ev of events) {
        const lines = ev.split('\n');
        let eventName = '';
        let dataLine = '';
        for (const line of lines) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;
        if (eventName === 'ping') continue;

        let payload: any;
        try {
          payload = JSON.parse(dataLine);
        } catch {
          continue;
        }

        const chunk = translateAnthropicEvent(eventName, payload, toolAcc);
        if (chunk) yield chunk;
      }
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

/**
 * 翻译单个 Anthropic SSE event → OpenAI chunk
 */
function translateAnthropicEvent(
  eventName: string,
  payload: any,
  toolAcc: Map<number, { id: string; name: string; inputJson: string }>
): OpenAIStreamChunk | null {
  switch (payload.type) {
    case 'message_start': {
      // emit role chunk
      return {
        id: payload.message?.id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: payload.message?.model,
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: '' },
          finish_reason: null,
        }],
      };
    }

    case 'content_block_start': {
      const block = payload.content_block;
      if (block?.type === 'text') {
        // text 块开始 → emit 空 content chunk(开启 content 流)
        return {
          choices: [{
            index: 0,
            delta: { content: '' },
            finish_reason: null,
          }],
        };
      }
      if (block?.type === 'tool_use') {
        // 累积 tool_use 信息
        toolAcc.set(payload.index, {
          id: block.id,
          name: block.name,
          inputJson: '',
        });
        return {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: payload.index,
                id: block.id,
                type: 'function',
                function: { name: block.name, arguments: '' },
              }],
            },
            finish_reason: null,
          }],
        };
      }
      return null;
    }

    case 'content_block_delta': {
      const delta = payload.delta;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        return {
          choices: [{
            index: 0,
            delta: { content: delta.text },
            finish_reason: null,
          }],
        };
      }
      if (delta?.type === 'input_json_delta') {
        const acc = toolAcc.get(payload.index);
        if (acc) {
          acc.inputJson += delta.partial_json ?? '';
          return {
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: payload.index,
                  function: { arguments: delta.partial_json ?? '' },
                }],
              },
              finish_reason: null,
            }],
          };
        }
      }
      return null;
    }

    case 'content_block_stop':
    case 'message_delta': {
      // message_delta 含 stop_reason + final usage
      if (payload.delta?.stop_reason) {
        return {
          choices: [{
            index: 0,
            delta: {},
            finish_reason: mapAnthropicStopReason(payload.delta.stop_reason),
          }],
        };
      }
      if (payload.usage) {
        return {
          choices: [{
            index: 0,
            delta: {},
            finish_reason: null,
          }],
          usage: {
            prompt_tokens: payload.usage.input_tokens ?? 0,
            completion_tokens: payload.usage.output_tokens ?? 0,
            total_tokens: (payload.usage.input_tokens ?? 0) + (payload.usage.output_tokens ?? 0),
          },
        };
      }
      return null;
    }

    case 'message_stop':
      // 终止标记 → caller 会写 [DONE]
      return null;

    case 'error':
      // Anthropic error event
      return {
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop',
        }],
      };

    default:
      return null;
  }
}

function mapAnthropicStopReason(reason: string | null): 'stop' | 'length' | 'tool_calls' | null {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return null;
  }
}

export type { CallResult };
