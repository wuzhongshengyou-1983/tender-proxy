/**
 * /v1/chat/completions — OpenAI 兼容端点
 *
 * 接入示例:
 *   const client = new OpenAI({ baseURL: 'http://tender/v1', apiKey: 'tender_xxx' });
 *   await client.chat.completions.create({...});
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { runScope, Scope } from '@tender/core';
import { consume, refund, todayDateString, buildScopeKey, type Plan } from '@tender/quota';
import { audit } from '@tender/audit';
import { getQuotaStore } from '../../lib/stores.js';
import { createDefaultRouter } from '@tender/router';

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

    if (body.stream) {
      return reply.code(501).send({ ok: false, error: 'streaming not yet implemented in MVP' });
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

    try {
      // 在 scope 内跑
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

      // 翻译为 OpenAI 格式
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
