/**
 * /v1/chat/completions — OpenAI 兼容端点
 *
 * 接入示例:
 *   const client = new OpenAI({ baseURL: 'http://tender/v1', apiKey: 'tender_xxx' });
 *   await client.chat.completions.create({...});
 *
 * 流式(stream=true):
 *   逐 chunk 翻译 OpenAI SSE 格式输出
 *   格式: data: {json}\n\n + data: [DONE]\n\n
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Scope } from '@tender/core';
import { consume, refund, type Plan } from '@tender/quota';
import { audit } from '@tender/audit';
import { getQuotaStore } from '../../lib/stores.js';
import { callProviderStream, createDefaultRouter, type OpenAIStreamChunk } from '@tender/router';

export async function chatCompletionsRoute(app: FastifyInstance): Promise<void> {
  app.post('/v1/chat/completions', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.tenant) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }

    const body = req.body as {
      model?: string;
      messages: Array<{ role: string; content: unknown }>;
      temperature?: number;
      max_tokens?: number;
      stream?: boolean;
      tools?: unknown[];
      tool_choice?: unknown;
    };

    if (!body.messages || !Array.isArray(body.messages)) {
      return reply.code(400).send({ ok: false, error: 'messages required' });
    }

    const tenant = req.tenant;
    const sessionId = (req.headers['x-tender-session-id'] as string) ?? `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 创建 scope
    const scope = new Scope({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      sessionId,
      scopes: tenant.scopes,
      metadata: { plan: tenant.plan, model: body.model },
    });

    // 配额检查
    const quotaResult = await consume(getQuotaStore(), tenant.tenantId, 'llm', tenant.plan as Plan);
    if (quotaResult.exceeded) {
      return reply.code(429).send({
        ok: false,
        error: 'quota_exceeded',
        limit: quotaResult.limit,
        count: quotaResult.count,
      });
    }

    // ===== 流式分支 =====
    if (body.stream) {
      return handleStream(req, reply, body, tenant, sessionId, scope);
    }

    // ===== 非流式分支 =====
    try {
      const result = await scope.run(async () => {
        const router = createDefaultRouter();
        return await router.route({
          model: body.model,
          messages: body.messages.map(m => ({
            role: m.role as 'system' | 'user' | 'assistant' | 'tool',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          })),
          temperature: body.temperature,
          maxTokens: body.max_tokens,
          tools: body.tools,
          toolChoice: body.tool_choice,
          metadata: {
            tenantId: tenant.tenantId,
            userId: tenant.userId,
            sessionId,
          },
        });
      });

      // 审计
      audit.llmCall({
        tenantId: tenant.tenantId,
        userId: tenant.userId,
        sessionId,
        target: result.provider,
        ip: req.ip,
        userAgent: req.headers['user-agent'] as string | undefined,
        meta: {
          model: result.model,
          tokens: result.usage.totalTokens,
          attempts: result.attempts.length,
          latencyMs: result.latencyMs,
        },
      });

      return reply.code(200).send({
        id: result.id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: result.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: result.content,
            ...(result.toolCalls?.length ? { tool_calls: result.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })) } : {}),
          },
          finish_reason: result.finishReason,
        }],
        usage: {
          prompt_tokens: result.usage.promptTokens,
          completion_tokens: result.usage.completionTokens,
          total_tokens: result.usage.totalTokens,
        },
        _tender: {
          provider: result.provider,
          attempts: result.attempts.length,
          sessionId,
        },
      });
    } catch (err) {
      // 失败退配额
      await refund(getQuotaStore(), tenant.tenantId, 'llm');
      const e = err as { message?: string };
      return reply.code(502).send({
        ok: false,
        error: 'provider_failed',
        detail: e.message ?? 'unknown error',
      });
    }
  });
}

/**
 * 流式响应处理
 *
 * hijack reply.raw,直接写 SSE 格式
 * 失败时也写 SSE error chunk(客户端期望 stream=true 时不要 JSON 错误)
 */
async function handleStream(
  req: FastifyRequest,
  reply: FastifyReply,
  body: { model?: string; messages: Array<{ role: string; content: unknown }>; temperature?: number; max_tokens?: number; tools?: unknown[]; tool_choice?: unknown },
  tenant: { tenantId: string; userId: string; plan: string },
  sessionId: string,
  scope: Scope
): Promise<FastifyReply> {
  // 接管 reply,直接用 Node 原生 http.ServerResponse
  reply.hijack();

  const raw = reply.raw;
  raw.statusCode = 200;
  raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  raw.setHeader('Cache-Control', 'no-cache');
  raw.setHeader('Connection', 'keep-alive');
  raw.setHeader('X-Tender-Session-Id', sessionId);

  const startedAt = Date.now();
  let providerName = 'unknown';
  let modelName = body.model ?? 'unknown';
  let totalTokens = 0;

  try {
    // 在 scope 内调用 stream
    await scope.run(async () => {
      // 创建直接调用 provider stream 的函数(不走 router 主备链,简化首版)
      // v1.0.1 会接回主备链:逐 provider 试
      const router = createDefaultRouter();
      const providers = (router as any)._selectCandidates?.() ?? [];
      // 简化:用 router 的首个候选 provider
      const firstProvider = providers[0];
      if (!firstProvider) {
        throw new Error('no provider available');
      }

      const { callProviderStream } = await import('@tender/router');
      providerName = firstProvider.name;
      const streamGen = callProviderStream(firstProvider, {
        model: body.model,
        messages: body.messages.map(m => ({
          role: m.role as 'system' | 'user' | 'assistant' | 'tool',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
        temperature: body.temperature,
        maxTokens: body.max_tokens,
        tools: body.tools,
        toolChoice: body.tool_choice,
        metadata: {
          tenantId: tenant.tenantId,
          userId: tenant.userId,
          sessionId,
        },
      });

      for await (const chunk of streamGen) {
        const translated = translateChunk(chunk);
        if (translated) {
          raw.write(`data: ${JSON.stringify(translated)}\n\n`);
          if (translated.usage) totalTokens = translated.usage.total_tokens;
        }
      }
      raw.write('data: [DONE]\n\n');
      raw.end();
    });

    // 审计
    audit.llmCall({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      sessionId,
      target: providerName,
      ip: req.ip,
      userAgent: req.headers['user-agent'] as string | undefined,
      meta: {
        model: modelName,
        tokens: totalTokens,
        stream: true,
        latencyMs: Date.now() - startedAt,
      },
    });
  } catch (err) {
    // 流式失败也要给客户端一个 SSE error chunk
    const e = err as { message?: string };
    raw.write(`data: ${JSON.stringify({
      error: { message: e.message ?? 'provider_failed', type: 'provider_error' },
    })}\n\n`);
    raw.write('data: [DONE]\n\n');
    raw.end();

    // 退配额
    await refund(getQuotaStore(), tenant.tenantId, 'llm');

    // 审计失败
    audit.llmCall({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      sessionId,
      target: providerName,
      ip: req.ip,
      meta: { model: modelName, stream: true, error: e.message, status: 'error' },
    });
  }

  return reply;
}

/**
 * 翻译 provider chunk 为 OpenAI 兼容格式(已经是 OpenAI 兼容,这里只做小修正)
 */
function translateChunk(chunk: OpenAIStreamChunk): OpenAIStreamChunk | null {
  // OpenAI 兼容 provider 输出的 chunk 已经是 OpenAI 格式
  // 只需过滤掉没有 choices 的 chunk(如 ping/keep-alive)
  if (!chunk.choices && !chunk.usage) return null;
  return chunk;
}