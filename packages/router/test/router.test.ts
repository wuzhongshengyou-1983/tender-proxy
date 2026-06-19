import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ProviderRouter } from '../src/router.js';
import { ProviderError, type ProviderConfig, type LLMRequest } from '../src/types.js';
import { callProvider } from '../src/provider.js';

// ============ Mock provider config ============

const mockDeepseek: ProviderConfig = {
  name: 'deepseek',
  baseUrl: 'http://mock-deepseek',
  apiKey: 'sk-mock',
  models: ['deepseek-chat'],
  defaultModel: 'deepseek-chat',
  enabled: true,
  protocol: 'openai',
  priority: 1,
};

const mockSilicon: ProviderConfig = {
  name: 'siliconflow',
  baseUrl: 'http://mock-sf',
  apiKey: 'sk-mock-sf',
  models: ['Qwen/Qwen2.5-7B-Instruct'],
  defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
  enabled: true,
  protocol: 'openai',
  priority: 2,
};

const mockQwen: ProviderConfig = {
  name: 'qwen',
  baseUrl: 'http://mock-qwen',
  apiKey: 'sk-mock-qwen',
  models: ['qwen-plus'],
  defaultModel: 'qwen-plus',
  enabled: true,
  protocol: 'openai',
  priority: 3,
};

// ============ Mock fetch ============

function mockFetchSequence(responses: Array<{ ok: boolean; status?: number; body?: unknown; delay?: number }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const r = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    if (r.delay) await new Promise(res => setTimeout(res, r.delay));
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.body,
      text: async () => JSON.stringify(r.body ?? {}),
    } as Response;
  });
}

describe('ProviderRouter — 主备链 fallback', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('首选 provider 成功时,直接返回', async () => {
    globalThis.fetch = mockFetchSequence([{
      ok: true,
      body: {
        id: 'chatcmpl-1',
        choices: [{
          message: { role: 'assistant', content: 'Hello from DeepSeek' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    }]);

    const router = new ProviderRouter({ providers: [mockDeepseek, mockSilicon, mockQwen] });
    const resp = await router.route({
      messages: [{ role: 'user', content: 'hi' }],
      metadata: { tenantId: 't', userId: 'u' },
    });

    expect(resp.provider).toBe('deepseek');
    expect(resp.content).toBe('Hello from DeepSeek');
    expect(resp.attempts).toHaveLength(1);
    expect(resp.attempts[0].success).toBe(true);
  });

  it('首选 402 → 自动 fallback 到 SiliconFlow', async () => {
    globalThis.fetch = mockFetchSequence([
      { ok: false, status: 402, body: { error: 'insufficient balance' } },
      { ok: true, body: {
        id: 'chatcmpl-2',
        choices: [{
          message: { role: 'assistant', content: 'Hi from SF' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }},
    ]);

    const router = new ProviderRouter({ providers: [mockDeepseek, mockSilicon] });
    const resp = await router.route({ messages: [{ role: 'user', content: 'hi' }] });

    expect(resp.provider).toBe('siliconflow');
    expect(resp.content).toBe('Hi from SF');
    expect(resp.attempts).toHaveLength(2);
    expect(resp.attempts[0].success).toBe(false);
    expect(resp.attempts[0].failType).toBe('402');
    expect(resp.attempts[1].success).toBe(true);
  });

  it('全部 provider 失败抛错', async () => {
    globalThis.fetch = mockFetchSequence([
      { ok: false, status: 402, body: {} },
      { ok: false, status: 429, body: {} },
      { ok: false, status: 500, body: {} },
    ]);

    const router = new ProviderRouter({ providers: [mockDeepseek, mockSilicon, mockQwen] });
    await expect(router.route({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow(/All 3 providers failed/);
  });

  it('失败 provider 临时拉黑 10 分钟', async () => {
    globalThis.fetch = mockFetchSequence([
      { ok: false, status: 402, body: {} },                              // 第 1 次 route: DS 402
      { ok: true, body: { id: '1', choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } },  // 第 1 次 route: SF ok
      { ok: true, body: { id: '2', choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } },  // 第 2 次 route: DS 拉黑跳过,SF ok
    ]);

    const router = new ProviderRouter({ providers: [mockDeepseek, mockSilicon], blockDurationMs: 60_000 });
    // 第一次:DS 失败 → 走 SF
    await router.route({ messages: [{ role: 'user', content: '1' }] });
    // 第二次:DS 应被跳过,直接走 SF
    const resp2 = await router.route({ messages: [{ role: 'user', content: '2' }] });
    expect(resp2.attempts).toHaveLength(1);
    expect(resp2.attempts[0].provider).toBe('siliconflow');
  });

  it('并发控制:maxConcurrency=1 时,第二个请求排队', async () => {
    let inflight = 0;
    let maxInflight = 0;
    globalThis.fetch = vi.fn(async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise(r => setTimeout(r, 50));
      inflight--;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: '1',
          choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
        text: async () => '{}',
      } as Response;
    });

    const router = new ProviderRouter({ providers: [mockDeepseek], maxConcurrency: 1 });
    await Promise.all([
      router.route({ messages: [{ role: 'user', content: 'a' }] }),
      router.route({ messages: [{ role: 'user', content: 'b' }] }),
    ]);
    expect(maxInflight).toBe(1);
  });

  it('queue 满时直接拒绝', async () => {
    globalThis.fetch = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 100));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: '1',
          choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
        text: async () => '{}',
      } as Response;
    });

    const router = new ProviderRouter({
      providers: [mockDeepseek],
      maxConcurrency: 1,
      maxQueue: 1,
    });
    const promises = [
      router.route({ messages: [{ role: 'user', content: 'a' }] }),
      router.route({ messages: [{ role: 'user', content: 'b' }] }),
      router.route({ messages: [{ role: 'user', content: 'c' }] }),
    ];
    await expect(Promise.all(promises)).rejects.toThrow(/queue full/);
  });

  it('disabled provider 被跳过', async () => {
    globalThis.fetch = vi.fn();
    const router = new ProviderRouter({
      providers: [{ ...mockDeepseek, enabled: false }, mockSilicon],
    });
    globalThis.fetch = mockFetchSequence([{
      ok: true,
      body: { id: '1', choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
    }]);
    const resp = await router.route({ messages: [{ role: 'user', content: 'hi' }] });
    expect(resp.provider).toBe('siliconflow');
  });

  it('优先级:priority 小的先试', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      const u = url as string;
      if (u.includes('mock-deepseek')) {
        calls.push('deepseek');
        return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as Response;
      }
      if (u.includes('mock-qwen')) {
        calls.push('qwen');
        return { ok: true, status: 200, json: async () => ({ id: '1', choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }), text: async () => '' } as Response;
      }
      return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as Response;
    });

    // 故意给 qwen 更小 priority
    const router = new ProviderRouter({
      providers: [
        { ...mockQwen, priority: 1 },
        { ...mockSilicon, priority: 2 },
        { ...mockDeepseek, priority: 3 },
      ],
    });
    const resp = await router.route({ messages: [{ role: 'user', content: 'hi' }] });
    expect(resp.provider).toBe('qwen');
    expect(calls[0]).toBe('qwen');
  });

  it('getStats 返回实时状态', async () => {
    const router = new ProviderRouter({ providers: [mockDeepseek] });
    const stats = router.getStats();
    expect(stats.providerCount).toBe(1);
    expect(stats.inFlight).toBe(0);
    expect(stats.blockedCount).toBe(0);
  });

  it('unblock 强制解除拉黑', async () => {
    globalThis.fetch = mockFetchSequence([
      { ok: false, status: 402, body: {} },                              // 第 1 次 route: DS 402
      { ok: true, body: { id: '1', choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } },  // 第 1 次 route: SF ok
      { ok: true, body: { id: '2', choices: [{ message: { role: 'assistant', content: 'OK2' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } },  // 第 2 次 route: SF ok(unblock 后)
    ]);

    const router = new ProviderRouter({ providers: [mockDeepseek, mockSilicon], blockDurationMs: 60_000 });
    await router.route({ messages: [{ role: 'user', content: '1' }] });
    expect(router.getBlockedProviders().length).toBe(1);

    const unblocked = router.unblock('deepseek');
    expect(unblocked).toBe(1);
    expect(router.getBlockedProviders().length).toBe(0);
  });
});

describe('ProviderError', () => {
  it('isRetryable 正确分类', () => {
    expect(new ProviderError('a', '402', 402, '', 0).isRetryable()).toBe(true);
    expect(new ProviderError('a', '401', 401, '', 0).isRetryable()).toBe(true);
    expect(new ProviderError('a', '429', 429, '', 0).isRetryable()).toBe(true);
    expect(new ProviderError('a', '5xx', 500, '', 0).isRetryable()).toBe(true);
    expect(new ProviderError('a', 'timeout', null, '', 0).isRetryable()).toBe(true);
    expect(new ProviderError('a', 'parse_error', 200, '', 0).isRetryable()).toBe(false);
    expect(new ProviderError('a', 'unknown', 0, '', 0).isRetryable()).toBe(false);
  });
});
