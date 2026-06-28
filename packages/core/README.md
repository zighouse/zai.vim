# @zaivim/core

Core types, JSON-RPC 2.0 protocol, and error system for zai.vim — an AI agent engine platform.

**Zero external runtime dependencies.** Type definitions only — safe for any TypeScript project.

## Install

```bash
npm install @zaivim/core
# or
pnpm add @zaivim/core
# or
yarn add @zaivim/core
```

## Usage

### Minimal protocol example

```typescript
import {
  encodeLine,
  decode,
  isRequest,
  successResponse,
  errorResponse,
} from '@zaivim/core';
import type { JsonRpcMessage } from '@zaivim/core';

// Encode a JSON-RPC request
const request = encodeLine({
  jsonrpc: '2.0',
  id: 1,
  method: 'health',
});
// '{"jsonrpc":"2.0","id":1,"method":"health"}\n'

// Decode and type-narrow a response
const raw = '{"jsonrpc":"2.0","id":1,"result":{"status":"ok"}}';
const msg: JsonRpcMessage = decode(raw);

if (isRequest(msg)) {
  console.log('method:', msg.method);
} else if ('result' in msg) {
  console.log('result:', msg.result);
}

// Build error responses
const err = errorResponse(null, -32700, 'Parse error');
console.log(encodeLine(err)); // typed JsonRpcError
```

### Type checking with interface harness

```typescript
import type { ResponseChunk, AgentHandle, Message } from '@zaivim/core';

// Verify all ResponseChunk variants are handled
function handleChunk(chunk: ResponseChunk): string {
  switch (chunk.type) {
    case 'text':      return chunk.content;
    case 'done':      return `finished: ${chunk.finishReason}`;
    case 'tool_call': return `calling: ${chunk.name}`;
    case 'error':     return `error: ${chunk.message}`;
    default:          return exhaustivenessCheck(chunk);
  }
}
function exhaustivenessCheck(_: never): never { throw new Error('unreachable'); }
```

## API Overview

| Category | Key Types |
|----------|-----------|
| **Session** | `Session`, `SessionStatus`, `ISessionStore` |
| **Message** | `Message`, `MessageRole`, `ToolCall` |
| **Streaming** | `ResponseChunk`, `ThinkingPhase`, `SessionPhase` |
| **Agent** | `AgentHandle`, `AgentPool`, `AgentResult`, `PersonaConfig` |
| **Provider** | `IProvider`, `ProviderChatRequest`, `ProviderCapabilities` |
| **Tool** | `ToolDefinition<T,R>`, `ToolContext`, `ShellParams`, `WebFetchParams` |
| **Security** | `ISecurityProvider`, `HarmLevel`, `FileChangeProposal` |
| **Engine** | `EngineAPI`, `EngineHealth`, `EngineConfig`, `EngineState` |
| **Error** | `ZaiError`, `ZaiNetworkError`, `ZaiToolError` (+8 subclasses) |
| **Protocol** | `JsonRpcMessage`, `encode()`, `decode()`, `isRequest()`, `isResponse()` |
| **Skill** | `SkillAdapter`, `SkillInput`, `SkillOutput` |
| **Config** | `ZaiConfig`, `SandboxConfig`, `ProviderConfig` |
| **Pipeline** | `PipelineConfig`, `ChatResult` |

## Packages

`@zaivim/core` is part of the **zai.vim** monorepo:

| Package | Description |
|---------|-------------|
| `@zaivim/core` | Types, protocol, errors (zero deps) |
| `@zaivim/engine` | AI provider registry, chat pipeline, sandbox |
| `@zaivim/tools` | File, shell, web tool implementations |
| `@zaivim/skills` | Plugin/Skill system |
| `@zaivim/gateway` | Vim/CLI/HTTP/WebSocket transport |
| `@zaivim/tui` | Terminal UI (React Ink) |

## License

MIT
