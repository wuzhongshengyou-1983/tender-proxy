/**
 * 多租户认证中间件
 *
 * 灵感来源: 长风 routes/auth.js authMiddleware + 401 拦截器
 *
 * 支持两种认证方式:
 * 1. JWT Bearer Token(用户登录后用)
 * 2. API Key(服务间调用)
 */

import { verifyJwt, signJwt, JwtError, type JwtPayload } from './jwt.js';
import { verifyApiKey } from './api-key.js';

export type Plan = 'free' | 'pro' | 'enterprise';

export interface TenantContext {
  tenantId: string;
  userId: string;
  sessionId?: string;
  scopes: string[];
  plan: Plan;
  /** 认证方式 */
  authMethod: 'jwt' | 'api_key';
  /** API Key prefix(若用 api_key) */
  apiKeyPrefix?: string;
}

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized', public readonly code = 'UNAUTHORIZED') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class InsufficientScopeError extends Error {
  constructor(public readonly required: string[], public readonly actual: string[]) {
    super(`Insufficient scope: required ${required.join(',')}, got ${actual.join(',')}`);
    this.name = 'InsufficientScopeError';
  }
}

/**
 * 解析 Authorization header
 */
function parseAuthHeader(header: string | undefined): { type: 'bearer' | 'api_key'; token: string } | null {
  if (!header) return null;
  const trimmed = header.trim();

  if (trimmed.startsWith('Bearer ')) {
    return { type: 'bearer', token: trimmed.slice(7).trim() };
  }

  // tender_xxx 格式 = API key
  if (trimmed.startsWith('tender_')) {
    return { type: 'api_key', token: trimmed };
  }

  return null;
}

/**
 * 解析 JWT 类型的请求
 */
function authenticateJwt(token: string, secret: string): TenantContext {
  let payload: JwtPayload;
  try {
    payload = verifyJwt(token, secret, { type: 'access' });
  } catch (err) {
    if (err instanceof JwtError) {
      throw new UnauthorizedError(err.message, err.code);
    }
    throw err;
  }

  return {
    tenantId: payload.tenant,
    userId: payload.sub,
    sessionId: payload.sessionId,
    scopes: payload.scopes,
    plan: payload.plan,
    authMethod: 'jwt',
  };
}

/**
 * 解析 API Key 类型的请求
 *
 * 需要外部传入 store(数据库/API)查找 hash
 */
export interface ApiKeyStore {
  findHashByPrefix(prefix: string): Promise<{ apiKeyHash: string; tenantId: string; userId: string; scopes: string[]; plan: Plan } | null>;
}

export async function authenticateApiKey(
  apiKey: string,
  store: ApiKeyStore
): Promise<TenantContext> {
  const parts = apiKey.split('_');
  if (parts.length < 3) {
    throw new UnauthorizedError('Invalid API key format', 'INVALID_FORMAT');
  }
  const prefix = parts[1];

  const record = await store.findHashByPrefix(prefix);
  if (!record) {
    throw new UnauthorizedError('API key not found', 'NOT_FOUND');
  }
  if (!verifyApiKey(apiKey, record.apiKeyHash)) {
    throw new UnauthorizedError('API key mismatch', 'MISMATCH');
  }

  return {
    tenantId: record.tenantId,
    userId: record.userId,
    scopes: record.scopes,
    plan: record.plan,
    authMethod: 'api_key',
    apiKeyPrefix: prefix,
  };
}

/**
 * 通用认证入口
 */
export async function authenticate(
  authHeader: string | undefined,
  secret: string,
  apiKeyStore?: ApiKeyStore
): Promise<TenantContext> {
  const parsed = parseAuthHeader(authHeader);
  if (!parsed) {
    throw new UnauthorizedError('Missing Authorization header', 'MISSING_AUTH');
  }

  if (parsed.type === 'bearer') {
    return authenticateJwt(parsed.token, secret);
  }

  if (parsed.type === 'api_key') {
    if (!apiKeyStore) {
      throw new UnauthorizedError('API key auth requires store', 'NO_STORE');
    }
    return authenticateApiKey(parsed.token, apiKeyStore);
  }

  throw new UnauthorizedError('Unknown auth method', 'UNKNOWN_METHOD');
}

/**
 * 创建 access token(正常使用)
 */
export function createAccessToken(
  ctx: { tenantId: string; userId: string; sessionId?: string; scopes: string[]; plan: Plan },
  secret: string,
  ttlSec: number = 30 * 24 * 60 * 60  // 30 天
): string {
  return signJwt(
    {
      sub: ctx.userId,
      tenant: ctx.tenantId,
      scopes: ctx.scopes,
      plan: ctx.plan,
      sessionId: ctx.sessionId,
    },
    secret,
    { ttlSec, type: 'access' }
  );
}

/**
 * 创建 verified token(注册/重置/敏感操作,15 分钟)
 */
export function createVerifiedToken(
  ctx: { tenantId: string; userId: string; purpose: string },
  secret: string
): string {
  return signJwt(
    {
      sub: ctx.userId,
      tenant: ctx.tenantId,
      scopes: ['verified'],
      plan: 'free',
    },
    secret,
    { ttlSec: 15 * 60, type: 'verified' }
  );
}

/**
 * 验证 scope 包含关系
 */
export function requireScopes(ctx: TenantContext, required: string[]): void {
  if (ctx.scopes.includes('admin')) return; // admin 跳过所有 scope 检查
  if (!required.every((s) => ctx.scopes.includes(s))) {
    throw new InsufficientScopeError(required, ctx.scopes);
  }
}
