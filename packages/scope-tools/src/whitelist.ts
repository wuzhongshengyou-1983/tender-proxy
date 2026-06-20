/**
 * ToolWhitelist — OpenAI 工具白名单 + scope 绑定
 *
 * 灵感来源:
 * - 长风 backend 实际工具有限(主要用 lib/ai.js 主备链,tool calling 暂未深度用)
 * - 业界:Anthropic tool_use input_schema + OpenAI function calling parameters
 *   两者都是 Dict[str, object](SDK 不做运行时校验)
 * - 安全事件: Copilot EchoLeak (CVE-2025-32711) + Slack AI 2024 数据外泄
 *
 * 设计原则:
 * - SDK 不验 → Tender 必须自己验
 * - 白名单 = 显式 register + 拒绝未注册
 * - scope 绑定 = 即使工具注册了,调用前再校验调用方是否有 scope
 * - 失败静默(默认 reject,失败 throw — 由上层决定是否 catch)
 */

/**
 * OpenAI 工具定义(参考 openai-python chat_completion_tool_param.py)
 */
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

/**
 * 工具注册信息
 */
export interface RegisteredTool {
  name: string;
  description?: string;
  /** 可选:JSON Schema 校验函数(严格模式) */
  schemaValidator?: (params: unknown) => { ok: boolean; reason?: string };
  /** 调用该工具需要的 scope(如 ['admin'] 或 ['llm:read']) */
  requiredScopes?: string[];
}

export interface ValidateResult {
  ok: boolean;
  reason?: string;
}

/**
 * 工具白名单 registry
 */
export class ToolWhitelist {
  private tools = new Map<string, RegisteredTool>();

  /**
   * 注册一个工具
   * @throws 如果同名工具已注册
   */
  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * 批量注册(初始化时用)
   */
  registerAll(tools: RegisteredTool[]): void {
    for (const t of tools) this.register(t);
  }

  /**
   * 校验工具定义是否在白名单内(用于 router.route() 入口)
   *
   * @param tool OpenAI 工具定义
   * @returns ok=true 通过;ok=false + reason 拒绝原因
   */
  validateToolDefinition(tool: OpenAITool): ValidateResult {
    const def = this.tools.get(tool.function.name);
    if (!def) {
      return {
        ok: false,
        reason: `tool not whitelisted: ${tool.function.name}`,
      };
    }
    // 描述必须匹配(防 typo)
    if (def.description && tool.function.description !== def.description) {
      return {
        ok: false,
        reason: `tool description mismatch: ${tool.function.name}`,
      };
    }
    return { ok: true };
  }

  /**
   * 校验调用方是否有该工具的 scope
   */
  validateToolCall(
    toolName: string,
    callerScopes: readonly string[]
  ): ValidateResult {
    const def = this.tools.get(toolName);
    if (!def) {
      return { ok: false, reason: `tool not registered: ${toolName}` };
    }
    if (!def.requiredScopes || def.requiredScopes.length === 0) {
      return { ok: true };
    }
    // 调用方必须有所有 requiredScopes(AND 语义)
    for (const required of def.requiredScopes) {
      if (!callerScopes.includes(required)) {
        return {
          ok: false,
          reason: `tool ${toolName} requires scope ${required}`,
        };
      }
    }
    return { ok: true };
  }

  /**
   * 校验多个工具定义(批量入口)
   */
  validateTools(tools: OpenAITool[]): ValidateResult {
    for (const tool of tools) {
      const r = this.validateToolDefinition(tool);
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  /**
   * 列出所有已注册工具名(供 admin 接口)
   */
  list(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * 取出工具定义(供 Anthropic 翻译用,未来 v0.6.1)
   */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * 工具数
   */
  size(): number {
    return this.tools.size;
  }

  /**
   * 清空(测试用)
   */
  clear(): void {
    this.tools.clear();
  }
}

/**
 * 全局默认白名单(空,需用户主动 register)
 */
export const defaultWhitelist = new ToolWhitelist();