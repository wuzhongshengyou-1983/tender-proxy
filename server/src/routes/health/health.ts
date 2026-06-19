/**
 * /health — 健康检查
 */

import type { FastifyInstance } from 'fastify';

export async function healthRoute(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({
    ok: true,
    name: 'tender',
    version: '0.1.0',
    timestamp: Date.now(),
  }));

  app.get('/', async () => ({
    ok: true,
    name: 'tender',
    docs: 'https://github.com/tender/tender',
    endpoints: [
      'POST /v1/chat/completions (OpenAI 兼容)',
      'POST /v1/messages (Anthropic 兼容)',
      'POST /v1/rag/upsert',
      'POST /v1/rag/query',
      'GET /v1/sessions/:id',
      'POST /admin/api/tenants',
      'GET /admin/api/audit',
      'GET /health',
    ],
  }));
}
