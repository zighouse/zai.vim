# Changelog

All notable changes to zai.vim will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-06-07

### Node.js Engine Foundation

This is the first milestone of the Python-to-Node.js/TypeScript migration. The Node.js engine runs as a standalone daemon alongside the existing Python backend — both can coexist during the transition period.

**Why migrate?** The Python engine serves today's users well, but the next generation of features — multi-agent orchestration, multi-client access (TUI + browser), and a skill ecosystem — require a concurrency model and type system that Node.js/TypeScript provides natively. The migration is incremental: the Python engine remains fully functional, and the Node.js engine will gradually take over responsibilities as it matures.

### Added

- **pnpm monorepo** with 8 packages under the `@zaivim` scope:
  - `@zaivim/core` — shared type definitions, JSON-RPC 2.0 protocol, error codes (zero external dependencies)
  - `@zaivim/engine` — engine lifecycle, configuration loading, session management, provider registry
  - `@zaivim/gateway` — CLI entry point (`zaivim serve`/`stop`/`ping`), stdio JSON-RPC transport
  - `@zaivim/tools` — tool registry and interfaces (file, grep, shell, web)
  - `@zaivim/skills` — skill adapter, loader, and registry
  - `@zaivim/tui` — terminal UI client (ink-based, scaffolded)
  - `@zaivim/vim-adapter` — Vim integration layer (scaffolded)
  - `@zaivim/browser-ext` — browser extension (scaffolded)

- **Engine daemon lifecycle** (`zaivim serve` / `zaivim stop` / `zaivim ping`)
  - Startup with state machine (booting → ready → shutting_down → stopped)
  - PID file management with instance conflict detection
  - Graceful shutdown with staged sequencer (drain → persist → cleanup)
  - SIGTERM / SIGINT / stdin-end handling
  - Foreground and daemon modes

- **JSON-RPC 2.0 transport over stdio**
  - Full JSON-RPC 2.0 message parsing (request, response, notification, batch)
  - Method-level ACL (public / session-scoped / admin)
  - Admin token authentication via file-based secret
  - Multi-client connection management with broadcast
  - Event listener leak prevention and cleanup

- **Session management and persistence**
  - `ISessionStore` interface with `JsonlSessionStore` implementation
  - JSONL append-only persistence (ADR-4)
  - TTL-based expiry with reconnection window
  - Message count limits with automatic pruning
  - Crash recovery: last N messages restored after SIGKILL simulation

- **Configuration system**
  - Loads `~/.zaivim/assistants.yaml` (user-level) and `.zaivim/project.yaml` (project-level)
  - Environment variable substitution (`$API_KEY` → resolved at load time)
  - Automatic migration from legacy Python config (`~/.zaivimrc.yaml`, `zai.project/zai_project.yaml`)
  - Three-tier degradation: valid config → backup restore → safe defaults
  - YAML comment stripping and field normalization for compatibility
  - API key redaction in logs (`***REDACTED***`)

- **300+ unit tests** across core, engine, and gateway packages
- **End-to-end smoke tests** verifying the full daemon lifecycle

### Changed

- Package versions bumped from `0.0.1` to `0.1.0` across all `@zaivim/*` packages

### Note

The Python engine (`python3/aichat.py`, `python3/client.py`, etc.) is **unchanged** and remains the primary runtime for existing zai.vim users. The Node.js engine does not yet handle AI chat — that capability arrives in the next epic (Epic 1b: AI Conversation Pipeline).

---

[0.1.0]: https://github.com/zighouse/zai.vim/releases/tag/v0.1.0
