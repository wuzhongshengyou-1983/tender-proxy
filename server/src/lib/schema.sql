-- ============================================
-- Tender Server Schema
--
-- 灵感来源: 长风 db/index.js + schema.sql
-- - 一次性建表(ensureColumns 增量补)
-- - schema_version 守门(防重复灌种子)
-- ============================================

-- 1. 多租户核心
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',     -- free | pro | enterprise
  api_key_hash TEXT,                    -- pbkdf2$xxx 格式
  api_key_prefix TEXT,                  -- 8 字符 prefix(快速查找)
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_tenants_prefix ON tenants(api_key_prefix);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  email TEXT,
  scopes TEXT NOT NULL DEFAULT '[]',     -- JSON 数组
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

-- 2. 会话
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                  -- UUID
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  state_encrypted BLOB,                 -- AES-256-GCM 加密的 scope state(企业版)
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_active_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_tenant_user ON sessions(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 3. RAG namespace 元数据
CREATE TABLE IF NOT EXISTS rag_namespaces (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,                  -- 'default' | 'diagnosis' | 'creation' | 'review'
  vector_table TEXT NOT NULL,           -- vec_<tenant>_<scope>
  doc_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (tenant_id, scope)
);

-- 4. 配额计数器(长风 usage_counters 范式)
CREATE TABLE IF NOT EXISTS usage_counters (
  scope TEXT NOT NULL,                  -- <tenant_id>:<kind>
  key TEXT NOT NULL,                    -- tenant_id
  day TEXT NOT NULL,                    -- 'YYYY-MM-DD'
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key, day)
);

CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_counters(day);

-- 5. 审计日志
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  user_id TEXT,
  session_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  status TEXT NOT NULL DEFAULT 'ok',     -- ok | error
  error_code TEXT,
  meta TEXT NOT NULL DEFAULT '{}',       -- JSON
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_audit_tenant_created ON audit_log(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

-- 6. Provider 失败跟踪(长风 _aiFailed 范式持久化版)
CREATE TABLE IF NOT EXISTS provider_failures (
  provider TEXT NOT NULL,
  fail_type TEXT NOT NULL,              -- '402' | '401' | '429' | '5xx' | 'timeout'
  fail_count INTEGER NOT NULL DEFAULT 1,
  last_fail_at INTEGER NOT NULL DEFAULT (unixepoch()),
  blocked_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, fail_type)
);

-- 7. Prompt 版本台账(长风无,平台新增)
CREATE TABLE IF NOT EXISTS prompt_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,                  -- 'system' | 'tool' | 'safety'
  version TEXT NOT NULL,                -- semver
  content TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,    -- 0/1
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_scope_version ON prompt_versions(scope, version);
CREATE INDEX IF NOT EXISTS idx_prompt_active ON prompt_versions(scope, active);

-- 8. schema_version 守门表(长风 db/index.js 范式)
CREATE TABLE IF NOT EXISTS schema_version (
  migration_id TEXT PRIMARY KEY,
  description TEXT,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 初始迁移记录
INSERT OR IGNORE INTO schema_version (migration_id, description)
VALUES ('v0_1_0_initial', 'Tender MVP initial schema');
