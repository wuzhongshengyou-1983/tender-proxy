/**
 * Anthropic 流式 SSE 翻译测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callProviderStream, type OpenAIStreamChunk } from '../src/provider.js';
import type { ProviderConfig } from '../src/types.js';

describe('callProviderStream — Anthropic SSE', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const mockAnthropicProvider: ProviderConfig = {
    name: 'anthropic',
    baseUrl: 'http://mock-anthropic',
    apiKey: 'sk-ant-test',
    models: ['claude-sonnet-4-5'],
    defaultModel: 'claude-sonnet-4-5',
    enabled: true,
    protocol: 'anthropic',
    priority: 1,
  };

  function mockSSEResponse(events: string[]): Response {
    const encoder = new TextEncoder();
    let i = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (i < events.length) {
          controller.enqueue(encoder.encode(events[i]));
          i++;
        } else {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  it('翻译 message_start + content_block_delta + message_stop 为 OpenAI 流', async () => {
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01","model":"claude-sonnet-4-5","role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    globalThis.fetch = vi.fn(async () => mockSSEResponse(events)) as any;

    const chunks: OpenAIStreamChunk[] = [];
    for await (const chunk of callProviderStream(mockAnthropicProvider, {
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThanOrEqual(4);

    // 1. message_start → role chunk
    expect(chunks[0].choices?.[0].delta.role).toBe('assistant');
    expect(chunks[0].id).toBe('msg_01');
    expect(chunks[0].model).toBe('claude-sonnet-4-5');

    // 2. content_block_start (text) → 空 content chunk
    expect(chunks[1].choices?.[0].delta.content).toBe('');

    // 3. content_block_delta text → "Hello"
    expect(chunks[2].choices?.[0].delta.content).toBe('Hello');

    // 4. content_block_delta text → " world"
    expect(chunks[3].choices?.[0].delta.content).toBe(' world');

    // 5. message_delta (stop_reason=end_turn) → finish_reason=stop
    const stopChunk = chunks.find(c => c.choices?.[0].finish_reason === 'stop');
    expect(stopChunk).toBeDefined();

    // 6. message_stop 不 yield chunk
    // 7. message_delta 末尾的 usage chunk(如果单独 emit)
    // 测试至少包含 4 个 chunk
  });

  it('跳过 ping event', async () => {
    const events = [
      'event: ping\ndata: {"type":"ping"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    globalThis.fetch = vi.fn(async () => mockSSEResponse(events)) as any;

    const chunks: OpenAIStreamChunk[] = [];
    for await (const chunk of callProviderStream(mockAnthropicProvider, {
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(1);
    expect(chunks[0].choices?.[0].delta.content).toBe('OK');
  });

  it('tool_use 流式(input_json_delta 累积)', async () => {
    const events = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"get_weather","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"Beijing\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    globalThis.fetch = vi.fn(async () => mockSSEResponse(events)) as any;

    const chunks: OpenAIStreamChunk[] = [];
    for await (const chunk of callProviderStream(mockAnthropicProvider, {
      messages: [{ role: 'user', content: 'weather' }],
    })) {
      chunks.push(chunk);
    }

    // 至少 3 chunks:tool_use start + 2 input_json_delta
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    // 第一个 tool chunk 应有 id + name
    const firstToolChunk = chunks.find(c => c.choices?.[0].delta.tool_calls?.[0]?.id === 'toolu_01');
    expect(firstToolChunk).toBeDefined();
    expect(firstToolChunk?.choices?.[0].delta.tool_calls?.[0].function?.name).toBe('get_weather');

    // finish_reason 应是 tool_calls
    const finishChunk = chunks.find(c => c.choices?.[0].finish_reason === 'tool_calls');
    expect(finishChunk).toBeDefined();
  });

  it('处理 max_tokens 截断', async () => {
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","model":"claude-sonnet-4-5"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n',
    ];
    globalThis.fetch = vi.fn(async () => mockSSEResponse(events)) as any;

    const chunks: OpenAIStreamChunk[] = [];
    for await (const chunk of callProviderStream(mockAnthropicProvider, {
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(chunk);
    }

    const stopChunk = chunks.find(c => c.choices?.[0].finish_reason === 'length');
    expect(stopChunk).toBeDefined();
  });

  it('anthropic 401 抛 ProviderError', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('{"error":"invalid api key"}', { status: 401 })
    ) as any;

    await expect(async () => {
      for await (const _ of callProviderStream(mockAnthropicProvider, {
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        // 不会到这里
      }
    }).rejects.toThrow(/\[anthropic\] 401/);
  });
});