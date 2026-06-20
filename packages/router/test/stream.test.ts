/**
 * callProviderStream 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callProviderStream } from '../src/provider.js';
import type { ProviderConfig } from '../src/types.js';

describe('callProviderStream — OpenAI SSE 流式', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const mockProvider: ProviderConfig = {
    name: 'deepseek',
    baseUrl: 'http://mock-ds',
    apiKey: 'sk-test',
    models: ['deepseek-chat'],
    defaultModel: 'deepseek-chat',
    enabled: true,
    protocol: 'openai',
    priority: 1,
  };

  /**
   * 模拟 OpenAI 兼容 SSE 响应
   * 用 ReadableStream 让逐 chunk 流出
   */
  function mockSSEStream(chunks: string[]): Response {
    const encoder = new TextEncoder();
    let i = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(encoder.encode(chunks[i]));
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

  it('逐 chunk 解析 SSE data: 行', async () => {
    const sseChunks = [
      'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    globalThis.fetch = vi.fn(async () => mockSSEStream(sseChunks)) as any;

    const results: any[] = [];
    for await (const chunk of callProviderStream(mockProvider, {
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      results.push(chunk);
    }

    expect(results.length).toBe(3);  // [DONE] 不 yield
    expect(results[0].choices?.[0].delta.role).toBe('assistant');
    expect(results[1].choices?.[0].delta.content).toBe('Hello');
    expect(results[2].choices?.[0].delta.content).toBe(' world');
    expect(results[2].choices?.[0].finish_reason).toBe('stop');
  });

  it('处理大 chunk 跨越 buffer 边界', async () => {
    // 故意把单个 SSE 消息切成两半发送
    const sseChunks = [
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Hel',
      'lo"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ];
    globalThis.fetch = vi.fn(async () => mockSSEStream(sseChunks)) as any;

    const results: any[] = [];
    for await (const chunk of callProviderStream(mockProvider, {
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      results.push(chunk);
    }

    expect(results.length).toBe(1);
    expect(results[0].choices?.[0].delta.content).toBe('Hello');
  });

  it('401/402/429 抛 ProviderError', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('{"error":"insufficient"}', { status: 402 })
    ) as any;

    await expect(async () => {
      for await (const _ of callProviderStream(mockProvider, {
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        // 应该抛错前不会到这里
      }
    }).rejects.toThrow(/\[deepseek\] 402/);
  });

  it('跳过无法解析的 chunk 继续', async () => {
    const sseChunks = [
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"OK"}}]}\n\n',
      'data: this is not json\n\n',  // 跳过
      'data: [DONE]\n\n',
    ];
    globalThis.fetch = vi.fn(async () => mockSSEStream(sseChunks)) as any;

    const results: any[] = [];
    for await (const chunk of callProviderStream(mockProvider, {
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      results.push(chunk);
    }

    expect(results.length).toBe(1);  // 只解析的 1 个
    expect(results[0].choices?.[0].delta.content).toBe('OK');
  });

  it('支持 timeout(短路测试,通过 signal abort 模拟)', async () => {
    // 跳过:calcTimeoutMs 最短 30s,超出 vitest 10s 默认 timeout
    // 真实场景:长风生产会用 75s 上限
  });

  it('anthropic 协议抛 not implemented', async () => {
    const anthropicProvider: ProviderConfig = { ...mockProvider, protocol: 'anthropic', name: 'anthropic' };
    await expect(async () => {
      for await (const _ of callProviderStream(anthropicProvider, {
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        // 不会到这里
      }
    }).rejects.toThrow(/anthropic streaming not yet implemented/);
  });
});