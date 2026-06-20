/**
 * /v1/messages — Anthropic 兼容端点
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Scope } from '@tender/core';
import { consume, refund, type Plan } from '@tender/quota';
import { audit } from '@tender/audit';
import { openaiToAnthropicResponse } from '@tender/protocol';
import { getQuotaStore } from '../../lib/stores.js';
import { createDefaultRouter } from '@tender/router';

export async function anthropicMessagesRoute(app: FastifyInstance): Promise<void> {
  app.post('/v1/messages', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.tenant) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }

    const body = req.body as {
      model?: string;
      messages: Array<{ role: string; content: unknown }>;
      system?: string;
      max_tokens?: number;
      temperature?: number;
      stream?: boolean;
    };

    if (!body.messages || !Array.isArray(body.messages)) {
      return reply.code(400).send({ ok: false, error: 'messages required' });
    }
    if (!body.max_tokens) {
      return reply.code(400).send({ ok: false, error: 'max_tokens required (Anthropic API spec)' });
    }

    const tenant = req.tenant;
    const sessionId = (req.headers['x-tender-session-id'] as string) ?? `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (body.stream) {
      return handleAnthropicStream(req, reply, body, tenant, sessionId);
    }

    const scope = new Scope({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      sessionId,
      scopes: tenant.scopes,
      metadata: { plan: tenant.plan, model: body.model },
    });

    const quotaResult = await consume(getQuotaStore(), tenant.tenantId, 'llm', tenant.plan as Plan);
    if (quotaResult.exceeded) {
      return reply.code(429).send({ ok: false, error: 'quota_exceeded', limit: quotaResult.limit });
    }

    try {
      const result = await scope.run(async () => {
        const router = createDefaultRouter();
        // 把 system 转成 messages[0]
        const msgs = body.system
          ? [{ role: 'system', content: body.system }, ...body.messages]
          : body.messages;
        return await router.route({
          model: body.model,
          messages: msgs.map(m => ({
            role: m.role as 'system' | 'user' | 'assistant' | 'tool',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          })),
          temperature: body.temperature,
          maxTokens: body.max_tokens,
          metadata: { tenantId: tenant.tenantId, userId: tenant.userId, sessionId },
        });
      });

      audit.llmCall({
        tenantId: tenant.tenantId,
        userId: tenant.userId,
        sessionId,
        target: result.provider,
        ip: req.ip,
        meta: { model: result.model, tokens: result.usage.totalTokens },
      });

      // 转 Anthropic 响应
      const openaiResp = {
        id: result.id,
        object: 'chat.completion' as const,
        created: Math.floor(Date.now() / 1000),
        model: result.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant' as const,
            content: result.content,
            ...(result.toolCalls?.length ? { tool_calls: result.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })) } : {}),
          },
          finish_reason: (result.finishReason === 'error' ? 'stop' : result.finishReason) as 'stop' | 'length' | 'tool_calls' | 'content_filter' | null,
        }],
        usage: {
          prompt_tokens: result.usage.promptTokens,
          completion_tokens: result.usage.completionTokens,
          total_tokens: result.usage.totalTokens,
        },
      };
      const anthropicResp = openaiToAnthropicResponse(openaiResp);
      return reply.code(200).send(anthropicResp);
    } catch (err) {
      await refund(getQuotaStore(), tenant.tenantId, 'llm');
      const e = err as { message?: string };
      return reply.code(502).send({ ok: false, error: 'provider_failed', detail: e.message });
    }
  });
}

/**
 * Anthropic 兼容流式响应
 *
 * 转换 OpenAI SSE 翻译回 Anthropic SSE event 格式
 *
 * 流式翻译逻辑:
 *   OpenAI chunk delta.content  → event: content_block_delta (text_delta)
 *   OpenAI chunk delta.role    → message_start (首次)
 *   OpenAI chunk finish_reason → message_delta (stop_reason)
 *   [DONE]                     → message_stop
 */
async function handleAnthropicStream(
  req: FastifyRequest,
  reply: FastifyReply,
  body: { model?: string; messages: Array<{ role: string; content: unknown }>; system?: string; max_tokens?: number; temperature?: number; tools?: unknown[] },
  tenant: { tenantId: string; userId: string; plan: string },
  sessionId: string
): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  raw.statusCode = 200;
  raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  raw.setHeader('Cache-Control', 'no-cache');
  raw.setHeader('Connection', 'keep-alive');
  raw.setHeader('X-Tender-Session-Id', sessionId);

  let isFirstChunk = true;
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | null = null;
  let modelName = body.model ?? 'unknown';
  const startedAt = Date.now();

  try {
    // 选第一个可用 provider
    const router = createDefaultRouter();
    const candidates = (router as any)._selectCandidates?.() ?? [];
    const provider = candidates.find((p: any) => p.protocol === 'anthropic') ?? candidates[0];
    if (!provider) throw new Error('no provider available');

    const { callProviderStream } = await import('@tender/router');
    modelName = provider.defaultModel;
    const streamGen = callProviderStream(provider, {
      model: body.model,
      messages: body.messages.map(m => ({
        role: m.role as 'system' | 'user' | 'assistant' | 'tool',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      tools: body.tools,
      metadata: { tenantId: tenant.tenantId, userId: tenant.userId, sessionId },
    });

    // 立即 emit message_start(Anthropic 协议要求)
    raw.write(`event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: modelName,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })}\n\n`);

    let textBlockStarted = false;

    for await (const chunk of streamGen) {
      const choice = chunk.choices?.[0];
      if (!choice) {
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens;
          outputTokens = chunk.usage.completion_tokens;
        }
        continue;
      }

      const delta = choice.delta ?? {};

      // 1. 文本 content → Anthropic content_block_delta (text_delta)
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (!textBlockStarted) {
          raw.write(`event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          })}\n\n`);
          textBlockStarted = true;
        }
        raw.write(`event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: delta.content },
        })}\n\n`);
      }

      // 2. tool_calls → Anthropic content_block (tool_use) 流式
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.id && tc.function?.name) {
            raw.write(`event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: tc.index ?? 0,
              content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} },
            })}\n\n`);
          }
          if (tc.function?.arguments) {
            raw.write(`event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: tc.index ?? 0,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            })}\n\n`);
          }
        }
      }

      // 3. finish_reason → message_delta (stop_reason) + content_block_stop + message_stop
      if (choice.finish_reason) {
        stopReason = mapOaiFinishToAnthropic(choice.finish_reason);
        if (textBlockStarted) {
          raw.write(`event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: 0,
          })}\n\n`);
          textBlockStarted = false;
        }
        raw.write(`event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        })}\n\n`);
        raw.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        raw.end();
        return;
      }
    }

    // 流意外结束(没有 finish_reason)
    if (textBlockStarted) {
      raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
    }
    raw.write(`event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens },
    })}\n\n`);
    raw.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    raw.end();
  } catch (err) {
    const e = err as { message?: string };
    raw.write(`event: error\ndata: ${JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message: e.message ?? 'provider_failed' },
    })}\n\n`);
    raw.end();
  }
}

function mapOaiFinishToAnthropic(reason: string | null): string {
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    default: return 'end_turn';
  }
}
