import { describe, it, expect } from 'vitest';
import { signJwt, verifyJwt, JwtError, generateSecureToken } from '../src/jwt.js';
import { generateApiKey, hashApiKey, verifyApiKey, getApiKeyPrefix } from '../src/api-key.js';
import {
  authenticate,
  createAccessToken,
  createVerifiedToken,
  requireScopes,
  UnauthorizedError,
  InsufficientScopeError,
  type ApiKeyStore,
} from '../src/middleware.js';

const SECRET = 'a'.repeat(64);

describe('JWT — 双 token 体系', () => {
  it('sign + verify 往返一致', () => {
    const token = signJwt(
      { sub: 'user_1', tenant: 't_A', scopes: ['read'], plan: 'pro' },
      SECRET,
      { ttlSec: 3600, type: 'access' }
    );
    const decoded = verifyJwt(token, SECRET, { type: 'access' });
    expect(decoded.sub).toBe('user_1');
    expect(decoded.tenant).toBe('t_A');
    expect(decoded.scopes).toEqual(['read']);
    expect(decoded.plan).toBe('pro');
    expect(decoded.type).toBe('access');
  });

  it('secret 太短抛错', () => {
    expect(() =>
      signJwt(
        { sub: 'u', tenant: 't', scopes: [], plan: 'free' },
        'short',
        { ttlSec: 60, type: 'access' }
      )
    ).toThrow(JwtError);
  });

  it('类型不匹配抛错', () => {
    const token = signJwt(
      { sub: 'u', tenant: 't', scopes: [], plan: 'free' },
      SECRET,
      { ttlSec: 60, type: 'verified' }
    );
    expect(() => verifyJwt(token, SECRET, { type: 'access' })).toThrow(/type mismatch/);
  });

  it('过期 token 抛错', () => {
    const token = signJwt(
      { sub: 'u', tenant: 't', scopes: [], plan: 'free' },
      SECRET,
      { ttlSec: -1, type: 'access' } // 已过期
    );
    expect(() => verifyJwt(token, SECRET, { type: 'access' })).toThrow(/expired/);
  });

  it('签名被篡改抛错', () => {
    const token = signJwt(
      { sub: 'u', tenant: 't', scopes: [], plan: 'free' },
      SECRET,
      { ttlSec: 60, type: 'access' }
    );
    const parts = token.split('.');
    parts[1] = Buffer.from(JSON.stringify({ sub: 'evil', tenant: 't', scopes: ['admin'], plan: 'enterprise', type: 'access', iat: 0, exp: 9999999999 })).toString('base64url');
    const tampered = parts.join('.');
    expect(() => verifyJwt(tampered, SECRET, { type: 'access' })).toThrow(/Invalid signature/);
  });

  it('createAccessToken 默认 30 天 TTL', () => {
    const token = createAccessToken(
      { tenantId: 't', userId: 'u', scopes: ['read'], plan: 'pro' },
      SECRET
    );
    const decoded = verifyJwt<{ exp: number; iat: number }>(token, SECRET, { type: 'access' });
    const ttl = decoded.exp - decoded.iat;
    expect(ttl).toBe(30 * 24 * 60 * 60);
  });

  it('createVerifiedToken 15 分钟', () => {
    const token = createVerifiedToken(
      { tenantId: 't', userId: 'u', purpose: 'register' },
      SECRET
    );
    const decoded = verifyJwt<{ exp: number; iat: number; type: string }>(token, SECRET);
    expect(decoded.type).toBe('verified');
    expect(decoded.exp - decoded.iat).toBe(15 * 60);
  });

  it('generateSecureToken 长度正确', () => {
    const token = generateSecureToken(32);
    expect(token).toHaveLength(64); // 32 bytes = 64 hex chars
  });
});

describe('API Key — 生成+哈希+验证', () => {
  it('generateApiKey 格式正确', () => {
    const { key, hash, prefix } = generateApiKey();
    expect(key).toMatch(/^tender_[a-f0-9]{8}_[a-f0-9]{64}$/);
    expect(hash).toMatch(/^pbkdf2\$100000\$/);
    expect(prefix).toHaveLength(8);
  });

  it('hashApiKey + verifyApiKey 往返', () => {
    const { key, hash } = generateApiKey();
    expect(verifyApiKey(key, hash)).toBe(true);
  });

  it('错误 API Key 验证失败', () => {
    const { key, hash } = generateApiKey();
    const fake = 'tender_bbbbbbbb_' + '0'.repeat(64);
    expect(verifyApiKey(fake, hash)).toBe(false);
  });

  it('getApiKeyPrefix', () => {
    const { key, prefix } = generateApiKey();
    expect(getApiKeyPrefix(key)).toBe(prefix);
  });

  it('格式错误的 key 抛错', () => {
    expect(() => hashApiKey('invalid_key')).toThrow();
  });
});

describe('多租户认证', () => {
  const mockStore: ApiKeyStore = {
    async findHashByPrefix(prefix) {
      if (prefix === 'abcdef01') {
        return {
          apiKeyHash: 'placeholder',
          tenantId: 'tenant_A',
          userId: 'user_X',
          scopes: ['llm:read', 'llm:write'],
          plan: 'enterprise',
        };
      }
      return null;
    },
  };

  it('JWT Bearer token 认证', async () => {
    const token = createAccessToken(
      { tenantId: 'tenant_B', userId: 'user_Y', scopes: ['llm:read'], plan: 'pro' },
      SECRET
    );
    const ctx = await authenticate(`Bearer ${token}`, SECRET);
    expect(ctx.tenantId).toBe('tenant_B');
    expect(ctx.userId).toBe('user_Y');
    expect(ctx.authMethod).toBe('jwt');
    expect(ctx.plan).toBe('pro');
  });

  it('API Key 认证(需要 store)', async () => {
    // 先准备一个真实的 hash
    const { key, hash } = generateApiKey();
    // 模拟 store 用真实 hash
    const realPrefix = key.split('_')[1];
    const store: ApiKeyStore = {
      async findHashByPrefix(prefix) {
        if (prefix === realPrefix) {
          return {
            apiKeyHash: hash,
            tenantId: 'tenant_C',
            userId: 'user_Z',
            scopes: ['llm:read', 'llm:write', 'rag:read'],
            plan: 'enterprise',
          };
        }
        return null;
      },
    };

    const ctx = await authenticate(key, SECRET, store);
    expect(ctx.tenantId).toBe('tenant_C');
    expect(ctx.authMethod).toBe('api_key');
    expect(ctx.apiKeyPrefix).toBe(realPrefix);
  });

  it('缺 Authorization header 抛 UnauthorizedError', async () => {
    await expect(authenticate(undefined, SECRET)).rejects.toThrow(UnauthorizedError);
  });

  it('Bearer + 错误 token 抛错', async () => {
    await expect(authenticate('Bearer invalid.token.here', SECRET)).rejects.toThrow();
  });

  it('requireScopes 缺 scope 抛错', () => {
    const ctx = {
      tenantId: 't', userId: 'u', scopes: ['read'], plan: 'free' as const,
      authMethod: 'jwt' as const,
    };
    expect(() => requireScopes(ctx, ['read'])).not.toThrow();
    expect(() => requireScopes(ctx, ['admin'])).toThrow(InsufficientScopeError);
  });

  it('admin scope 跳过所有检查', () => {
    const ctx = {
      tenantId: 't', userId: 'u', scopes: ['admin'], plan: 'enterprise' as const,
      authMethod: 'jwt' as const,
    };
    expect(() => requireScopes(ctx, ['read', 'write', 'anything'])).not.toThrow();
  });
});

describe('真实场景:多租户隔离', () => {
  it('场景:tenant_A 的 token 不能假装是 tenant_B', async () => {
    const token = createAccessToken(
      { tenantId: 'tenant_A', userId: 'u', scopes: ['read'], plan: 'free' },
      SECRET
    );
    const ctx = await authenticate(`Bearer ${token}`, SECRET);

    // 即便 payload 有 sessionId,也不能跨 tenant 串
    expect(ctx.tenantId).toBe('tenant_A');
    // 想伪造 tenantId: 需要 SECRET(已知 secret 才能签,client 端没有)
    // 想复用 token: 别人拿到 token 就拿到 ctx,但 scopes 受限
  });

  it('场景:scope 强制隔离(普通用户不能调 admin)', async () => {
    const userToken = createAccessToken(
      { tenantId: 't', userId: 'u', scopes: ['llm:read'], plan: 'free' },
      SECRET
    );
    const ctx = await authenticate(`Bearer ${userToken}`, SECRET);
    expect(() => requireScopes(ctx, ['admin'])).toThrow();
  });
});
