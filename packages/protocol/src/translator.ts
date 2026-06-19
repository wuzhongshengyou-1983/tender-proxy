/**
 * OpenAI ↔ Anthropic 协议翻译
 *
 * 灵感来源: smart-proxy 的 anthropic_to_openai / openai_resp_to_anthropic
 *
 * 关键差异:
 * 1. system: OpenAI 把它当成 role:'system' message;Anthropic 是顶层字段
 * 2. max_tokens: Anthropic 必填;OpenAI 可选
 * 3. tools: OpenAI 是 {type:'function',function:{...}};Anthropic 是 flat
 * 4. tool_choice: 表达方式不同
 * 5. content: 都支持 text/multimodal,但字段名不同
 * 6. stop_reason: OpenAI 用 finish_reason;Anthropic 用 stop_reason
 */

import type { OpenAIRequest, OpenAIMessage, OpenAIResponse, OpenAITool, OpenAIChoice, OpenAIUsage } from './openai.js';
import type { AnthropicRequest, AnthropicMessage, AnthropicResponse, AnthropicContentBlock, AnthropicTool } from './anthropic.js';

// ============ OpenAI → Anthropic(请求) ============

export function openaiToAnthropicRequest(openai: OpenAIRequest): AnthropicRequest {
  // 提取 system message
  let system: string | AnthropicContentBlock[] | undefined;
  const messages: AnthropicMessage[] = [];

  for (const msg of openai.messages) {
    if (msg.role === 'system') {
      system = typeof msg.content === 'string'
        ? msg.content
        : (msg.content ?? []).filter(p => p.type === 'text').map(p => p.text ?? '').join('\n');
      continue;
    }

    if (msg.role === 'tool') {
      // tool result → Anthropic tool_result block
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id ?? '',
          content: typeof msg.content === 'string' ? msg.content : '',
          is_error: false,
        }],
      });
      continue;
    }

    // user / assistant 转换
    messages.push({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: convertContentToAnthropic(msg.content),
    });

    // assistant 的 tool_calls → tool_use blocks(已合并到 content 里)
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const last = messages[messages.length - 1];
      if (typeof last.content === 'string') {
        // 空字符串 → 空数组(不产生空 text block,让 tool_use 排在第一位)
        last.content = last.content
          ? [{ type: 'text', text: last.content }]
          : [];
      }
      for (const tc of msg.tool_calls) {
        try {
          (last.content as AnthropicContentBlock[]).push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || '{}'),
          });
        } catch {
          (last.content as AnthropicContentBlock[]).push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: {},
          });
        }
      }
    }
  }

  // 工具转换
  let tools: AnthropicTool[] | undefined;
  let tool_choice: AnthropicRequest['tool_choice'];
  if (openai.tools?.length) {
    tools = openai.tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: (t.function.parameters as { type: 'object'; properties?: Record<string, unknown>; required?: string[] }) ?? {
        type: 'object' as const,
      },
    }));

    if (typeof openai.tool_choice === 'string') {
      tool_choice = openai.tool_choice === 'auto'
        ? { type: 'auto' }
        : { type: 'any' };
    } else if (openai.tool_choice && typeof openai.tool_choice === 'object') {
      tool_choice = { type: 'tool', name: openai.tool_choice.function.name };
    }
  }

  const result: AnthropicRequest = {
    model: openai.model,
    messages,
    max_tokens: openai.max_tokens ?? 4096,
  };
  if (system !== undefined) result.system = system;
  if (openai.temperature !== undefined) result.temperature = openai.temperature;
  if (openai.top_p !== undefined) result.top_p = openai.top_p;
  if (openai.stop) {
    result.stop_sequences = Array.isArray(openai.stop) ? openai.stop : [openai.stop];
  }
  if (openai.stream !== undefined) result.stream = openai.stream;
  if (tools) result.tools = tools;
  if (tool_choice) result.tool_choice = tool_choice;
  if (openai.user) result.metadata = { user_id: openai.user };

  return result;
}

function convertContentToAnthropic(content: OpenAIMessage['content']): string | AnthropicContentBlock[] {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content.map(part => {
    if (part.type === 'text') return { type: 'text' as const, text: part.text ?? '' };
    if (part.type === 'image_url' && part.image_url) {
      // OpenAI image_url 支持 url 或 base64;Anthropic 用 source
      const url = part.image_url.url;
      if (url.startsWith('data:')) {
        const [meta, data] = url.slice(5).split(';base64,');
        const media_type = meta;
        return { type: 'image' as const, source: { type: 'base64' as const, media_type, data } };
      }
      return { type: 'image' as const, source: { type: 'url' as const, url } };
    }
    return { type: 'text' as const, text: '' };
  });
}

// ============ Anthropic → OpenAI(响应) ============

export function anthropicToOpenaiResponse(anthropic: AnthropicResponse, model: string): OpenAIResponse {
  const textBlocks = anthropic.content.filter(b => b.type === 'text');
  const toolUseBlocks = anthropic.content.filter(b => b.type === 'tool_use');

  const text = textBlocks.map(b => b.text ?? '').join('');

  let tool_calls: OpenAIChoice['message']['tool_calls'];
  if (toolUseBlocks.length > 0) {
    tool_calls = toolUseBlocks.map(b => ({
      id: b.id ?? '',
      type: 'function' as const,
      function: {
        name: b.name ?? '',
        arguments: JSON.stringify(b.input ?? {}),
      },
    }));
  }

  const message: OpenAIChoice['message'] = {
    role: 'assistant',
    content: tool_calls ? (text || null) : text,
  };
  if (tool_calls) message.tool_calls = tool_calls;

  const usage: OpenAIUsage = {
    prompt_tokens: anthropic.usage.input_tokens,
    completion_tokens: anthropic.usage.output_tokens,
    total_tokens: anthropic.usage.input_tokens + anthropic.usage.output_tokens,
  };

  return {
    id: anthropic.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: mapStopReason(anthropic.stop_reason),
    }],
    usage,
  };
}

function mapStopReason(reason: AnthropicResponse['stop_reason']): OpenAIChoice['finish_reason'] {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return null;
  }
}

// ============ Anthropic → OpenAI(请求)反向 ============

export function anthropicToOpenaiRequest(anthropic: AnthropicRequest): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // system → role:system
  if (anthropic.system) {
    const sysText = typeof anthropic.system === 'string'
      ? anthropic.system
      : anthropic.system.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
    if (sysText) {
      messages.push({ role: 'system', content: sysText });
    }
  }

  for (const msg of anthropic.messages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    const textParts: string[] = [];
    const toolCalls: NonNullable<OpenAIMessage['tool_calls']> = [];
    const toolResults: Array<{ tool_use_id: string; content: string; is_error: boolean }> = [];

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text ?? '');
      } else if (block.type === 'tool_use' && block.id && block.name) {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        toolResults.push({
          tool_use_id: block.tool_use_id,
          content: typeof block.content === 'string' ? block.content : '',
          is_error: !!block.is_error,
        });
      }
    }

    if (msg.role === 'assistant') {
      const assistantMsg: OpenAIMessage = {
        role: 'assistant',
        content: textParts.join('') || null,
      };
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
      messages.push(assistantMsg);
    } else {
      // user 消息:先加文本,再加 tool_result
      if (textParts.length) {
        messages.push({ role: 'user', content: textParts.join('') });
      }
      for (const tr of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: tr.content,
        });
      }
    }
  }

  // 工具转换
  let tools: OpenAITool[] | undefined;
  let tool_choice: OpenAIRequest['tool_choice'];
  if (anthropic.tools?.length) {
    tools = anthropic.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    if (anthropic.tool_choice) {
      if (anthropic.tool_choice.type === 'auto') {
        tool_choice = 'auto';
      } else if (anthropic.tool_choice.type === 'any') {
        tool_choice = 'auto'; // OpenAI 缺 any,降级 auto
      } else if (anthropic.tool_choice.type === 'tool' && anthropic.tool_choice.name) {
        tool_choice = { type: 'function', function: { name: anthropic.tool_choice.name } };
      }
    }
  }

  const result: OpenAIRequest = {
    model: anthropic.model,
    messages,
    max_tokens: anthropic.max_tokens,
  };
  if (anthropic.temperature !== undefined) result.temperature = anthropic.temperature;
  if (anthropic.top_p !== undefined) result.top_p = anthropic.top_p;
  if (anthropic.stream !== undefined) result.stream = anthropic.stream;
  if (anthropic.stop_sequences?.length) result.stop = anthropic.stop_sequences;
  if (tools) result.tools = tools;
  if (tool_choice) result.tool_choice = tool_choice;

  return result;
}

// ============ OpenAI → Anthropic(响应)反向 ============

export function openaiToAnthropicResponse(openai: OpenAIResponse): AnthropicResponse {
  const choice = openai.choices[0];
  const content: AnthropicContentBlock[] = [];

  if (choice.message.content && typeof choice.message.content === 'string') {
    content.push({ type: 'text', text: choice.message.content });
  }

  if (choice.message.tool_calls?.length) {
    for (const tc of choice.message.tool_calls) {
      try {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}'),
        });
      } catch {
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: {} });
      }
    }
  }

  const stop_reason = ((): AnthropicResponse['stop_reason'] => {
    switch (choice.finish_reason) {
      case 'stop': return 'end_turn';
      case 'length': return 'max_tokens';
      case 'tool_calls': return 'tool_use';
      default: return null;
    }
  })();

  return {
    id: openai.id,
    type: 'message',
    role: 'assistant',
    content,
    model: openai.model,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: openai.usage?.prompt_tokens ?? 0,
      output_tokens: openai.usage?.completion_tokens ?? 0,
    },
  };
}
