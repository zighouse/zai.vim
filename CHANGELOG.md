# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-06-13

### Added

#### Epic 2: Security Infrastructure (MVP)

**Story 2-1: bwrap Sandbox Manager**
- Bubblewrap sandbox management with availability detection
- Platform degradation fallback (Linux→bwrap, macOS→partial, other→disabled)
- Sandbox configuration via project YAML (`.zaivim/project.yaml`)
- Shell tool placeholder registration for sandboxed execution
- Capability descriptor (bwrap version, features, available directories)

**Story 2-2: Harm Classification and Security Visibility**
- S/A/B/C four-level harm classification for shell commands and file operations
- `SecurityProvider` with `preExecute`/`postExecute` lifecycle hooks
- `OverrideManager` for user override of S-level rejections
- `SecurityMonitor` with real-time dash: harm-level counts, active overrides, bypass tracking
- Session-scoped throttling: 3 overrides/min → 3s cool-down per session

**Story 2-3: JSONL Audit Log**
- Append-only JSONL audit log with async batched writes (50ms/500 events)
- `Auditor` with severity A/B/C levels and session scoping
- `AuditMiddleware` for pipeline integration
- Audit query/filter/summary APIs with pagination
- Sensitive data redaction (***REDACTED***) for API keys and paths
- Token Bucket rate limiter (150 events/s, burst 200)
- Auto-rotation at 100MB per log file

**Story 2-4: Security Execution Integration**
- **Agent cancel cascade**: PID tracking → process group SIGTERM → 5s SIGKILL → 30/60/120s orphan scans → A-level alert. 14 subtasks including idempotency, PID reuse safety, EPERM fallback, partial cancel tolerance.
- **TOCTOU-safe path validation**: `fs.promises.open()` + `/proc/self/fd` cross-verification + `SealedFileHandle` pattern. `.git` boundary enforcement (fail-closed). Semaphore concurrency limiter (3 normal + 1 fast lane, anti-starvation).
- **Timing side-channel protection**: Uniform ≥10ms async `setTimeout` padding for ALL paths (valid and rejected). Unified `'access denied'` error message with sub-codes. Statistical verification with 200 iterations (mean diff &lt;0.5ms, KS distribution overlap).
- **Unicode path normalization**: Platform-adaptive NFC/NFD. Zero-width/bidi/confusable character detection. Skeleton homoglyph detection for Cyrillic/Greek/Latin.
- **ESLint AC8 enforcement**: `no-restricted-imports` blocking `@zaivim/tools` → `@zaivim/engine` imports. Verified prevents bypass of ISecurityProvider contact-point constraint.

### Changed

- Version bump: All `@zaivim/*` packages bumped from 0.1.1 to 0.1.2
- Stub packages (`@zaivim/vim-adapter`, `@zaivim/browser-ext`) remain at 0.0.0
- `ToolContext` interface: `spawn()` method added for controlled child process creation (PID tracking support)

### Security

- Path validation now has TOCTOU race protection via `/proc/self/fd` cross-verification
- Timing side-channel: all path validation responses padded to ≥10ms uniform delay
- Access denied: unified error message `'access denied'` with structured sub-codes for forensic audit
- Agent cancel cascade: process group termination ensures no orphaned child processes
- ISecurityProvider is now non-bypassable — tools cannot import engine directly (ESLint enforced)

### Fixed

- SealedFileHandle fd prematurely closed (CRITICAL): refactored to store `FileHandle` directly, preventing fd reuse after creator's premature `close()`
- Timing side-channel sync/async discrepancy: `rejectWithTiming` changed from sync busy-wait to async `setTimeout`, matching `padTiming`
- Audit type safety: removed `as any` casts from all `auditor.write()` calls, added `timestamp` field
- Test mock isolation: `vi.hoisted()` pattern for shared mock factories prevents cross-test pollution

### Technical Details

Test Coverage:
- Engine: 642 tests passing (41 files)
- Core: 65+ tests passing
- Total: 707+ tests passing

New tests for Story 2.4:
- Agent cancel cascade: 17 tests (PID tracking, SIGTERM, SIGKILL, timeout, audit, idempotency, cleanup)
- Semaphore concurrency: 11 tests (slot acquisition, queue, timeout, fast lane, rate-limit)
- Path validation: 28 tests (TOCTOU, boundary, confusable/bidi, SealedFileHandle lifecycle, fail-closed)
- Timing side-channel: 6 statistical tests (200 iterations, mean diff &lt;0.5ms, distribution overlap)
- Performance constraints: 9 tests (semaphore concurrency, health check, anti-starvation)

Package Versions:
- @zaivim/core: 0.1.2
- @zaivim/engine: 0.1.2
- @zaivim/tools: 0.1.2
- @zaivim/skills: 0.1.2
- @zaivim/gateway: 0.1.2
- @zaivim/tui: 0.1.2
- @zaivim/vim-adapter: 0.0.0 (stub)
- @zaivim/browser-ext: 0.0.0 (stub)

Epic 2 Deliverables:
- Complete security infrastructure: sandbox → harm classification → audit → execution integration
- SecurityProvider chain is non-bypassable (ESLint AC8 enforced)
- All 4 stories implemented, all acceptance criteria met (Growth items deferred)
- Adversarial code review: 10 issues found and fixed before merge

## [0.1.1] - 2026-06-10

### Added

#### Epic 1b: AI Chat Pipeline (MVP)

**Story 1b-1: Provider Registry and API Key Management**
- Multiple provider configuration via YAML (~/.zaivim/assistants.yaml)
- Environment variable support for API keys ($VAR_NAME)
- Automatic API key redaction from logs (***REDACTED***)
- Lazy provider validation (first-use verification)
- Automatic provider fallback on failure
- Protocol type recording (openai-compatible / anthropic-native)
- Provider status management (untested / unavailable / available / degraded)

**Story 1b-2: SSE Streaming Chat Pipeline**
- Full streaming chat pipeline with AsyncIterable<ResponseChunk>
- First token latency ≤2s (NFR1)
- Chunk interval ≤50ms (NFR2)
- Tool call execution loop (max 20 rounds)
- Context assembly with token trimming (≤80% threshold)
- System prompt injection
- AbortSignal cancellation support (≤100ms propagation)
- Streaming interruption notifications (chat.interrupted)
- Error classification (recoverable/non-recoverable)
- NullSecurityProvider fallback for E2 (not yet implemented)

**Story 1b-3: Multi-Session Concurrency**
- Multiple concurrent session management (3+ sessions)
- File attachments as message context
- Historical session recovery from JSONL (last 100 messages)
- Session list pagination (limit/offset/sortBy)
- Token trimming with 4-level priority (system → pinned → recent10 → FIFO)
- Message pinned marks for preservation
- Session lifecycle integration (message limit notifications)
- Concurrent chat() with message isolation

**Story 1b-4: Project Context Detection**
- Automatic project root detection (.git > package.json > pnpm-workspace.yaml)
- Project metadata scanning (language, framework, package manager)
- Monorepo workspace detection
- Framework detection (React, Vue, Express, NestJS, etc.)
- Config file scanning
- Project context injection into system prompt
- Project context update detection (mtime-based)
- zaivim project-context CLI command
- Symlink path resolution for security

**Story 1b-5: Provider Fault Handling and Retry**
- Exponential backoff retry (1s → 2s → 4s, max 3 retries)
- 5xx vs 4xx error classification
- Provider fallback (automatic switch to next available)
- Cross-session rate limit coordination (429 handling)
- context_length_exceeded auto-trim retry (50% token budget)
- Provider degraded status recovery
- Retry notification events
- Jitter for thundering herd prevention

**Story 1b-6: CLI Interactive Chat**
- zaivim chat interactive REPL with readline
- Markdown terminal rendering (code blocks, bold, lists)
- Engine auto-start on demand (daemon mode + health polling)
- Historical session recovery (--session <id>)
- JSON pipe mode (--json, NDJSON output)
- Multiline input continuation (trailing \)
- Special commands (/help, /sessions, /new, /switch)
- Ctrl+C handling (cancel request → exit on second press)
- Project directory association (--project-dir)

### Changed

- Version bump: All @zaivim/* packages bumped from 0.1.0 to 0.1.1
- Stub packages: @zaivim/vim-adapter and @zaivim/browser-ext remain at 0.0.0

### Fixed

- Engine launcher path validation and fallbacks for daemon CLI resolution
- Process liveness verification with signal 0 for engine health check
- Engine stderr surfacing on daemon auto-start failure
- Continuation prompt display during multiline input (AC6)
- Multiline continuation mode race condition prevention
- Session close on /exit and /quit commands
- Provider fallback recursive implementation through all available providers (AC5)
- Rate limit coordination across sessions (AC6)
- Context length exceeded auto-trim retry (AC10)
- Project context preservation during token trimming
- Project context marker path resolution against projectRoot
- Session.recovered event emission for all recovery types
- Symlink path traversal prevention in resolveAttachments
- Byte-accurate truncation with Buffer.subarray() in attachments
- Session.recovered event forwarding in Pipeline Engine
- Duplicate lastActivityAt calculation extraction to shared helper
- Dead chat() stub replacement with explicit error in lifecycle engine
- HTTPS enforcement for provider connections (AC13 Red Team)
- AbortSignal + timeout combination in executeToolCall (AC14)
- Tool call metadata preservation in final assistant message
- Chunk interval monitoring in chat() pipeline (AC3)
- Abort propagation latency monitoring (AC6)
- SSE format validation integration into chat() flow (AC7)
- Protocol field addition to mock-provider capabilities
- Partial response persistence prevention (AC11)
- Tool call timeout protection (AC14)

### Technical Details

Test Coverage:
- Core: 65 tests passing
- Engine: 500+ tests passing
- Gateway: 110+ tests passing
- Total: 1674+ tests passing

Package Versions:
- @zaivim/core: 0.1.1
- @zaivim/engine: 0.1.1
- @zaivim/tools: 0.1.1
- @zaivim/skills: 0.1.1
- @zaivim/gateway: 0.1.1
- @zaivim/tui: 0.1.1
- @zaivim/vim-adapter: 0.0.0 (stub)
- @zaivim/browser-ext: 0.0.0 (stub)

Epic 1b Deliverables:
- Complete AI chat pipeline from provider management to streaming responses
- Multi-session concurrency with file attachments
- Project context detection and injection
- Provider fault tolerance and retry
- Interactive CLI chat with markdown rendering

## [0.1.0] - 2026-06-06

### Added

#### Epic 1a: Engine Daemon and Infrastructure (MVP)

- Engine daemon lifecycle (start, stop, status, health check)
- PID file management with stale detection
- Graceful shutdown (≤10s, wait for agents)
- Instance conflict detection
- JSON-RPC 2.0 over stdio
- Session management (InMemory + JSONL persistence)
- Session lifecycle management (TTL, disconnect detection)
- Project directory association
- Configuration loading with Python migration
- Environment variable resolution
- CLI commands: serve, status, ping, stop
- EventEmitter for runtime events
- Method-level ACL for JSON-RPC methods

### Security

- PID file permission 0600 (engine daemon)
- Admin token generation for protected methods
- Method permission levels (public, session-scoped, admin)
- Localhost-only restrictions for admin methods

### Technical Details

Test Coverage:
- 300+ unit tests covering core modules
- All smoke tests passing

Package Versions:
- All @zaivim/* packages: 0.1.0
- Initial release of Node.js migration MVP

Epic 1a Deliverables:
- Engine daemon with health check endpoint
- Session persistence and recovery
- JSON-RPC transport layer
- Configuration system with migration
- CLI commands for lifecycle management
