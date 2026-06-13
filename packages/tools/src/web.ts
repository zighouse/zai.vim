// @zaivim/tools — Web fetch and search tools
// Story 3.2b: web_fetch, web_search
// URL validation (SSRF, protocol whitelist, Content-Type check) is done
// at the tool layer. No sandbox is required (HTTP-only operations).

import type { ToolDefinition, ToolContext, WebFetchParams, WebFetchResult, WebSearchParams, WebSearchResult, SearchResultItem } from '@zaivim/core';

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAX_URL_LENGTH = 2048;
const MAX_QUERY_LENGTH = 500;
const MAX_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;  // 5MB — hard reject
const MAX_OUTPUT_BYTES = 10 * 1024;           // 10KB — truncate output
const MAX_SEARCH_RESULTS = 10;

/** SSRF 防护：内网/私有 IPv4 前缀 */
const BLOCKED_IPV4_PREFIXES = [
  '0.', '10.', '127.', '169.254.',
  '172.16.', '172.17.', '172.18.', '172.19.',
  '172.20.', '172.21.', '172.22.', '172.23.',
  '172.24.', '172.25.', '172.26.', '172.27.',
  '172.28.', '172.29.', '172.30.', '172.31.',
  '192.168.', '224.', '240.',
];

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const ALLOWED_CONTENT_TYPES = new Set([
  'text/plain', 'text/html', 'text/markdown', 'text/xml', 'text/css',
  'text/javascript', 'text/csv', 'text/tab-separated-values',
  'application/json', 'application/xml', 'application/javascript',
  'application/ld+json',
]);

// ─── Helpers ───────────────────────────────────────────────────────────────────

function stripZeroWidth(s: string): string {
  return s.replace(/[​-‍﻿]/g, '');
}

function rejectedFetchResult(url: string, code: string, message: string, statusCode = 0): WebFetchResult {
  return {
    url, content: '', contentType: '', statusCode,
    truncated: false, size: 0, elapsed: 0,
    errorCode: `${code}: ${message}`,
  };
}

function isPrivateIP(hostname: string): boolean {
  // Node.js URL 对 IPv6 返回带方括号的 hostname，如 "[::1]"
  const h = hostname.replace(/^\[|\]$/g, '');

  // 检查 IPv4 内网地址前缀
  for (const prefix of BLOCKED_IPV4_PREFIXES) {
    if (h.startsWith(prefix)) return true;
  }
  // 检查 IPv6 loopback/local
  if (h === '::1' || h === 'localhost') return true;
  // IPv6 link-local (fe80::)
  if (h.startsWith('fe80:')) return true;
  // IPv6 unique local (fc00::/fd00::)
  if (h.startsWith('fc00:') || h.startsWith('fd00:')) return true;
  // IPv4-mapped IPv6 — Node.js 归一化为 hex 如 "[::ffff:7f00:1]"
  const v4mapped = h.match(/^::ffff:(.+)$/i);
  if (v4mapped) {
    const rest = v4mapped[1]!;
    // 点分十进制: ::ffff:127.0.0.1
    if (/^\d+\.\d+\.\d+\.\d+$/.test(rest)) {
      return isPrivateIP(rest);
    }
    // Hex 格式: ::ffff:7f00:1 → 每组 hex 拆分为两个字节
    const hexGroups = rest.split(':');
    const ipParts = hexGroups.flatMap(g => {
      const val = parseInt(g, 16);
      return [val >> 8, val & 0xFF];
    });
    return isPrivateIP(ipParts.join('.'));
  }
  // 检查 localhost 变体
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  return false;
}

function isAllowedProtocol(url: URL): boolean {
  return ALLOWED_PROTOCOLS.has(url.protocol);
}

// ─── WebFetchTool ──────────────────────────────────────────────────────────────

export const webFetchTool: ToolDefinition<WebFetchParams, WebFetchResult> = {
  name: 'web_fetch',
  description: 'Fetch web page content from a URL. Returns cleaned text content. URLs are validated against SSRF protection.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch content from (http/https only)' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 10000, max 30000)' },
      maxOutputBytes: { type: 'number', description: 'Maximum output size in bytes (default 10240)' },
      raw: { type: 'boolean', description: 'Return raw HTML instead of cleaned text' },
    },
    required: ['url'],
  },
  harmLevel: 'B',
  requiresApproval: false,

  async execute(params: WebFetchParams, ctx: ToolContext): Promise<WebFetchResult> {
    const startedAt = Date.now();

    // ── Layer 1: URL validation ─────────────────────────────────────────

    // 1a. NFC normalize + strip zero-width chars
    const rawUrl = stripZeroWidth(params.url.normalize('NFC'));
    if (rawUrl.length > MAX_URL_LENGTH) {
      return rejectedFetchResult(params.url, 'TOOLS_INPUT_TOO_LARGE',
        `URL exceeds ${MAX_URL_LENGTH} chars`);
    }

    // 1b. URL parse
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return rejectedFetchResult(params.url, 'WEB_FETCH_INVALID_URL', 'invalid URL format');
    }

    // 1c. Protocol whitelist
    if (!isAllowedProtocol(parsedUrl)) {
      ctx.audit('web_fetch.blocked', { url: rawUrl, reason: 'protocol', protocol: parsedUrl.protocol });
      return rejectedFetchResult(rawUrl, 'WEB_FETCH_PROTOCOL_BLOCKED',
        `protocol "${parsedUrl.protocol}" is not allowed`);
    }

    // 1d. SSRF check
    if (isPrivateIP(parsedUrl.hostname)) {
      ctx.audit('web_fetch.blocked', { url: rawUrl, reason: 'ssrf', hostname: parsedUrl.hostname });
      return rejectedFetchResult(rawUrl, 'WEB_FETCH_SSRF_BLOCKED',
        `URL resolves to internal/private network address: ${parsedUrl.hostname}`);
    }

    // 1e. Abort check before network
    if (ctx.signal.aborted) {
      return rejectedFetchResult(rawUrl, 'WEB_FETCH_CANCELLED', 'operation cancelled');
    }

    // ── Layer 2: HTTP request ───────────────────────────────────────────

    const timeout = (params.timeout && params.timeout >= MIN_TIMEOUT_MS)
      ? Math.min(params.timeout, MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    let response: Response;
    try {
      response = await fetch(rawUrl, {
        signal: controller.signal,
        redirect: 'manual',  // Manual redirect tracking for SSRF re-check
        headers: { 'User-Agent': 'zai.vim/1.0 (AI agent web fetch)' },
      });
    } catch (err) {
      clearTimeout(timeoutId);
      ctx.signal.removeEventListener('abort', onAbort);
      if (controller.signal.aborted) {
        const isCancel = ctx.signal.aborted;
        return rejectedFetchResult(rawUrl,
          isCancel ? 'WEB_FETCH_CANCELLED' : 'WEB_FETCH_TIMEOUT',
          isCancel ? 'operation cancelled' : `request exceeded ${timeout}ms timeout`);
      }
      return rejectedFetchResult(rawUrl, 'WEB_FETCH_ERROR',
        `fetch failed: ${(err as Error).message}`);
    }
    clearTimeout(timeoutId);
    ctx.signal.removeEventListener('abort', onAbort);

    // ── Layer 3: Redirect following with SSRF re-check ──────────────────

    let redirects = 0;
    while ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects++ >= MAX_REDIRECTS) {
        return rejectedFetchResult(rawUrl, 'WEB_FETCH_TOO_MANY_REDIRECTS',
          `exceeded ${MAX_REDIRECTS} redirects`);
      }

      const location = response.headers.get('location');
      if (!location) {
        return rejectedFetchResult(rawUrl, 'WEB_FETCH_ERROR', 'redirect without Location header');
      }

      const redirectUrl = new URL(location, rawUrl);
      if (!isAllowedProtocol(redirectUrl)) {
        return rejectedFetchResult(rawUrl, 'WEB_FETCH_PROTOCOL_BLOCKED',
          `redirect to forbidden protocol: ${redirectUrl.protocol}`);
      }
      if (isPrivateIP(redirectUrl.hostname)) {
        ctx.audit('web_fetch.blocked', { url: rawUrl, reason: 'ssrf_redirect', hostname: redirectUrl.hostname });
        return rejectedFetchResult(rawUrl, 'WEB_FETCH_SSRF_BLOCKED',
          `redirect target is internal address: ${redirectUrl.hostname}`);
      }

      // Check for cancellation before each redirect fetch
      if (ctx.signal.aborted) {
        return rejectedFetchResult(rawUrl, 'WEB_FETCH_CANCELLED', 'operation cancelled');
      }

      try {
        response = await fetch(redirectUrl.toString(), {
          signal: controller.signal,
          redirect: 'manual',
          headers: { 'User-Agent': 'zai.vim/1.0 (AI agent web fetch)' },
        });
      } catch (err) {
        if (controller.signal.aborted) {
          const isCancel = ctx.signal.aborted;
          return rejectedFetchResult(rawUrl,
            isCancel ? 'WEB_FETCH_CANCELLED' : 'WEB_FETCH_TIMEOUT',
            isCancel ? 'operation cancelled' : `request exceeded ${timeout}ms timeout`);
        }
        return rejectedFetchResult(rawUrl, 'WEB_FETCH_ERROR',
          `redirect fetch failed: ${(err as Error).message}`);
      }
    }

    // ── Layer 4: Response validation ────────────────────────────────────

    // 4a. Non-200 status
    if (!response.ok) {
      return {
        url: rawUrl, content: '', contentType: '', statusCode: response.status,
        truncated: false, size: 0, elapsed: Date.now() - startedAt,
        errorCode: `WEB_FETCH_ERROR: HTTP ${response.status}`,
      };
    }

    // 4b. Content-Type check
    const contentType = response.headers.get('content-type') || 'text/plain';
    const mimeType = (contentType.split(';')[0] ?? '').trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(mimeType) && !mimeType.startsWith('text/')) {
      return rejectedFetchResult(rawUrl, 'WEB_FETCH_CONTENT_TYPE_BLOCKED',
        `content type "${mimeType}" is not allowed`);
    }

    // 4c. Content-Length pre-check (5MB hard limit)
    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_RESPONSE_BYTES) {
      return rejectedFetchResult(rawUrl, 'WEB_FETCH_RESPONSE_TOO_LARGE',
        `response body ${contentLength} exceeds ${MAX_RESPONSE_BYTES} limit`);
    }

    // ── Layer 5: Read body with streaming truncation ────────────────────

    let rawBody: string;
    let rawSize = 0;
    let truncated = false;
    const maxOutput = params.maxOutputBytes ?? MAX_OUTPUT_BYTES;

    try {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      const readLimit = maxOutput + 1024;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        chunks.push(chunk);
        rawSize += Buffer.byteLength(chunk, 'utf-8');

        // 5MB hard limit mid-stream
        if (rawSize > MAX_RESPONSE_BYTES) {
          reader.cancel();
          return rejectedFetchResult(rawUrl, 'WEB_FETCH_RESPONSE_TOO_LARGE',
            `response body exceeds ${MAX_RESPONSE_BYTES} limit`);
        }

        // Stop early once we have enough for truncation
        if (rawSize > readLimit) {
          truncated = true;
          reader.cancel();
          break;
        }
      }

      rawBody = chunks.join('');
      rawSize = Buffer.byteLength(rawBody, 'utf-8');
    } catch (err) {
      return rejectedFetchResult(rawUrl, 'WEB_FETCH_ERROR',
        `failed to read response body: ${(err as Error).message}`);
    }

    let content: string;

    if (truncated || rawSize > maxOutput) {
      // Align truncation to UTF-8 boundary + newline
      let capPos = maxOutput;
      while (capPos > 0 && rawBody[capPos] !== '\n') capPos--;
      if (capPos === 0) capPos = maxOutput;
      while (capPos > 0 && (rawBody.charCodeAt(capPos) & 0xC0) === 0x80) capPos--;

      const origSize = contentLength || rawSize;
      content = rawBody.slice(0, capPos);
      content += `\n... [truncated, original size: ${Math.round(origSize / 1024)}KB]`;
      truncated = true;
    } else {
      content = rawBody;
    }

    // ── Layer 6: HTML → text conversion ────────────────────────────────

    if (!params.raw && mimeType.includes('html')) {
      content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    const elapsed = Date.now() - startedAt;
    ctx.audit('web_fetch', {
      url: params.url, statusCode: response.status, contentType: mimeType,
      size: rawSize, outputSize: Buffer.byteLength(content, 'utf-8'),
      truncated, elapsed,
    });

    return {
      url: rawUrl,
      content,
      contentType: mimeType,
      statusCode: response.status,
      truncated,
      size: rawSize,
      elapsed,
    };
  },
};

// ─── WebSearchTool ─────────────────────────────────────────────────────────────

export const webSearchTool: ToolDefinition<WebSearchParams, WebSearchResult> = {
  name: 'web_search',
  description: 'Search the web for information. Returns a list of search results with title, URL, and snippet.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query string (max 500 chars)' },
      maxResults: { type: 'number', description: 'Maximum number of results (1-10, default 10)' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 10000, max 30000)' },
    },
    required: ['query'],
  },
  harmLevel: 'C',
  requiresApproval: false,

  async execute(params: WebSearchParams, ctx: ToolContext): Promise<WebSearchResult> {
    const startedAt = Date.now();

    // ── Layer 1: Query validation ──────────────────────────────────────

    const query = stripZeroWidth(params.query.normalize('NFC'));
    if (query.length > MAX_QUERY_LENGTH) {
      return {
        query, results: [], totalResults: 0, elapsed: 0, truncated: false,
        errorCode: `TOOLS_INPUT_TOO_LARGE: query exceeds ${MAX_QUERY_LENGTH} chars`,
      };
    }

    const maxResults = Math.min(Math.max(params.maxResults ?? MAX_SEARCH_RESULTS, 1), MAX_SEARCH_RESULTS);
    const timeout = (params.timeout && params.timeout >= MIN_TIMEOUT_MS)
      ? Math.min(params.timeout, MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

    // ── Layer 2: Abort check ───────────────────────────────────────────

    if (ctx.signal.aborted) {
      return {
        query, results: [], totalResults: 0,
        elapsed: Date.now() - startedAt, truncated: false,
        errorCode: 'WEB_FETCH_CANCELLED: operation cancelled',
      };
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // ── Layer 3: Search execution ──────────────────────────────────────

    const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;

    let response: Response;
    try {
      response = await fetch(searchUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'zai.vim/1.0 (AI agent web search)' },
      });
    } catch (err) {
      clearTimeout(timeoutId);
      ctx.signal.removeEventListener('abort', onAbort);
      if (controller.signal.aborted) {
        const isCancel = ctx.signal.aborted;
        return {
          query, results: [], totalResults: 0,
          elapsed: Date.now() - startedAt, truncated: false,
          errorCode: isCancel ? 'WEB_FETCH_CANCELLED: operation cancelled' : `WEB_FETCH_TIMEOUT: request exceeded ${timeout}ms timeout`,
        };
      }
      return {
        query, results: [], totalResults: 0,
        elapsed: Date.now() - startedAt, truncated: false,
      };
    }
    clearTimeout(timeoutId);
    ctx.signal.removeEventListener('abort', onAbort);

    if (!response.ok) {
      ctx.audit('web_search.error', { query, statusCode: response.status });
      return {
        query, results: [], totalResults: 0,
        elapsed: Date.now() - startedAt, truncated: false,
      };
    }

    let html: string;
    try {
      html = await response.text();
    } catch {
      return {
        query, results: [], totalResults: 0,
        elapsed: Date.now() - startedAt, truncated: false,
      };
    }

    // ── Layer 4: Parse DDG Lite results ────────────────────────────────

    const linkRegex = /<a[^>]+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
    const results: SearchResultItem[] = [];
    const links = [...html.matchAll(linkRegex)];

    let count = 0;
    for (const match of links) {
      if (count >= maxResults) break;
      const url = match[1]!;
      const title = match[2]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

      if (url.includes('duckduckgo.com') || !url.startsWith('http')) continue;

      results.push({
        title: title.trim() || 'Untitled',
        url,
        snippet: '',
      });
      count++;
    }

    const elapsed = Date.now() - startedAt;
    ctx.audit('web_search', {
      query, resultCount: results.length, totalResults: results.length, elapsed,
    });

    return {
      query,
      results,
      totalResults: results.length,
      elapsed,
      truncated: links.length > maxResults,
    };
  },
};
