/**
 * ToolWhitelist 单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolWhitelist } from '../src/whitelist.js';

describe('ToolWhitelist — 工具白名单 + scope 绑定', () => {
  let wl: ToolWhitelist;

  beforeEach(() => {
    wl = new ToolWhitelist();
  });

  describe('基础注册', () => {
    it('注册 + 列出工具名', () => {
      wl.register({ name: 'get_weather', description: 'Get weather' });
      wl.register({ name: 'send_email', description: 'Send email' });
      expect(wl.list()).toEqual(['get_weather', 'send_email']);
      expect(wl.size()).toBe(2);
    });

    it('重名注册抛错', () => {
      wl.register({ name: 'foo' });
      expect(() => wl.register({ name: 'foo' })).toThrow(/already registered/);
    });

    it('批量注册', () => {
      wl.registerAll([
        { name: 'a' },
        { name: 'b', description: 'B tool' },
      ]);
      expect(wl.size()).toBe(2);
    });

    it('clear 清空', () => {
      wl.register({ name: 'foo' });
      wl.clear();
      expect(wl.size()).toBe(0);
    });
  });

  describe('validateToolDefinition — 工具白名单', () => {
    it('白名单内工具通过', () => {
      wl.register({ name: 'get_weather', description: 'Get weather' });
      const r = wl.validateToolDefinition({
        type: 'function',
        function: { name: 'get_weather', description: 'Get weather' },
      });
      expect(r.ok).toBe(true);
    });

    it('未注册工具拒绝', () => {
      const r = wl.validateToolDefinition({
        type: 'function',
        function: { name: 'evil_tool' },
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('not whitelisted');
    });

    it('描述不匹配拒绝(防 typo)', () => {
      wl.register({ name: 'get_weather', description: 'Get weather' });
      const r = wl.validateToolDefinition({
        type: 'function',
        function: { name: 'get_weather', description: 'WRONG description' },
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('description mismatch');
    });

    it('无 description 字段时通过', () => {
      wl.register({ name: 'foo' });  // 注册时无 description
      const r = wl.validateToolDefinition({
        type: 'function',
        function: { name: 'foo', description: 'foo desc' },  // 调用方有
      });
      // 注册方 description 为 undefined → 不校验 → 通过
      expect(r.ok).toBe(true);
    });

    it('批量校验', () => {
      wl.register({ name: 'a' });
      wl.register({ name: 'b' });
      const r = wl.validateTools([
        { type: 'function', function: { name: 'a' } },
        { type: 'function', function: { name: 'c' } },  // 未注册
      ]);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('c');
    });
  });

  describe('validateToolCall — scope 绑定', () => {
    it('无 requiredScopes 任何 caller 都通过', () => {
      wl.register({ name: 'foo' });
      const r = wl.validateToolCall('foo', []);
      expect(r.ok).toBe(true);
    });

    it('requiredScopes 与 caller 匹配', () => {
      wl.register({ name: 'admin_tool', requiredScopes: ['admin'] });
      const r = wl.validateToolCall('admin_tool', ['admin']);
      expect(r.ok).toBe(true);
    });

    it('非 admin caller 调 admin tool 拒绝', () => {
      wl.register({ name: 'admin_tool', requiredScopes: ['admin'] });
      const r = wl.validateToolCall('admin_tool', ['user', 'llm:read']);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('admin');
    });

    it('caller 缺必需 scope 拒绝', () => {
      wl.register({ name: 'special_tool', requiredScopes: ['llm:write'] });
      const r = wl.validateToolCall('special_tool', ['llm:read']);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('llm:write');
    });

    it('多 scope AND 语义(都要有)', () => {
      wl.register({ name: 'combo', requiredScopes: ['a', 'b'] });
      expect(wl.validateToolCall('combo', ['a', 'b']).ok).toBe(true);
      expect(wl.validateToolCall('combo', ['a']).ok).toBe(false);
      expect(wl.validateToolCall('combo', ['b']).ok).toBe(false);
      expect(wl.validateToolCall('combo', ['a', 'b', 'c']).ok).toBe(true);
    });

    it('未注册工具调用拒绝', () => {
      const r = wl.validateToolCall('ghost', ['admin']);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('not registered');
    });
  });

  describe('真实场景模拟', () => {
    it('场景:长风 backend 注册 + 校验流程', () => {
      // 长风 backend 注册两个工具
      wl.register({
        name: 'account_diagnose',
        description: '诊断账号',
        requiredScopes: ['llm:write'],
      });
      wl.register({
        name: 'admin_reset',
        description: '管理员重置',
        requiredScopes: ['admin'],
      });

      // 用户调用
      expect(wl.validateToolCall('account_diagnose', ['llm:write']).ok).toBe(true);
      expect(wl.validateToolCall('account_diagnose', ['llm:read']).ok).toBe(false);

      // 攻击者尝试 admin tool(没 admin scope)
      expect(wl.validateToolCall('admin_reset', ['user']).ok).toBe(false);

      // 管理员调用
      expect(wl.validateToolCall('admin_reset', ['admin']).ok).toBe(true);

      // 攻击者尝试未注册 tool
      expect(wl.validateToolCall('backdoor', ['admin']).ok).toBe(false);
    });
  });
});