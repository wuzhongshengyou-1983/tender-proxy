/**
 * @tender/auth — Tender 多租户认证
 *
 * 双 token 体系 + 多租户上下文 + API key
 *
 * 灵感来源: 长风 routes/auth.js
 * - JWT 双 token(30 天 access + 15 分钟 verified)
 * - pbkdf2Sync API key 哈希(100k iterations)
 * - .jwt_secret 文件持久化
 */

export * from './jwt.js';
export * from './api-key.js';
export * from './middleware.js';
