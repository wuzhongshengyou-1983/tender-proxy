/**
 * @tender/protocol — OpenAI ↔ Anthropic 协议翻译
 *
 * 灵感来源: smart-proxy 909 行 Python 重写为 TypeScript
 */

export type {
  OpenAIMessage,
  OpenAIRequest,
  OpenAIResponse,
  OpenAITool,
  OpenAIToolCall,
  OpenAIUsage,
  OpenAIChoice,
  OpenAIContentPart,
} from './openai.js';

export type {
  AnthropicMessage,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicTool,
  AnthropicContentBlock,
  AnthropicUsage,
} from './anthropic.js';

export {
  openaiToAnthropicRequest,
  openaiToAnthropicResponse,
  anthropicToOpenaiRequest,
  anthropicToOpenaiResponse,
} from './translator.js';
