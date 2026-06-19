/**
 * Database 初始化(SQLite + 一次性建表)
 *
 * 灵感来源: 长风 db/index.js(零新基建,schema_version 守门)
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let _db: Database.Database | null = null;

export function initDB(dbPath: string): Database.Database {
  if (_db) return _db;

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');

  // 加载 schema.sql(同目录)
  const schemaPath = join(__dirname, 'schema.sql');
  let schemaSql: string;
  try {
    schemaSql = readFileSync(schemaPath, 'utf8');
  } catch {
    // 开发模式(tsx)路径回退
    schemaSql = readFileSync(join(process.cwd(), 'src/lib/schema.sql'), 'utf8');
  }

  _db.exec(schemaSql);
  return _db;
}

export function getDB(): Database.Database {
  if (!_db) throw new Error('DB not initialized — call initDB() first');
  return _db;
}

export function closeDB(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * SQLite QuotaStore 实现(基于 usage_counters 表)
 *
 * UPSERT 原子自增 = INSERT ... ON CONFLICT ... DO UPDATE
 */
export class SQLiteQuotaStore {
  constructor(private db: Database.Database) {}

  atomicIncrement(scope: string, key: string, day: string, n: number): number {
    const stmt = this.db.prepare(`
      INSERT INTO usage_counters (scope, key, day, n)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (scope, key, day)
      DO UPDATE SET n = n + excluded.n
      RETURNING n
    `);
    const row = stmt.get(scope, key, day, n) as { n: number };
    return row.n;
  }

  atomicDecrement(scope: string, key: string, day: string, n: number): number {
    const stmt = this.db.prepare(`
      UPDATE usage_counters
      SET n = MAX(0, n - ?)
      WHERE scope = ? AND key = ? AND day = ?
      RETURNING n
    `);
    const row = stmt.get(n, scope, key, day) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  get(scope: string, key: string, day: string): number {
    const stmt = this.db.prepare(`
      SELECT n FROM usage_counters WHERE scope = ? AND key = ? AND day = ?
    `);
    const row = stmt.get(scope, key, day) as { n: number } | undefined;
    return row?.n ?? 0;
  }
}

/**
 * SQLite AuditSink 实现
 */
export class SQLiteAuditSink {
  constructor(private db: Database.Database) {}

  insert(event: {
    tenantId?: string;
    userId?: string;
    sessionId?: string;
    action: string;
    target?: string;
    status?: string;
    errorCode?: string;
    meta?: Record<string, unknown>;
    ip?: string;
    userAgent?: string;
    createdAt: number;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO audit_log
        (tenant_id, user_id, session_id, action, target, status, error_code, meta, ip, user_agent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      event.tenantId ?? null,
      event.userId ?? null,
      event.sessionId ?? null,
      event.action,
      event.target ?? null,
      event.status ?? 'ok',
      event.errorCode ?? null,
      JSON.stringify(event.meta ?? {}),
      event.ip ?? null,
      event.userAgent ?? null,
      event.createdAt
    );
  }
}
