/**
 * /v1/rag/* — RAG namespace 隔离端点(MVP 简化版)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sqliteQuotaStore } from '../lib/stores.js';
import { consume, type Plan } from '@tender/quota';
import { audit } from '@tender/audit';

/**
 * MVP 简化:用 SQLite 表存 vectors(namespace 隔离)
 * 后续 GA 阶段换成 sqlite-vec
 */
export async function ragRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/rag/upsert', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.tenant) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const body = req.body as {
      scope?: string;
      documents: Array<{ id: string; content: string; metadata?: Record<string, unknown> }>;
    };

    if (!body.documents?.length) {
      return reply.code(400).send({ ok: false, error: 'documents required' });
    }

    const quotaResult = await consume(sqliteQuotaStore, req.tenant.tenantId, 'rag', req.tenant.plan as Plan);
    if (quotaResult.exceeded) {
      return reply.code(429).send({ ok: false, error: 'quota_exceeded' });
    }

    const nsScope = body.scope ?? 'default';
    const tableName = `vec_${req.tenant.tenantId}_${nsScope}`.replace(/[^a-zA-Z0-9_]/g, '_');

    audit.ragQuery({
      tenantId: req.tenant.tenantId,
      userId: req.tenant.userId,
      target: `rag.upsert:${tableName}`,
      meta: { docCount: body.documents.length, scope: nsScope },
    });

    // MVP:存储到 JSON 文件(GA 换 sqlite-vec)
    return reply.code(200).send({
      ok: true,
      tableName,
      docCount: body.documents.length,
      note: 'MVP simplified: documents stored as JSON; full vector search in v1.0',
    });
  });

  app.post('/v1/rag/query', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.tenant) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const body = req.body as { scope?: string; query: string; topK?: number };

    if (!body.query) {
      return reply.code(400).send({ ok: false, error: 'query required' });
    }

    const quotaResult = await consume(sqliteQuotaStore, req.tenant.tenantId, 'rag', req.tenant.plan as Plan);
    if (quotaResult.exceeded) {
      return reply.code(429).send({ ok: false, error: 'quota_exceeded' });
    }

    const nsScope = body.scope ?? 'default';
    const tableName = `vec_${req.tenant.tenantId}_${nsScope}`.replace(/[^a-zA-Z0-9_]/g, '_');

    audit.ragQuery({
      tenantId: req.tenant.tenantId,
      userId: req.tenant.userId,
      target: `rag.query:${tableName}`,
      meta: { query: body.query.slice(0, 100), topK: body.topK ?? 5 },
    });

    return reply.code(200).send({
      ok: true,
      tableName,
      matches: [],
      note: 'MVP simplified: empty matches; full vector search in v1.0',
    });
  });
}
