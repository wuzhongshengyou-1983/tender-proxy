# 为什么我们需要 Tender?— 8 个 AI 污染事故复盘

> **本文从 GitHub 调研 + 公开报道中,梳理 AI 应用上线以来最严重的 8 个污染事故。所有日期、根因、URL 已尽量核对,部分细节可能因公开报道不全有偏差。**

---

## 事故 1: Samsung 三星半导体 ChatGPT 泄密(2023.3-4)

| 字段 | 内容 |
|------|------|
| **披露时间** | 2023.3 内部 → 4.1 Bloomberg → 5.1 Samsung 全公司封禁 |
| **影响方** | Samsung Device Solutions(半导体事业部) |
| **事件数** | 三起独立事件 |
| **泄漏内容** | ①晶圆测量数据库源代码 ②内部半导体战略会议录音转录 ③debug 机密源代码 |

### 根因

工程师主动把机密代码+会议录音转录粘贴进 ChatGPT(求优化/会议纪要)。

**2023 年 3 月时**,ChatGPT 默认用对话训练模型,数据落到 OpenAI 美国服务器。

### 营销 vs 现实

- OpenAI 当时未在 consumer ChatGPT 提供 data opt-out
- **OpenAI 的"不训练企业数据"承诺适用于 Enterprise/Team/API,不覆盖 consumer ChatGPT**
- **营销 gap #1**: vendor 谈"我们对数据做什么",不主动说"用户会对数据做什么"

### Tender 解法

- ✅ 平台侧强制企业 SSO
- ✅ DLP 关键词检测("晶圆""wafer" 等敏感词自动拦)
- ✅ 输出后处理,删除粘贴痕迹

---

## 事故 2: Cursor 跨用户 Composer 事故(2024.8)⭐⭐⭐

| 字段 | 内容 |
|------|------|
| **披露时间** | 2024.8.13(周二晚美东),8.14 修复 |
| **影响** | 已认证 Cursor 用户在 Composer 看到其他用户的代码、prompt、AI 响应 |
| **范围** | 按小时,非按天 |
| **根因** | **服务端 telemetry/data-ingestion 层配置错误部署**,影响 prompts/responses 路由 |
| **响应** | Cursor 8.14 blog 披露 + 回滚 + 审计日志清除 |

### 这是 8 个事件里唯一确凿的"跨会话隔离"破坏

其他事故大多是**间接 prompt injection** 或**用户行为**,
**Cursor 是经典服务端路由 bug**——和你写任何代码都可能踩的 bug 一样。

### Tender 解法

- ✅ Scope per-instance state 守门(客户端)
- ✅ 服务端 tenant + userId 双重路由校验
- ✅ Route regression test(每次发版跑 7 类污染脚本)

---

## 事故 3: Slack AI 数据外泄(2024.8)

| 字段 | 内容 |
|------|------|
| **披露时间** | 2024.8.20-21 |
| **报告方** | PromptArmor(substack) |
| **根因** | ①间接 prompt injection ②Slack AI 默认 RAG 检索范围过宽 |

### 攻击链

```
攻击者 → 公共 channel 植入 payload
受害者 → 问 Slack AI 摘要
       → AI 被诱导从受害者其他私有 channel 提取数据
       → 通过 markdown 链接发到攻击者服务器
```

### Tender 解法

- ✅ 工具调用白名单(防 Slack 类)
- ✅ markdown/image 链接外发前过滤(防 EchoLeak)
- ✅ retrieved content 强制剥离 `<system>` 标签(防 prompt injection)

---

## 事故 4: Microsoft Recall 安保失败(2024.6)

| 字段 | 内容 |
|------|------|
| **披露时间** | 2024.5(Build 大会) → 6 月 Kevin Beaumont 演示 → 6.13 Microsoft 撤回 |
| **根因** | Recall 把屏幕每几秒截屏,**未加密**存到本地 SQLite |
| **后果** | 任何以用户身份运行的进程可读完整数据库 |
| **响应** | 撤回原计划 → 9 月 opt-in + TPM 绑定加密 + Windows Hello |

### 营销 vs 现实

- Microsoft 原营销:"私密、安全、设备端 AI"
- 现实:Beaumont 用 TotalRecall PoC 读出完整数据库 + 时间线
- **营销 gap #2**: 本地隔离如果不加密 = 没隔离

### Tender 解法

- ✅ 静态加密(企业版 AES-256-GCM)
- ✅ 密钥从 env 读,不进代码

---

## 事故 5: M365 Copilot EchoLeak / CVE-2025-32711

| 字段 | 内容 |
|------|------|
| **披露时间** | 2025 年(具体月待核实) |
| **报告方** | Aim Labs |
| **根因** | LLM scope violation + markdown image 渲染作为外发通道 |

### 攻击链(0-click 间接 prompt injection)

```
攻击者邮箱 → 放特制邮件(内嵌 markdown image)
受害者 → Copilot 处理邮件时被诱导
        → 通过 markdown image 链接外发敏感内容
        → 攻击者服务器收到
```

### Tender 解法

- ✅ markdown/image 外发前过滤
- ✅ retrieved content 强制剥离注入指令
- ✅ tenant 隔离防止跨用户

---

## 事故 6: M365 Copilot SharePoint 过度共享(2024 多份)

| 字段 | 内容 |
|------|------|
| **根因** | Copilot 严格遵守 SharePoint item-level 权限,但客户配的权限本身过宽 |
| **后果** | "组织内任何人"的文件被 Copilot 检索到,跨用户暴露 |

### Tender 解法

- ✅ 写入前 DLP 提示(权限过宽警告)
- ✅ RAG namespace 强制 tenant 隔离
- ✅ 审计日志可查每次召回的来源

---

## 事故 7: Notion AI "其他工作区内容"争议(2023) ⚠️

| 字段 | 内容 |
|------|------|
| **披露时间** | 2023.7-8 |
| **声称** | 用户看到没加入的工作区内容 |
| **Notion 回应** | 官方 blog 表示只检索调用者有权限访问的内容,声称是 LLM 幻觉或公开页面 |

### 这个事故**揭示了用户的恐惧**

> **用户分不清"AI 幻觉"和"真实隔离破坏"**

不管真相是什么,**用户的信任模型已经被破坏**。

### Tender 解法

- ✅ RAG 召回结果明确标注来源(tenant + scope + created_at)
- ✅ 任何跨 scope 召回 100% 拒绝,绝不靠"AI 兜底"

---

## 事故 8: ChatGPT Plugins/Actions OAuth 过度授权(2023-2024)

| 字段 | 内容 |
|------|------|
| **根因** | 第三方 Actions 因 OAuth scope 宽 + 共享 action endpoint → 跨用户泄漏 |
| **报告方** | Salt Security(2024 初)、Zenity(2024) |

### Tender 解法

- ✅ 工具调用白名单 + scope 校验
- ✅ 工具不能在 scope 间共享 state

---

## 共性教训

8 个事故可以归纳为 **5 大失败模式**:

| 模式 | 事故 | Tender 防护层 |
|------|------|--------------|
| 1. 用户主动外泄 | Samsung、Apple | DLP + SSO |
| 2. 服务端路由 bug | Cursor | tenant+userId 双重路由 + 回归测试 |
| 3. 间接 prompt injection | Slack、EchoLeak | 输出过滤 + retrieved content 净化 |
| 4. AI 是放大器 | Copilot SharePoint | namespace 强隔离 + 权限审计 |
| 5. "本地隔离"= 无加密 | Recall | 静态加密(企业版) |

## 为什么没有独立项目解决这个问题?

GitHub 调研 stars>500 的"AI 防污染"独立项目 = **0 个**。

原因:
- 这是一个"看不见的战场",用户出事故才知道有污染问题
- 大厂各自 patch(微软、Slack、Cursor 都在修)
- 但**没有开源整合方案**

**Tender 填补这个空白**。

## 下一步

- [Tender 架构详解](../guide/architecture.md)
- [1 行接入指南](../guide/quickstart.md)
- [长风实战 7 类污染案例](https://github.com/changfeng/changfeng-h5/commits)
