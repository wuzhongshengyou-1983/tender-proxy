# Tender API 文档

## OpenAI 兼容端点

### POST /v1/chat/completions

完全兼容 OpenAI ChatCompletion API,**业务代码 0 改动**即可接入。

#### 请求

```http
POST /v1/chat/completions
Authorization: Bearer tender_xxxxxxxxxxxxxxxx
Content-Type: application/json

{
  "model": "deepseek-chat",
  "messages": [
    {"role": "system", "content": "You are helpful."},
    {"role": "user", "content": "Hello!"}
  ],
  "temperature": 0.7,
  "max_tokens": 1000
}
```

#### 响应

```json
{
  "id": "tender-1734567890-abc123",
  "object": "chat.completion",
  "created": 1734567890,
  "model": "deepseek-chat",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 8,
    "total_tokens": 20
  },
  "_tender": {
    "provider": "deepseek",
    "attempts": 1,
    "sessionId": "sess_xxx"
  }
}
```

`_tender` 是 Tender 扩展字段,记录:
- `provider`: 实际响应的 provider
- `attempts`: 失败重试次数
- `sessionId`: 本次 session ID

#### 错误响应

| 状态码 | 含义 |
|--------|------|
| 400 | 请求参数错误(缺 messages 等) |
| 401 | 未认证或 token 无效 |
| 413 | 请求体超过 8MB |
| 429 | 配额超限 |
| 502 | 所有 provider 都失败 |
| 501 | 流式暂不支持 |

---

## Anthropic 兼容端点

### POST /v1/messages

兼容 Anthropic Messages API。**注意**: `max_tokens` 是必填(Anthropic 规范要求)。

#### 请求

```http
POST /v1/messages
Authorization: Bearer tender_xxxxxxxxxxxxxxxx
Content-Type: application/json

{
  "model": "claude-sonnet-4-5",
  "max_tokens": 1000,
  "system": "You are helpful.",
  "messages": [
    {"role": "user", "content": "Hello!"}
  ]
}
```

#### 响应

```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "content": [
    {"type": "text", "text": "Hello! How can I help?"}
  ],
  "model": "claude-sonnet-4-5",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 12,
    "output_tokens": 8
  }
}
```

---

## RAG Namespace 端点

### POST /v1/rag/upsert

向指定 namespace 上传 documents。

```http
POST /v1/rag/upsert
{
  "scope": "default",
  "documents": [
    {"id": "doc1", "content": "...", "metadata": {...}}
  ]
}
```

每个 `(tenantId, scope)` 物理隔离到独立表。

### POST /v1/rag/query

从指定 namespace 检索。

```http
POST /v1/rag/query
{
  "scope": "default",
  "query": "什么是 Tender?",
  "topK": 5
}
```

**MVP 状态**: documents 存为 JSON,完整向量搜索在 v1.0。

---

## Session 端点

### GET /v1/sessions/:id

查询 session 信息(debug 用)。

```http
GET /v1/sessions/sess_xxx
Authorization: Bearer tender_xxx
```

返回当前 tenant/user/scopes/plan 信息。

---

## Admin 端点

### POST /admin/api/tenants

自服务创建 tenant(无需 auth)。

```http
POST /admin/api/tenants
{
  "name": "my-app",
  "plan": "free"  // free | pro | enterprise
}
```

返回 `{ id, name, plan }`。

### GET /admin/api/tenants

查询所有 tenant(需 `admin` scope)。

```http
GET /admin/api/tenants
Authorization: Bearer <admin-token>
```

### GET /admin/api/audit

查询审计日志(需 `admin` scope)。

```http
GET /admin/api/audit?tenantId=tenant_xxx&limit=50
Authorization: Bearer <admin-token>
```

返回 `{ events: [{ id, tenant_id, action, target, status, created_at }, ...] }`。

---

## Health 端点

### GET /health

```http
GET /health
```

返回 `{ ok: true, name: "tender", version: "0.1.0", timestamp }`。

无需认证,适合用于 Docker healthcheck。

### GET /

首页,列出所有端点。

---

## 配额(按 plan)

| Plan | llm/day | rag/day | tool/day |
|------|---------|---------|----------|
| free | 50 | 20 | 10 |
| pro | 10,000 | 5,000 | 1,000 |
| enterprise | ∞ | ∞ | ∞ |

超出配额返回 `429 quota_exceeded`。

---

## SDK 集成示例

### Node.js / OpenAI SDK

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:8080/v1',
  apiKey: process.env.TENDER_API_KEY,
});

const response = await client.chat.completions.create({
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

### Python / LangChain

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    base_url="http://localhost:8080/v1",
    api_key=os.environ["TENDER_API_KEY"],
    model="deepseek-chat",
)
```

### curl

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H 'Authorization: Bearer tender_xxx' \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}'
```
