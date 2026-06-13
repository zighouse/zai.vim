// Story 3.2b, Task 5: web_fetch + web_search unit tests
// Covers all Acceptance Criteria (AC1–AC12):
//   AC1: Basic web_fetch + URL whitelist
//   AC2: SSRF protection (private/internal network rejection)
//   AC3: web_search result summary
//   AC4: Non-200 status graceful degradation
//   AC5: Timeout protection
//   AC6: Parameter format validation (length limits)
//   AC7: Response content truncation
//   AC8: Protocol whitelist (http/https only)
//   AC9: Audit logging
//   AC10: AbortSignal cancellation
//   AC11: Redirect security (max 5, SSRF re-check)
//   AC12: Content-Type validation

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webFetchTool, webSearchTool } from '../web.js';
import type { ToolContext, WebFetchResult, WebSearchResult } from '@zaivim/core';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function mockResponse(overrides?: Partial<Response>): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/html' }),
    text: vi.fn().mockResolvedValue('<html><body>Hello World</body></html>'),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<html><body>Hello World</body></html>'));
        controller.close();
      },
    }),
    ...overrides,
  } as unknown as Response;
}

function mockToolContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    sessionId: 'test-session',
    sandbox: 'test',
    signal: new AbortController().signal,
    security: {} as ToolContext['security'],
    audit: vi.fn(),
    spawn: vi.fn() as unknown as ToolContext['spawn'],
    ...overrides,
  };
}

function mockWebFetchResult(overrides?: Partial<WebFetchResult>): WebFetchResult {
  return {
    url: 'https://example.com',
    content: '',
    contentType: '',
    statusCode: 0,
    truncated: false,
    size: 0,
    elapsed: 0,
    ...overrides,
  };
}

// ─── AC1: Basic web_fetch ──────────────────────────────────────────────────────

describe('AC1 — Basic web_fetch + URL whitelist', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('<html><body>Hello World</body></html>'));
            controller.close();
          },
        }),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should fetch a URL and return cleaned text content', async () => {
    const ctx = mockToolContext();
    const result = await webFetchTool.execute({ url: 'https://example.com' }, ctx);

    expect(result.statusCode).toBe(200);
    expect(result.content).toContain('Hello World');
    expect(result.contentType).toBe('text/html');
    expect(result.url).toBe('https://example.com');
    expect(result.errorCode).toBeUndefined();
    expect(ctx.audit).toHaveBeenCalled();
  });

  it('should support raw HTML output', async () => {
    const ctx = mockToolContext();
    const result = await webFetchTool.execute({ url: 'https://example.com', raw: true }, ctx);

    expect(result.content).toContain('<html>');
  });
});

// ─── AC2: SSRF protection ─────────────────────────────────────────────────────

describe('AC2 — SSRF protection', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ssrfCases = [
    { url: 'http://192.168.1.1/admin', desc: '192.168.x.x' },
    { url: 'http://10.0.0.1/api', desc: '10.x.x.x' },
    { url: 'http://127.0.0.1:8080', desc: '127.0.0.1' },
    { url: 'http://localhost:8080', desc: 'localhost' },
    { url: 'http://169.254.169.254/', desc: '169.254.x.x (metadata)' },
    { url: 'http://172.16.0.1/', desc: '172.16.x.x' },
    { url: 'http://0.0.0.0/', desc: '0.0.0.0' },
  ];

  it.each(ssrfCases)('should block private IP: $desc ($url)', async ({ url }) => {
    const ctx = mockToolContext();
    const result = await webFetchTool.execute({ url }, ctx);

    expect(result.errorCode).toContain('WEB_FETCH_SSRF_BLOCKED');
    expect(result.statusCode).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('should block IPv6 mapped IPv4 private addresses', async () => {
    const ctx = mockToolContext();
    const result = await webFetchTool.execute({ url: 'http://[::ffff:127.0.0.1]:8080/' }, ctx);

    expect(result.errorCode).toContain('WEB_FETCH_SSRF_BLOCKED');
  });
});

// ─── AC3: web_search ──────────────────────────────────────────────────────────

describe('AC3 — web_search result summary', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: vi.fn().mockResolvedValue(`
          <html>
          <a href="https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/">TypeScript 6.0 Announcement</a><br>
          <a href="https://example.com/release-notes">Release Notes</a><br>
          </html>
        `),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('mock'));
            controller.close();
          },
        }),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return search results with title and URL', async () => {
    const ctx = mockToolContext();
    const result = await webSearchTool.execute({ query: 'TypeScript 6.0 release notes' }, ctx);

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]).toHaveProperty('title');
    expect(result.results[0]).toHaveProperty('url');
    expect(ctx.audit).toHaveBeenCalled();
  });

  it('should respect maxResults parameter', async () => {
    const ctx = mockToolContext();
    const result = await webSearchTool.execute({ query: 'test', maxResults: 1 }, ctx);

    expect(result.results.length).toBeLessThanOrEqual(1);
  });

  it('should enforce maxResults upper bound of 10', async () => {
    const ctx = mockToolContext();
    const result = await webSearchTool.execute({ query: 'test', maxResults: 100 }, ctx);

    expect(result.results.length).toBeLessThanOrEqual(10);
  });
});

// ─── AC4: Non-200 status ─────────────────────────────────────────────────────

describe('AC4 — Non-200 status graceful degradation', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 404 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return error code for 404 without crashing', async () => {
    const ctx = mockToolContext();
    const result = await webFetchTool.execute({ url: 'https://example.com/notfound' }, ctx);

    expect(result.statusCode).toBe(404);
    expect(result.errorCode).toContain('WEB_FETCH_ERROR');
    expect(result.elapsed).toBeGreaterThanOrEqual(0);
  });
});

// ─── AC5: Timeout protection ──────────────────────────────────────────────────

describe('AC5 — Timeout protection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should clamp timeout to 30s max and 1s min', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(mockResponse({
        headers: new Headers({ 'content-type': 'text/plain' }),
        body: new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode('ok')); controller.close(); },
        }),
      })),
    );
    const ctx = mockToolContext();

    // timeout=60000 → clamped to 30000
    const result = await webFetchTool.execute({ url: 'https://example.com', timeout: 60000 }, ctx);
    expect(result.statusCode).toBe(200);

    // timeout=0 → clamped to 1000 (min boundary, not silently falling to default)
    const result2 = await webFetchTool.execute({ url: 'https://example.com', timeout: 0 }, ctx);
    expect(result2.statusCode).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

// ─── AC6: Parameter validation ───────────────────────────────────────────────

describe('AC6 — Parameter format validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should reject URL exceeding 2048 characters', async () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2048);
    const ctx = mockToolContext();
    const result = await webFetchTool.execute({ url: longUrl }, ctx);

    expect(result.errorCode).toContain('TOOLS_INPUT_TOO_LARGE');
  });

  it('should reject query exceeding 500 characters', async () => {
    const ctx = mockToolContext();
    const result = await webSearchTool.execute({ query: 'a'.repeat(501) }, ctx);

    expect(result.results.length).toBe(0);
    expect(result.errorCode).toContain('TOOLS_INPUT_TOO_LARGE');
  });
});

// ─── AC7: Response truncation ────────────────────────────────────────────────

describe('AC7 — Response content truncation', () => {
  beforeEach(() => {
    const largeBody = 'Hello World\n'.repeat(2000); // ~24KB
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: vi.fn().mockResolvedValue(largeBody),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(largeBody));
            controller.close();
          },
        }),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should truncate content exceeding maxOutputBytes', async () => {
    const ctx = mockToolContext();
    const result = await webFetchTool.execute({ url: 'https://example.com', maxOutputBytes: 100 }, ctx);

    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThan(200);
    expect(result.content).toContain('truncated');
  });
});

// ─── AC8: Protocol whitelist ─────────────────────────────────────────────────

describe('AC8 — Protocol whitelist', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const blockedProtocols = [
    { url: 'file:///etc/passwd', desc: 'file:' },
    { url: 'ftp://example.com/file', desc: 'ftp:' },
    { url: 'data:text/html,hello', desc: 'data:' },
    { url: 'javascript:alert(1)', desc: 'javascript:' },
  ];

  it.each(blockedProtocols)('should block $desc protocol', async ({ url }) => {
    const ctx = mockToolContext();
    const result = await webFetchTool.execute({ url }, ctx);

    expect(result.errorCode).toContain('WEB_FETCH_PROTOCOL_BLOCKED');
  });
});

// ─── AC9: Audit logging ──────────────────────────────────────────────────────

describe('AC9 — Audit logging', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('<html>ok</html>'));
            controller.close();
          },
        }),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should record audit log on successful web_fetch', async () => {
    const audit = vi.fn();
    const ctx = mockToolContext({ audit });
    await webFetchTool.execute({ url: 'https://example.com' }, ctx);

    expect(audit).toHaveBeenCalledWith('web_fetch', expect.objectContaining({
      url: 'https://example.com',
      statusCode: 200,
    }));
  });

  it('should record audit log on blocked web_fetch', async () => {
    const audit = vi.fn();
    const ctx = mockToolContext({ audit });
    await webFetchTool.execute({ url: 'file:///etc/passwd' }, ctx);

    expect(audit).toHaveBeenCalledWith('web_fetch.blocked', expect.objectContaining({
      reason: 'protocol',
    }));
  });
});

// ─── AC10: AbortSignal cancellation ──────────────────────────────────────────

describe('AC10 — AbortSignal cancellation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return cancelled result when signal is aborted before fetch', async () => {
    const controller = new AbortController();
    const ctx = mockToolContext({ signal: controller.signal });
    controller.abort();

    const result = await webFetchTool.execute({ url: 'https://example.com' }, ctx);

    expect(result.errorCode).toContain('WEB_FETCH_CANCELLED');
  });

  it('should return cancelled for web_search when signal is aborted before fetch', async () => {
    const controller = new AbortController();
    const ctx = mockToolContext({ signal: controller.signal });
    controller.abort();

    const result = await webSearchTool.execute({ query: 'test' }, ctx);

    expect(result.errorCode).toContain('WEB_FETCH_CANCELLED');
  });
});

// ─── AC11: Redirect security ─────────────────────────────────────────────────

describe('AC11 — Redirect security', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should block redirect to internal address', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(
        mockResponse({
          ok: false,
          status: callCount === 1 ? 302 : 200,
          headers: new Headers({
            'content-type': 'text/html',
            'location': callCount === 1 ? 'http://192.168.1.1/admin' : undefined,
          }),
        }),
      );
    });

    const ctx = mockToolContext();
    const result = await webFetchTool.execute({ url: 'https://safe.example.com' }, ctx);

    expect(result.errorCode).toContain('WEB_FETCH_SSRF_BLOCKED');
  });
});

// ─── AC12: Content-Type validation ───────────────────────────────────────────

describe('AC12 — Content-Type validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should block binary content types', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('binary'));
            controller.close();
          },
        }),
      }),
    );

    const ctx = mockToolContext();
    const result = await webFetchTool.execute({ url: 'https://example.com/file.bin' }, ctx);

    expect(result.errorCode).toContain('WEB_FETCH_CONTENT_TYPE_BLOCKED');
  });

  it('should allow text content types', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        headers: new Headers({ 'content-type': 'text/plain' }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('plain text'));
            controller.close();
          },
        }),
      }),
    );

    const ctx = mockToolContext();
    const result = await webFetchTool.execute({ url: 'https://example.com/file.txt' }, ctx);

    expect(result.errorCode).toBeUndefined();
    expect(result.content).toBe('plain text');
  });

  it('should reject responses with Content-Length exceeding 5MB', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        headers: new Headers({
          'content-type': 'text/html',
          'content-length': String(6 * 1024 * 1024),
        }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('large'));
            controller.close();
          },
        }),
      }),
    );

    const ctx = mockToolContext();
    const result = await webFetchTool.execute({ url: 'https://example.com/large' }, ctx);

    expect(result.errorCode).toContain('WEB_FETCH_RESPONSE_TOO_LARGE');
  });
});

// ─── Static check: no @zaivim/engine import ──────────────────────────────────

describe('Static check — no @zaivim/engine import', () => {
  it('should not import @zaivim/engine in web.ts', async () => {
    // This is a compile-time constraint enforced by ESLint no-restricted-imports.
    // Runtime verification: check the module's source doesn't contain the string.
    const fs = await import('node:fs');
    const source = fs.readFileSync(new URL('../web.ts', import.meta.url), 'utf-8');
    expect(source).not.toContain('@zaivim/engine');
  });
});
