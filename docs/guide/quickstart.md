# Tender — 1 行接入指南

## TL;DR

把 `baseURL` 改成 tender endpoint,**业务代码 0 改动**:

```diff
  import OpenAI from 'openai';
  const client = new OpenAI({
+   baseURL: 'https://tender.your-domain.com/v1',
+   apiKey: process.env.TENDER_API_KEY,
  });
```

完成。

## 30 秒起步

### 1. 安装并启动

```bash
# 用 Docker(推荐)
git clone https://github.com/tender/tender.git
cd tender
cp .env.example .env
# 编辑 .env 填入你的 API keys
docker-compose up -d
```

### 2. 创建 Tenant 和 API Key

```bash
# 创建 tenant
curl -X POST http://localhost:8080/admin/api/tenants \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-app","plan":"free"}'

# 响应:
# { "ok": true, "id": "tenant_xxx", "plan": "free" }
```

然后用 admin API 给 tenant 生成 API key(后续 v1.0 加入自服务)。

### 3. 调用 OpenAI API(走 Tender)

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:8080/v1',
  apiKey: 'tender_your_api_key',
});

// 完全不用改业务代码
const response = await client.chat.completions.create({
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.choices[0].message.content);
// "Hello! How can I help you today?"
// _tender.provider = 'deepseek'
// _tender.attempts = 1
```

## 你获得了什么?

不改业务代码,自动获得 **4 层防御**:

| 层 | 防御什么 | 例子 |
|---|---------|------|
| **Layer 1 协议级隔离** | session 串台 | 切平台时 stale 数据自动丢弃 |
| **Layer 2 静态加密** (企业版) | 磁盘泄漏 | 持久化前 AES-256-GCM |
| **Layer 3 RAG namespace** | 跨 tenant 召回 | 物理表隔离,filter 配错也安全 |
| **Layer 4 推理防护** | 侧信道外泄 | 工具白名单 + markdown 过滤 |

## 下一步

- [架构详解](./architecture.md) — 4 层防御原理
- [API 文档](../api/openai-compat.md) — OpenAI/Anthropic 兼容端点
- [红队测试](../../scripts/redteam.sh) — 5 类对抗性测试
- [长风实战背书](../blog/postmortem.md) — 7 类污染修复案例
