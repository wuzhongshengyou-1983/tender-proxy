# Tender 架构详解

## 4 层防御原理

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: 协议级隔离 (Protocol-level)                         │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ - per-instance state (Vercel 范式)                      │ │
│ │ - scopeKey = (tenant, user, session) 强校验              │ │
│ │ - 切 session 自动清 6 类诊断变量(长风 v8.7.2 范式)     │ │
│ └─────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│ Layer 2: 静态加密 (At-rest Encryption)                      │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ - EncryptedSerializer (LangGraph 范式)                   │ │
│ │ - sqlite-vec AES-256-GCM                                 │ │
│ │ - 密钥从 env 读,不进代码                                 │ │
│ └─────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│ Layer 3: RAG Namespace (Multi-tenant Isolation)            │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ - 物理 namespace (Pinecone 范式) ≠ metadata filter     │ │
│ │ - WHERE clause 强制带 (tenant_id, user_id, scope)        │ │
│ │ - 默认值带 tenant,filter 漏传直接 403                    │ │
│ └─────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│ Layer 4: 推理侧信道防护 (Inference Side-channel)            │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ - 工具调用白名单 + scope 校验 (Anthropic tool 范式)     │ │
│ │ - markdown/image 链接外发前过滤 (Slack/Copilot 教训)    │ │
│ │ - retrieved content 中嵌入指令强制忽略                   │ │
│ │ - 进度条单一真相源 (长风 v6.7 范式)                      │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Layer 1: 协议级隔离 — Scope 守门

**核心问题**: 切平台/换账号时,前一个 session 的全局变量污染新 session。

**业界方案对比**:

| 方案 | 真隔离? | 来源 |
|------|---------|------|
| Vercel AI SDK `AbstractChat` 实例独立 state | ✅ 真 | `github.com/vercel/ai` 源码 |
| LangGraph `thread_id` 强制 | ❌ 营销 | 被 deep-research 1-2 票否定 |
| CrewAI Flow 自动边界 | ❌ 开发者责任 | 同上 |
| **Tender `Scope` per-instance state** | ✅ 真 | 长风 v8.7.2 实战沉淀 |

**Tender 实现**:

```typescript
// 每次请求创建一个 Scope
const scope = new Scope({
  tenantId: tenant.tenantId,
  userId: tenant.userId,
  sessionId,
  scopes: tenant.scopes,
});

await scope.run(async () => {
  // 在这个 scope 内,所有写都是隔离的
  scope.set('lastVideoData', { url: '...' });

  // 切平台 = 旧 scope.abort()
  //  → 所有 AbortController 触发
  //  → 所有 set/get 抛 ScopeAbortedError
  //  → Bus 广播 scope:aborted,其他模块清 stale DOM
});
```

**关键创新**:
- `set()` 是守门写入,abort 后抛错(不是悄悄丢弃)
- `AsyncLocalStorage` 集成,async 中也能 `Scope.current()`
- `Bus.on('scope:aborted')` 让其他模块自动清理

## Layer 2: 静态加密 — 防止磁盘泄漏

**核心问题**: SQLite/Postgres 备份被偷、运维误删、log 泄漏敏感数据。

**业界方案对比**:

| 方案 | 加密什么 |
|------|---------|
| LangGraph `EncryptedSerializer.from_pycryptodome_aes` | checkpoint state |
| Pinecone 服务端加密 | vector storage |
| **Tender `TENDER_ENCRYPTION_KEY`** | session state + audit 敏感字段 |

**实现**(企业版,v1.1):

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY = Buffer.from(process.env.TENDER_ENCRYPTION_KEY!, 'hex');
const ALGO = 'aes-256-gcm';

export function encrypt(plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

export function decrypt(ciphertext: Buffer): string {
  const iv = ciphertext.subarray(0, 12);
  const tag = ciphertext.subarray(12, 28);
  const enc = ciphertext.subarray(28);
  const decipher = createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
```

**注意事项**:
- KEY 必须 `openssl rand -hex 32` 生成,32 字节
- 密钥绝不能进 git
- 轮换密钥需要 re-encrypt 全部历史数据

## Layer 3: RAG Namespace — 物理 vs 逻辑隔离

**核心问题**: 跨 tenant 召回数据。

**为什么不用 metadata filter?** (业内 5 大事故的根因)
- Slack AI 2024.8: 跨 channel 数据外泄
- M365 Copilot SharePoint: 跨用户检索
- Cursor 2024.8: 跨用户 Composer
- Pinecone/Weaviate: filter 配错就泄漏

**物理隔离方案**:

```sql
-- 每个 (tenant, scope) 一个物理表
vec_tenant_A_diagnosis
vec_tenant_A_creation
vec_tenant_B_diagnosis
vec_tenant_B_review
```

**Tender 实现**:

```typescript
export class IsolatedVectorStore {
  async upsert(ns: RagNamespace, vectors: Vector[]) {
    if (!ns.tenantId || !ns.userId) {
      throw new NamespaceRequiredError();  // 强校验
    }
    const tableName = `vec_${ns.tenantId}_${ns.scope}`;
    return this._getOrCreateTable(tableName).upsert(vectors);
  }

  async query(ns: RagNamespace, query: number[], topK: number) {
    // 不允许跨 namespace 查询
    if (!ns.tenantId) throw new NamespaceRequiredError();
    const tableName = `vec_${ns.tenantId}_${ns.scope}`;
    return this._getOrCreateTable(tableName).query(query, topK);
  }

  // 默认拒绝跨 namespace
  async queryCrossNamespace() {
    throw new CrossNamespaceQueryError('requires admin scope');
  }
}
```

**物理 vs 逻辑对比**:

| 维度 | 物理 (Tender) | metadata filter |
|------|--------------|-----------------|
| 配错安全 | ✅ 查不到 | ❌ 全部泄漏 |
| 性能 | O(1) 路由 | O(N) 扫表 |
| 备份 | 按表 dump | 整库 dump |
| 多租户扩展 | 加表(可控) | 加 metadata(易错) |

## Layer 4: 推理侧信道防护

**核心问题**: LLM 输出被利用作为攻击通道。

**3 个真实事故**:

1. **M365 Copilot EchoLeak (CVE-2025-32711)**: markdown image 链接作为外发通道
2. **Slack AI (2024.8)**: 公共 channel payload → 私有 channel 数据外泄
3. **Cursor (2024.8)**: 服务端路由 bug → 跨用户 Composer

**Tender 实现**:

```typescript
export class InferenceGuard {
  // 工具调用白名单(防 Slack/Cursor 类)
  validateToolCall(ctx: TenantContext, tool: Tool, args: unknown): void {
    const allowed = ctx.scopes.includes('admin')
      ? ALL_TOOLS
      : ctx.scopes.flatMap(s => SCOPE_TOOLS[s] || []);

    if (!allowed.includes(tool.name)) {
      throw new ToolNotAllowedError(tool.name);
    }
    if (this._referencesOtherScope(args, ctx)) {
      throw new ScopeViolationError();
    }
  }

  // markdown/image 过滤(防 EchoLeak)
  sanitizeOutput(content: string): string {
    return content
      .replace(MARKDOWN_IMAGE_REGEX, '[image-filtered]')
      .replace(EXTERNAL_LINK_REGEX, (m, url) =>
        this._isTrustedDomain(url) ? m : '[link-filtered]'
      );
  }

  // 防 Prompt Injection
  sanitizeRetrieved(content: string): string {
    return content
      .replace(/<\/?system>/gi, '<filtered>')
      .replace(/ignore (previous|above) instructions/gi, '[injection-blocked]');
  }
}
```

## 总结:Tender vs 业界

| 维度 | Tender | LangGraph | Vercel AI SDK | CrewAI |
|------|--------|-----------|---------------|--------|
| session 隔离 | ✅ 真 | ⚠️ 文档强 | ✅ 真 | ⚠️ 开发者责任 |
| 静态加密 | ✅ | ✅ EncryptedSerializer | ❌ | ❌ |
| RAG 物理隔离 | ✅ | ❌ checkpoint_ns 而非 RAG | ❌ | ❌ |
| 推理侧信道 | ✅ | ❌ | ❌ | ❌ |
| 多租户 | ✅ 原生 | ❌ 靠开发者 | ❌ | ❌ |
| 实战背书 | 长风生产 | 多框架集成 | 多框架集成 | 实验性 |

**Tender 是唯一一个在 4 层都做了,且有真实生产环境背书的独立项目**。
