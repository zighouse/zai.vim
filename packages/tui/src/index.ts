#!/usr/bin/env node
// @zaivim/tui — CLI entry: terminal UI for zaivim
// Spawns an in-process engine and renders the ink/React TUI.

import { Engine } from '@zaivim/engine';
import { ZaiConfigError } from '@zaivim/core';
import { createTuiClient } from './client.js';
import { createTuiStore } from './store.js';
import { renderTuiApp } from './app.js';

interface TuiOptions {
  sessionId?: string;
}

/**
 * Create the pipeline Engine instance for TUI.
 */
function getEngine(): Engine {
  try {
    return new Engine();
  } catch (err) {
    if (err instanceof ZaiConfigError) {
      console.error(`Configuration error: ${err.message}`);
    } else {
      console.error(`Failed to start engine: ${(err as Error).message}`);
    }
    process.exit(1);
  }
}

export async function startTui(options?: TuiOptions): Promise<void> {
  const engine = getEngine();

  // Create JSON-RPC-like client wrapping EngineAPI
  const client = createTuiClient(engine);

  // Create store
  const store = createTuiStore();

  // Render ink app
  const { waitUntilExit } = renderTuiApp(store, client);

  // Handle signals
  const cleanup = async () => {
    // Persist all sessions
    for (const session of store.getState().sessions.values()) {
      try {
        await engine.closeSession(session.id);
      } catch {
        // best-effort
      }
    }
  };

  const shutdown = async () => {
    await cleanup();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);

  // Wait until user exits
  try {
    await waitUntilExit();
  } finally {
    await cleanup();
  }
}

// ---- Direct CLI invocation ---------------------------------------------------

function parseArgs(): TuiOptions {
  const args = process.argv.slice(2);
  const opts: TuiOptions = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session' && args[i + 1]) {
      opts.sessionId = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`zaivim-tui v${VERSION} — Terminal UI for zaivim

Usage: zaivim tui [options]

Options:
  --session <id>    Resume an existing session
  --help, -h        Show this help
`);
      process.exit(0);
    }
  }
  return opts;
}

// Entry point when run directly
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('/dist/cli.js') ||
  process.argv[1].endsWith('/src/index.ts')
);
if (isMainModule) {
  const opts = parseArgs();
  startTui(opts).catch((err) => {
    console.error('TUI error:', err);
    process.exit(1);
  });
}
