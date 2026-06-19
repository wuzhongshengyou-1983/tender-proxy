/**
 * /v1/sessions/:id — 会话查询(debug 用)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/sessions/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.tenant) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const id = (req.params as { id: string }).id;
    return reply.code(200).send({
      ok: true,
      sessionId: id,
      tenantId: req.tenant.tenantId,
      userId: req.tenant.userId,
      scopes: req.tenant.scopes,
      plan: req.tenant.plan,
      note: 'Session state is in-memory by default; encrypted persistence is Enterprise feature',
    });
  });
}
