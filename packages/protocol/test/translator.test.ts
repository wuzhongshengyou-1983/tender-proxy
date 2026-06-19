import { describe, it, expect } from 'vitest';
import {
  openaiToAnthropicRequest,
  openaiToAnthropicResponse,
  anthropicToOpenaiRequest,
  anthropicToOpenaiResponse,
} from '../src/translator.js';
import type { OpenAIRequest, OpenAIResponse } from '../src/openai.js';
import type { AnthropicRequest, AnthropicResponse } from '../src/anthropic.js';

describe('OpenAI → Anthropic 请求转换', () => {
  it('基本文本对话', () => {
    const openai: OpenAIRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ],
    };

    const anthropic = openaiToAnthropicRequest(openai);

    expect(anthropic.system).toBe('You are a helpful assistant.');
    expect(anthropic.messages).toHaveLength(3); // system 分离
    expect(anthropic.messages[0].role).toBe('user');
    expect(anthropic.messages[1].role).toBe('assistant');
    expect(anthropic.max_tokens).toBe(4096);
    expect(anthropic.model).toBe('gpt-4');
  });

  it('tool_calls 转 tool_use', () => {
    const openai: OpenAIRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: '北京天气' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_123',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"北京"}' },
          }],
        },
      ],
    };

    const anthropic = openaiToAnthropicRequest(openai);
    const lastMsg = anthropic.messages[anthropic.messages.length - 1];
    expect(lastMsg.role).toBe('assistant');
    expect(Array.isArray(lastMsg.content)).toBe(true);
    const blocks = lastMsg.content as { type: string; name?: string; input?: unknown }[];
    expect(blocks[0].type).toBe('tool_use');
    expect(blocks[0].name).toBe('get_weather');
    expect(blocks[0].input).toEqual({ city: '北京' });
  });

  it('tool 消息转 tool_result', () => {
    const openai: OpenAIRequest = {
      model: 'gpt-4',
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_123',
          content: '{"temp": 25}',
        },
      ],
    };

    const anthropic = openaiToAnthropicRequest(openai);
    expect(anthropic.messages).toHaveLength(1);
    const blocks = anthropic.messages[0].content as { type: string; tool_use_id?: string }[];
    expect(blocks[0].type).toBe('tool_result');
    expect(blocks[0].tool_use_id).toBe('call_123');
  });

  it('tools 转换', () => {
    const openai: OpenAIRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        type: 'function',
        function: {
          name: 'search',
          description: 'Search the web',
          parameters: {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
          },
        },
      }],
      tool_choice: 'auto',
    };

    const anthropic = openaiToAnthropicRequest(openai);
    expect(anthropic.tools).toHaveLength(1);
    expect(anthropic.tools![0].name).toBe('search');
    expect(anthropic.tools![0].input_schema.type).toBe('object');
    expect(anthropic.tool_choice).toEqual({ type: 'auto' });
  });

  it('流式、温度、stop 序列透传', () => {
    const openai: OpenAIRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      temperature: 0.7,
      stop: ['END'],
    };

    const anthropic = openaiToAnthropicRequest(openai);
    expect(anthropic.stream).toBe(true);
    expect(anthropic.temperature).toBe(0.7);
    expect(anthropic.stop_sequences).toEqual(['END']);
  });

  it('image_url 转 source', () => {
    const openai: OpenAIRequest = {
      model: 'gpt-4-vision',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } },
        ],
      }],
    };

    const anthropic = openaiToAnthropicRequest(openai);
    const blocks = anthropic.messages[0].content as { type: string; source?: unknown }[];
    expect(blocks[1].type).toBe('image');
    expect((blocks[1].source as { url: string }).url).toBe('https://example.com/a.jpg');
  });
});

describe('Anthropic → OpenAI 响应转换', () => {
  it('基本文本响应', () => {
    const anthropic: AnthropicResponse = {
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello!' }],
      model: 'claude-sonnet-4-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const openai = anthropicToOpenaiResponse(anthropic, 'claude-sonnet-4-5');
    expect(openai.choices[0].message.content).toBe('Hello!');
    expect(openai.choices[0].finish_reason).toBe('stop');
    expect(openai.usage?.total_tokens).toBe(15);
  });

  it('tool_use 转 tool_calls', () => {
    const anthropic: AnthropicResponse = {
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'weather' } },
      ],
      model: 'claude-sonnet-4-5',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 10 },
    };

    const openai = anthropicToOpenaiResponse(anthropic, 'claude-sonnet-4-5');
    expect(openai.choices[0].finish_reason).toBe('tool_calls');
    expect(openai.choices[0].message.tool_calls).toHaveLength(1);
    expect(openai.choices[0].message.tool_calls![0].function.name).toBe('search');
  });

  it('stop_reason 映射:max_tokens → length', () => {
    const anthropic: AnthropicResponse = {
      id: 'msg_x',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'cut' }],
      model: 'claude-sonnet-4-5',
      stop_reason: 'max_tokens',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 100 },
    };
    const openai = anthropicToOpenaiResponse(anthropic, 'claude-sonnet-4-5');
    expect(openai.choices[0].finish_reason).toBe('length');
  });
});

describe('Anthropic → OpenAI 请求反向', () => {
  it('system 顶层 → role:system', () => {
    const anthropic: AnthropicRequest = {
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      system: 'Be concise.',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const openai = anthropicToOpenaiRequest(anthropic);
    expect(openai.messages[0].role).toBe('system');
    expect(openai.messages[0].content).toBe('Be concise.');
    expect(openai.messages[1].role).toBe('user');
  });

  it('tool_result 拆成 tool 消息', () => {
    const anthropic: AnthropicRequest = {
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'result data' },
        ],
      }],
    };
    const openai = anthropicToOpenaiRequest(anthropic);
    expect(openai.messages[0].role).toBe('tool');
    expect(openai.messages[0].tool_call_id).toBe('tu_1');
    expect(openai.messages[0].content).toBe('result data');
  });
});

describe('OpenAI → Anthropic 响应反向', () => {
  it('tool_calls → tool_use blocks', () => {
    const openai: OpenAIResponse = {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1000,
      model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"weather"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    const anthropic = openaiToAnthropicResponse(openai);
    expect(anthropic.stop_reason).toBe('tool_use');
    const toolUse = anthropic.content.find(b => b.type === 'tool_use');
    expect(toolUse).toBeDefined();
    expect(toolUse?.name).toBe('search');
  });
});

describe('往返一致性', () => {
  it('OpenAI → Anthropic → OpenAI 文本保留', () => {
    const original: OpenAIRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'hello' },
      ],
      temperature: 0.5,
    };

    const anthropic = openaiToAnthropicRequest(original);
    const back = anthropicToOpenaiRequest(anthropic);

    expect(back.messages[0].role).toBe('system');
    expect(back.messages[0].content).toBe('system prompt');
    expect(back.messages[1].role).toBe('user');
    expect(back.messages[1].content).toBe('hello');
    expect(back.temperature).toBe(0.5);
  });
});
