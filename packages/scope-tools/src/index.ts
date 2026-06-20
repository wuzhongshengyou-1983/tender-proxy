/**
 * @tender/scope-tools — 工具白名单 + scope 绑定 + 推理侧信道防护
 *
 * 灵感来源:
 * - 长风 backend 实际工具有限
 * - Anthropic tool_use input_schema + OpenAI function calling parameters 都是 Dict[str, object]
 * - SDK 不做运行时校验 → Tender 必须自己验
 * - 安全事件: Copilot EchoLeak (CVE-2025-32711) + Slack AI 2024
 *
 * 风险等级: 低(基于 5 条已验证事实)
 */

export {
  ToolWhitelist,
  defaultWhitelist,
  type OpenAITool,
  type RegisteredTool,
  type ValidateResult,
} from './whitelist.js';

export {
  sanitizeOutput,
  sanitizeRetrieved,
  InferenceGuard,
  type SanitizeOutputOptions,
  type SanitizeRetrievedOptions,
  type SanitizeRetrievedResult,
} from './inference-guard.js';