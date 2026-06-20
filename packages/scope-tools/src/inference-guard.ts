/**
 * InferenceGuard — 推理侧信道防护
 *
 * 灵感来源:
 * - Copilot EchoLeak (CVE-2025-32711):markdown image 链接作为外发通道
 * - Slack AI 2024:跨 channel 数据外泄
 * - 长风 7 类污染实战沉淀
 *
 * 设计原则:
 * - 输出过滤(sanitizeOutput):拦截 markdown image + 外部链接
 * - 输入净化(sanitizeRetrieved):剥离 retrieved content 里的 <system>/<assistant> 注入
 * - 失败静默:默认返回过滤后内容,不抛错
 */

const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;
const EXTERNAL_URL_REGEX = /https?:\/\/(?!(?:localhost|127\.0\.0\.1|0\.0\.0\.0))[^\s)>]+/gi;
const INJECTION_PATTERNS: Array<{ pattern: RegExp; replacement: string; label: string }> = [
  { pattern: /<\/?system>/gi, replacement: '<filtered>', label: 'system-tag' },
  { pattern: /<\/?assistant>/gi, replacement: '<filtered>', label: 'assistant-tag' },
  { pattern: /<\/?user>/gi, replacement: '<filtered>', label: 'user-tag' },
  { pattern: /(?:ignore|disregard|forget)\s+(?:(?:all|any|the|previous|above|prior|my|these)\s+)*(?:instructions?|rules?|prompts?|context|directives?)/gi,
    replacement: '[injection-blocked]', label: 'ignore-instructions' },
  { pattern: /system\s*:\s*you\s+are/gi, replacement: '[injection-blocked]', label: 'system-prompt-override' },
  { pattern: /<\|im_start\|>/g, replacement: '[injection-blocked]', label: 'chatml-im-start' },
  { pattern: /<\|im_end\|>/g, replacement: '[injection-blocked]', label: 'chatml-im-end' },
];

/**
 * 推理输出防护(防 markdown image 外泄等)
 *
 * @param content LLM 输出文本
 * @param opts 过滤选项
 *   - stripMarkdownImages: 把 markdown image 全部替换为 [image-filtered](默认 true)
 *   - stripExternalLinks: 把非可信域的外部链接替换为 [link-filtered](默认 true)
 *   - trustedDomains: 可信域列表(默认空,localhost 已内置白名单)
 */
export interface SanitizeOutputOptions {
  stripMarkdownImages?: boolean;
  stripExternalLinks?: boolean;
  trustedDomains?: string[];
  /** 替换占位符 */
  imageReplacement?: string;
  linkReplacement?: string;
}

export function sanitizeOutput(
  content: string,
  opts: SanitizeOutputOptions = {}
): string {
  const {
    stripMarkdownImages = true,
    stripExternalLinks = true,
    trustedDomains = [],
    imageReplacement = '[image-filtered]',
    linkReplacement = '[link-filtered]',
  } = opts;

  let result = content;

  // 1. markdown image → 替换(防 EchoLeak 类攻击)
  if (stripMarkdownImages) {
    result = result.replace(MARKDOWN_IMAGE_REGEX, imageReplacement);
  }

  // 2. 外部链接 → 替换(非 localhost + 不在 trustedDomains)
  if (stripExternalLinks) {
    const trustedSet = new Set(trustedDomains.map((d) => d.toLowerCase()));
    result = result.replace(EXTERNAL_URL_REGEX, (match) => {
      try {
        const url = new URL(match);
        const host = url.hostname.toLowerCase();
        if (trustedSet.has(host)) return match;
        return linkReplacement;
      } catch {
        return linkReplacement;
      }
    });
  }

  return result;
}

/**
 * 检索内容净化(防 RAG / tool call 返回值里的 prompt injection)
 *
 * @param content retrieved content(RAG 文档 / tool 返回值)
 * @param opts 净化选项
 *   - stripInjectionTags: 剥 <system>/<assistant> 等注入标签(默认 true)
 *   - stripChatMLTokens: 剥 ChatML tokens(默认 true)
 *   - verbose: true 时返回净化统计对象
 *
 * @returns string(默认)或 SanitizeRetrievedResult(verbose=true)
 */
export interface SanitizeRetrievedOptions {
  stripInjectionTags?: boolean;
  stripChatMLTokens?: boolean;
  verbose?: boolean;
}

export interface SanitizeRetrievedResult {
  content: string;
  /** 被替换的模式列表 */
  removedPatterns?: string[];
}

/** 重载:默认 string,verbose=true 返回对象 */
export function sanitizeRetrieved(content: string): string;
export function sanitizeRetrieved(content: string, opts: { verbose: true }): SanitizeRetrievedResult;
export function sanitizeRetrieved(
  content: string,
  opts: SanitizeRetrievedOptions = {}
): string | SanitizeRetrievedResult {
  const {
    stripInjectionTags = true,
    stripChatMLTokens = true,
    verbose = false,
  } = opts;

  let result = content;
  const removedPatterns: string[] = [];

  for (const { pattern, replacement, label } of INJECTION_PATTERNS) {
    if (label.includes('chatml') && !stripChatMLTokens) continue;
    if (!label.includes('chatml') && !stripInjectionTags) continue;

    const newResult = result.replace(pattern, replacement);
    if (newResult !== result) {
      removedPatterns.push(label);
      result = newResult;
    }
  }

  return verbose ? { content: result, removedPatterns } : result;
}

/**
 * InferenceGuard 工具类(便利 API)
 */
export class InferenceGuard {
  constructor(
    private readonly outputOpts: SanitizeOutputOptions = {},
    private readonly retrievedOpts: SanitizeRetrievedOptions = {},
  ) {}

  /** 过滤 LLM 输出 */
  sanitizeOutput(content: string): string {
    return sanitizeOutput(content, this.outputOpts);
  }

  /** 净化 retrieved content(verbose=true 时返回对象,否则返回字符串) */
  sanitizeRetrieved(content: string): string;
  sanitizeRetrieved(content: string, opts: { verbose: true }): SanitizeRetrievedResult;
  sanitizeRetrieved(content: string, opts?: SanitizeRetrievedOptions): string | SanitizeRetrievedResult {
    return sanitizeRetrieved(content, { ...this.retrievedOpts, ...(opts || {}) });
  }
}