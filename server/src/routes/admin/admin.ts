/**
 * /admin/api/* — 管理后台 API
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDB } from '../lib/db.js';
import { authMiddleware } from '../middleware/auth.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // 公开端点:创建 tenant(自服务)
  app.post('/admin/api/tenants', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { name: string; plan?: string };
    if (!body.name) {
      return reply.code(400).send({ ok: false, error: 'name required' });
    }
    const id = `tenant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const db = getDB();
    db.prepare(`INSERT INTO tenants (id, name, plan) VALUES (?, ?, ?)`).run(
      id,
      body.name,
      body.plan ?? 'free'
    );
    return reply.code(201).send({ ok: true, id, name: body.name, plan: body.plan ?? 'free' });
  });

  // 需要 admin scope
  app.get('/admin/api/tenants', { preHandler: [authMiddleware] }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.tenant?.scopes.includes('admin')) {
      return reply.code(403).send({ ok: false, error: 'admin scope required' });
    }
    const db = getDB();
    const rows = db.prepare(`SELECT id, name, plan, created_at FROM tenants ORDER BY created_at DESC LIMIT 100`).all();
    return reply.code(200).send({ ok: true, tenants: rows });
  });

  // 审计查询
  app.get('/admin/api/audit', { preHandler: [authMiddleware] }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.tenant?.scopes.includes('admin')) {
      return reply.code(403).send({ ok: false, error: 'admin scope required' });
    }
    const db = getDB();
    const q = req.query as { tenantId?: string; limit?: string };
    const tenantId = q.tenantId ?? req.tenant.tenantId;
    const limit = Math.min(parseInt(q.limit ?? '50', 10), 1000);

    const rows = db.prepare(`
      SELECT id, tenant_id, user_id, action, target, status, error_code, created_at
      FROM audit_log
      WHERE tenant_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(tenantId, limit);

    return reply.code(200).send({ ok: true, events: rows });
  });
}
