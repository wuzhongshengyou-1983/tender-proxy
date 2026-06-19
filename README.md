# Tender — AI 防污染 Proxy

> **AI 应用的污染防火墙——一行代码接入,自动隔离 session / tenant / rag / inference 4 层污染**

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)](https://www.typescriptlang.org)

**Tender** 是业界第一个以"防止 AI context pollution / session leakage / cross-tenant contamination"为**核心卖点**的独立开源项目。源自长风生产环境(openo.vip v8.7.0)7 类污染的实战沉淀,经过 GitHub 调研验证,GitHub stars>500 的同类项目 = **0 个**。

---

## 为什么需要 Tender?

AI 应用存在 4 层污染风险,业界 60% 的"框架自动防污染"是营销话术:

| 污染类型 | 真实事故 | Tender 防护层 |
|---------|---------|--------------|
| **Session 串台** | 长风 v8.7.2 粽子月饼漂移(2026-06-16) | `Scope` per-instance state |
| **跨用户泄漏** | Cursor 2024.8 跨用户 Composer 事故 | `tenantId+userId` 多租户隔离 |
| **RAG 召回污染** | Slack AI 跨 channel 数据外泄(2024.8) | 物理 namespace,非 metadata filter |
| **侧信道外泄** | M365 Copilot EchoLeak CVE-2025-32711 | 工具白名单 + markdown 过滤 |

---

## 1 行接入

```javascript
// 之前(直连 OpenAI)
import OpenAI from 'openai';
const client = new OpenAI();

// 之后(走 Tender)
import OpenAI from 'openai';
const client = new OpenAI({
  baseURL: 'https://tender.your-domain.com/v1',  // ← 改这一行
  apiKey: process.env.TENDER_API_KEY,
});

// 业务代码完全不用改
const response = await client.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'hello' }],
});
// ✅ 自动获得 session 隔离 + 多租户 + RAG namespace + 推理防护
```

---

## 4 层防御架构

```
Layer 1: 协议级隔离   ──  per-instance state + scope 守门
Layer 2: 静态加密     ──  AES-256-GCM,LangGraph EncryptedSerializer 范式
Layer 3: RAG Namespace ── 物理隔离表 ≠ metadata filter(防 filter 配错泄漏)
Layer 4: 推理防护     ──  工具白名单 + markdown/image 过滤 + 指令注入检测
```

每层都从业界真实事故和范式沉淀:

- **Layer 1**: Vercel AI SDK `AbstractChat.id` 范式 + 长风 `_clearDiagContext` 事件总线
- **Layer 2**: LangGraph `EncryptedSerializer.from_pycryptodome_aes` 范式
- **Layer 3**: Pinecone namespace + Weaviate multi-tenancy(物理 vs 逻辑)
- **Layer 4**: Anthropic tool use schema + Slack AI / Copilot EchoLeak 教训

---

## 架构

```
┌──────────────────────────────────────────────────┐
│  AI Application (任何语言/框架)                  │
│  OpenAI SDK / Anthropic SDK / LangChain / 直 curl │
└──────────────────┬───────────────────────────────┘
                   ↓ baseURL → tender endpoint
┌──────────────────▼───────────────────────────────┐
│  Tender Proxy (Node.js 22 + TypeScript 5.6)      │
│  ┌────────────────────────────────────────────┐  │
│  │ 1. 多租户认证 (tenant/user/session)       │  │
│  │ 2. Scope 守门 (per-request state)          │  │
│  │ 3. RAG namespace 强制注入                  │  │
│  │ 4. OpenAI↔Anthropic 协议翻译               │  │
│  │ 5. 工具调用白名单 + scope 校验             │  │
│  │ 6. 静态加密(企业版)                        │  │
│  │ 7. Provider 主备链 (DS→SF→QWEN→MM)         │  │
│  │ 8. 审计 + 配额 (usage_counters 原子 UPSERT) │  │
│  └────────────────────────────────────────────┘  │
└──────────────────┬───────────────────────────────┘
                   ↓
┌──────────────────▼───────────────────────────────┐
│  LLM Providers (OpenAI / Anthropic / DS / SF)    │
└──────────────────────────────────────────────────┘
```

---

## 快速开始

### Docker(推荐)

```bash
git clone https://github.com/tender/tender.git
cd tender
cp .env.example .env
docker-compose up -d
bash scripts/smoke.sh   # 9 端点 smoke
```

### 从源码运行

```bash
pnpm install
pnpm build
pnpm --filter @tender/server start
```

### 集成示例

- [examples/langchain](examples/langchain) — LangChain 集成
- [examples/vercel-ai-sdk](examples/vercel-ai-sdk) — Vercel AI SDK 集成
- [examples/raw-curl](examples/raw-curl) — 直 curl 调用

---

## 项目结构

```
tender/
├── packages/
│   ├── core/       — Scope 守门 + StaleGuard + Bus(平台心脏)
│   ├── auth/       — 多租户认证 + JWT 双 token
│   ├── protocol/   — OpenAI↔Anthropic 协议翻译
│   ├── router/     — Provider 主备链 fallback
│   ├── audit/      — 8 类审计埋点
│   ├── quota/      — usage_counters 原子 UPSERT
│   └── sdk/        — 开发者友好 SDK
├── server/         — Fastify 主进程
├── docs/           — VitePress 文档
├── examples/       — 集成示例
└── scripts/        — smoke + redteam + build
```

---

## 长风实战背书

Tender 的每一层都不是凭空设计,而是从长风(openo.vip v8.7.0)在生产环境沉淀的 **7 类污染实战修复**抽象而来:

1. ✅ 跨平台诊断漂移(commit `e58b5c1`)
2. ✅ 视频号→小红书诊断串台(2026-06-06)
3. ✅ 诊断他人秒删锁定画像(commit `b0f55b9`)
4. ✅ 人设污染(video routeOther 默认)
5. ✅ 大号盲区误判(三次修复 `8147aa1/26a4d64/53ef9db`)
6. ✅ 进度条 92% 卡死(commit `b231527/a51dc81`)
7. ✅ Async stale 数据回流(`_diagUrlAtStart` 守门)

长风生产环境 Dogfooding 是 Tender 的可信度来源,**所有修复模式都已沉淀到 `@tender/scope` 核心抽象**。

---

## 路线图

| 阶段 | 时间 | 目标 |
|------|------|------|
| **MVP v0.1** | 4 周 | 长风 dogfooding + 9 端点 smoke + 10 个种子用户 |
| **GA v1.0** | 8 周 | 流式协议 + RAG namespace + 推理防护 + 100 stars |
| **Enterprise v1.1** | 4 周 | 静态加密 + SSO + 私有部署 + ¥50 万/年 |

---

## 商业模式(Open Core)

| 组件 | 许可 | 备注 |
|------|------|------|
| `@tender/core` / `auth` / `protocol` / `router` / `rag` / `inference` | Apache 2.0 | 免费 |
| `tender-server`(基础版) | Apache 2.0 | 免费 |
| **静态加密 / SSO / 审计导出** | 商业 license | 企业版 |
| **私有部署 Helm chart** | 商业 license | 企业版 |
| **托管版** | SaaS 订阅 | $49-$499/月 |

---

## 贡献

欢迎贡献,详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

特别欢迎:
- 真实生产环境的污染案例复盘
- 新污染类型的对抗性测试用例
- 协议翻译的边界 case
- 文档改进和翻译

---

## 致谢

- **Vercel AI SDK** — per-instance state 范式
- **LangGraph** — checkpoint_ns + EncryptedSerializer 范式
- **Pinecone / Weaviate** — namespace 物理隔离范式
- **Anthropic** — tool use schema 范式
- **长风 (Changfeng)** — 7 类污染实战沉淀
- **smart-proxy** — 协议翻译思路

---

## License

Apache 2.0 — 详见 [LICENSE](LICENSE)
