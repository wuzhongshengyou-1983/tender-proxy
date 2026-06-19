/**
 * API Key 生成 + 哈希验证
 *
 * 灵感来源: 长风 routes/auth.js L45-55 pbkdf2Sync
 *
 * 选用 pbkdf2Sync(node:crypto 内置,零依赖):
 * - 100000 iterations
 * - SHA-512
 * - 64 bytes key
 */

import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

const ITERATIONS = 100000;
const KEY_LEN = 64;
const DIGEST = 'sha512';
const SALT_BYTES = 16;

/**
 * 生成 API Key(tender_xxx 格式)
 *
 * @example
 * const apiKey = generateApiKey();
 * // → "tender_a1b2c3d4...64chars"
 */
export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const random = randomBytes(32).toString('hex');
  const prefix = random.slice(0, 8);
  const key = `tender_${prefix}_${random}`;
  const hash = hashApiKey(key);
  return { key, hash, prefix };
}

/**
 * 哈希 API Key(pbkdf2Sync,百万级迭代)
 */
export function hashApiKey(apiKey: string): string {
  if (!apiKey.startsWith('tender_')) {
    throw new Error('Invalid API key format');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = pbkdf2Sync(apiKey, salt, ITERATIONS, KEY_LEN, DIGEST);
  return `pbkdf2$${ITERATIONS}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * 验证 API Key(常时比较防 timing attack)
 */
export function verifyApiKey(apiKey: string, storedHash: string): boolean {
  try {
    const parts = storedHash.split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iterations = parseInt(parts[1], 10);
    const salt = Buffer.from(parts[2], 'hex');
    const expected = Buffer.from(parts[3], 'hex');

    const derived = pbkdf2Sync(apiKey, salt, iterations, expected.length, DIGEST);
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * 从 API Key 提取 prefix(用于日志/UI 显示)
 */
export function getApiKeyPrefix(apiKey: string): string {
  const parts = apiKey.split('_');
  return parts.length >= 2 ? parts[1] : '';
}
