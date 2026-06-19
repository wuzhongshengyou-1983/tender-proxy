/**
 * /v1/messages — Anthropic 兼容端点
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Scope } from '@tender/core';
import { consume, refund, type Plan } from '@tender/quota';
import { audit } from '@tender/audit';
import { openaiToAnthropicResponse } from '@tender/protocol';
import { sqliteQuotaStore } from '../lib/stores.js';
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

    if (body.stream) {
      return reply.code(501).send({ ok: false, error: 'streaming not yet implemented' });
    }

    const tenant = req.tenant;
    const sessionId = (req.headers['x-tender-session-id'] as string) ?? `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const scope = new Scope({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      sessionId,
      scopes: tenant.scopes,
      metadata: { plan: tenant.plan, model: body.model },
    });

    const quotaResult = await consume(sqliteQuotaStore, tenant.tenantId, 'llm', tenant.plan as Plan);
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
          finish_reason: result.finishReason,
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
      await refund(sqliteQuotaStore, tenant.tenantId, 'llm');
      const e = err as { message?: string };
      return reply.code(502).send({ ok: false, error: 'provider_failed', detail: e.message });
    }
  });
}
