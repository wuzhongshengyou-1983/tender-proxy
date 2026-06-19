/**
 * 多源 .env 加载器(长风 server.js L19-32 范式)
 *
 * 优先级: process.env(已存在) > .env(项目根) > .env.example
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function loadEnv(envPath?: string): void {
  const paths = envPath
    ? [envPath]
    : [
        join(process.cwd(), '.env'),
        join(process.cwd(), '.env.local'),
        join(process.cwd(), '.env.example'),
      ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // 去引号
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        // 不覆盖已有 env(长风范式)
        if (!(key in process.env)) {
          process.env[key] = value;
        }
      }
    } catch (err) {
      console.warn(`[env] failed to load ${p}:`, err);
    }
  }
}
