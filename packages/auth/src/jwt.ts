/**
 * JWT 双 token 实现
 *
 * 灵感来源: 长风 routes/auth.js L427 双 token 体系
 * - accessToken: 30 天(正常使用)
 * - verifiedToken: 15 分钟(注册/重置/敏感操作)
 *
 * 自实现 JWT(避免引入 jsonwebtoken 依赖):
 * - HS256
 * - base64url 编码
 * - HMAC-SHA256 签名
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type TokenType = 'access' | 'verified';

export interface JwtPayload {
  sub: string;           // userId
  tenant: string;        // tenantId
  scopes: string[];
  plan: 'free' | 'pro' | 'enterprise';
  type: TokenType;
  /** 过期时间(秒) */
  exp: number;
  /** 签发时间(秒) */
  iat: number;
  /** 可选:sessionId */
  sessionId?: string;
}

export class JwtError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'JwtError';
  }
}

function base64UrlEncode(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = padded.length % 4;
  return Buffer.from(padding ? padded + '='.repeat(4 - padding) : padded, 'base64');
}

/**
 * 签名 JWT
 */
export function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp' | 'type'>,
  secret: string,
  options: { ttlSec: number; type: TokenType }
): string {
  if (!secret || secret.length < 32) {
    throw new JwtError('JWT secret must be at least 32 chars', 'WEAK_SECRET');
  }

  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    ...payload,
    type: options.type,
    iat: now,
    exp: now + options.ttlSec,
  };

  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const sig = createHmac('sha256', secret).update(signingInput).digest();
  const encodedSig = base64UrlEncode(sig);

  return `${signingInput}.${encodedSig}`;
}

/**
 * 验证 JWT 并返回 payload
 */
export function verifyJwt<T extends JwtPayload = JwtPayload>(
  token: string,
  secret: string,
  options: { type?: TokenType } = {}
): T {
  if (!token) throw new JwtError('Empty token', 'EMPTY_TOKEN');

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtError('Invalid JWT format', 'MALFORMED');
  }
  const [encodedHeader, encodedPayload, encodedSig] = parts;

  // 验证签名
  const expectedSig = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const providedSig = base64UrlDecode(encodedSig);

  if (expectedSig.length !== providedSig.length) {
    throw new JwtError('Invalid signature', 'BAD_SIGNATURE');
  }
  if (!timingSafeEqual(expectedSig, providedSig)) {
    throw new JwtError('Invalid signature', 'BAD_SIGNATURE');
  }

  // 解析 payload
  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8')) as JwtPayload;
  } catch {
    throw new JwtError('Invalid payload JSON', 'MALFORMED_PAYLOAD');
  }

  // 验证过期
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    throw new JwtError(`Token expired at ${new Date(payload.exp * 1000).toISOString()}`, 'EXPIRED');
  }

  // 验证类型(可选)
  if (options.type && payload.type !== options.type) {
    throw new JwtError(
      `Token type mismatch: expected ${options.type}, got ${payload.type}`,
      'TYPE_MISMATCH'
    );
  }

  return payload as T;
}

/**
 * 生成 secure random string(用于 JWT secret,API key 等)
 */
export function generateSecureToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * 持久化 JWT secret 到文件(防重启全员掉线)
 *
 * 灵感来源: 长风 routes/auth.js L10-24(持久化 .jwt_secret)
 */
export function loadOrCreateSecret(envVarName: string, filePath: string): string {
  const fromEnv = process.env[envVarName];
  if (fromEnv && fromEnv.length >= 32) {
    return fromEnv;
  }

  // 从文件读
  const fs = require('node:fs') as typeof import('node:fs');
  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (content.length >= 32) return content;
  } catch {
    // 文件不存在,创建
  }

  // 生成新的 + 持久化
  const secret = generateSecureToken(32);
  try {
    fs.writeFileSync(filePath, secret, { mode: 0o600 });
  } catch (err) {
    console.warn(`[auth] failed to persist secret to ${filePath}:`, err);
  }
  return secret;
}
