/**
 * 认证中间件(Fastify)
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { authenticate, type TenantContext, UnauthorizedError, InsufficientScopeError, type Plan } from '@tender/auth';

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: TenantContext;
  }
}

export async function authMiddleware(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const secret = process.env.TENDER_JWT_SECRET ?? 'a'.repeat(64);
  const authHeader = (req.headers.authorization as string | undefined);

  try {
    req.tenant = await authenticate(authHeader, secret);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return reply.code(401).send({
        ok: false,
        error: err.message,
        code: err.code,
      });
    }
    throw err;
  }
}

export function requireScope(...required: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.tenant) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    if (!required.every(s => req.tenant!.scopes.includes(s) || req.tenant!.scopes.includes('admin'))) {
      return reply.code(403).send({
        ok: false,
        error: 'insufficient_scope',
        required,
        actual: req.tenant.scopes,
      });
    }
  };
}
