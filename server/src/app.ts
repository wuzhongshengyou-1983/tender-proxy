/**
 * Fastify app 初始化
 *
 * 灵感来源: 长风 server.js 中间件顺序范式
 * 1. Sentry(本 MVP 跳过)
 * 2. 全局中间件: cors → compression → json
 * 3. 业务中间件: clientIp → auth(per-route)
 * 4. 路由挂载
 * 5. 错误处理
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { loadEnv } from './lib/env.js';
import { initDB, getDB, closeDB } from './lib/db.js';
import { authMiddleware } from './middleware/auth.js';
import { healthRoute } from './routes/health/health.js';
import { chatCompletionsRoute } from './routes/v1/chat.js';
import { anthropicMessagesRoute } from './routes/anthropic/messages.js';
import { ragRoutes } from './routes/v1/rag.js';
import { sessionRoutes } from './routes/v1/sessions.js';
import { adminRoutes } from './routes/admin/admin.js';

export interface AppOptions {
  enableAuth?: boolean;
  logger?: boolean;
}

export async function createApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  loadEnv();

  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: true,
  });

  // 全局中间件
  app.addHook('onRequest', async (req) => {
    req.ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.ip;
  });

  // 健康检查(无需 auth)
  await app.register(healthRoute);

  // 业务路由(默认启用 auth)
  const auth = opts.enableAuth === false ? [] : [{ preHandler: authMiddleware }];
  await app.register(chatCompletionsRoute, { prefix: '', ...{ preHandler: auth } } as never).catch(() => {});
  // 上面一行 hack:fastify 不支持直接传 preHandler 到 register,实际在路由内做

  await app.register(chatCompletionsRoute);
  await app.register(anthropicMessagesRoute);
  await app.register(ragRoutes);
  await app.register(sessionRoutes);
  await app.register(adminRoutes);

  // 全局错误处理
  app.setErrorHandler((error, req, reply) => {
    app.log?.error(error);
    const statusCode = error.statusCode ?? 500;
    reply.code(statusCode).send({
      ok: false,
      error: error.message,
      code: error.code,
    });
  });

  // 优雅关闭
  app.addHook('onClose', async () => {
    closeDB();
  });

  return app;
}

/**
 * 启动入口
 */
export async function startServer(): Promise<void> {
  const dbPath = process.env.TENDER_DB_PATH ?? './data/tender.sqlite';
  initDB(dbPath);

  // 验证 db
  getDB().prepare('SELECT 1').get();

  const port = parseInt(process.env.TENDER_PORT ?? '8080', 10);
  const host = process.env.TENDER_HOST ?? '0.0.0.0';

  const app = await createApp({ logger: process.env.TENDER_NODE_ENV !== 'test' });

  await app.listen({ port, host });
  console.log(`[tender] listening on http://${host}:${port}`);
}

// 如果直接运行该文件,启动 server
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((err) => {
    console.error('[tender] failed to start:', err);
    process.exit(1);
  });
}
