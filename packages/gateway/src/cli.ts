#!/usr/bin/env node
// @zaivim/gateway — CLI entry point
// Uses Node 22 util.parseArgs() — zero external dependencies for MVP

import { parseArgs } from 'node:util';
import { createEngine, getEngineInstance, loadConfig } from '@zaivim/engine';
import { buildPingResponse, buildHealthResponse } from '@zaivim/engine';
import { writePidFile, checkExistingPid, removePidFile, readPidFile } from '@zaivim/engine';
import type { EngineConfig, EngineStatus, EngineAPI } from '@zaivim/core';
import { ZaiConfigError } from '@zaivim/core';
import { createStdioTransport } from './stdio/transport.js';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const VERSION = '0.1.0';
const PID_PATH = join(homedir(), '.zaivim', 'engine.pid');

const SUBCOMMANDS = {
  serve:       'Start the zaivim engine (foreground, use --daemon for background)',
  status:      'Show engine status (pid, uptime, version)',
  ping:        'Check if engine is running + version + feature preview',
  stop:        'Stop a running engine daemon',
  chat:        'Start an interactive AI chat session (coming in v0.2.0)',
  tui:         'Launch the terminal UI (coming in v0.5.0)',
  skill:       'Manage skills (coming in v0.6.0)',
  import:      'Import configuration from external sources',
  'smoke-test': 'Run integration smoke tests',
} as const;

function showHelp(): void {
  console.log(`zaivim v${VERSION} — AI assistant engine for Vim

Usage: zaivim <command> [options]

Commands:
${Object.entries(SUBCOMMANDS).map(([cmd, desc]) => `  ${cmd.padEnd(14)}${desc}`).join('\n')}

Options:
  -v, --version    Show version
  -h, --help       Show this help
  --daemon         Run as background daemon (serve only)

Examples:
  zaivim serve              Start engine in foreground
  zaivim serve --daemon     Start engine as background daemon
  zaivim ping               Check engine status
  zaivim status             Show detailed engine info
  zaivim stop               Stop running daemon
`);
}

function getEngineConfig(): EngineConfig {
  return {
    pidFile: PID_PATH,
    version: VERSION,
    startupTimeout: 3000,
    healthCheckInterval: 30000,
  };
}

// ---- serve command ---------------------------------------------------------

function startEngine(config: EngineConfig, opts?: { daemon?: boolean }): void {
  // Load and validate config (throws ZaiConfigError on error — AC4)
  try {
    loadConfig();
  } catch (err) {
    if (err instanceof ZaiConfigError) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const engine = createEngine(config);

  // Enforce startup timeout (NFR4)
  const timer = setTimeout(() => {
    console.error(`Engine startup timed out after ${config.startupTimeout}ms`);
    process.exit(1);
  }, config.startupTimeout);
  clearTimeout(timer);

  // Write PID file after engine is ready
  writePidFile(config.pidFile, VERSION);

  const shutdown = () => {
    engine.destroy().then(() => {
      removePidFile(config.pidFile);
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  if (opts?.daemon) {
    // Daemon mode: no stdio transport (stdio is /dev/null)
    // Engine runs until SIGTERM
    process.stdin.resume();
    return;
  }

  // Wire stdio transport for JSON-RPC health/ping endpoint (AC1)
  createStdioTransport(engine);

  const health = buildHealthResponse(engine, 0);
  console.log(JSON.stringify(health));

  // Keep process alive
  process.stdin.resume();
}

async function cmdServe(daemon: boolean): Promise<void> {
  const config = getEngineConfig();

  if (daemon) {
    const { fork } = await import('node:child_process');
    const selfPath = fileURLToPath(import.meta.url);
    const child = fork(selfPath, ['_serve_worker'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    // child process writes PID file in _serve_worker → startEngine()
    console.log(`zaivim engine started (pid: ${child.pid})`);
    process.exit(0);
  } else {
    startEngine(config);
  }
}

// ---- status command --------------------------------------------------------

function cmdStatus(): void {
  const data = readPidFile(PID_PATH);
  if (!data) {
    const response: EngineStatus = { status: 'down', pid: null, uptime: 0, version: VERSION };
    console.log(JSON.stringify(response));
    return;
  }

  const alive = checkExistingPid(PID_PATH);
  if (!alive.alive) {
    const response: EngineStatus = { status: 'down', pid: null, uptime: 0, version: VERSION };
    console.log(JSON.stringify(response));
    return;
  }

  const uptime = Date.now() - data.startedAt;
  const response: EngineStatus = {
    status: 'ok',
    pid: data.pid,
    uptime,
    version: data.version,
  };
  console.log(JSON.stringify(response));
}

// ---- ping command ----------------------------------------------------------

function cmdPing(): void {
  const engine = getEngineInstance() as EngineAPI | undefined;
  const uptime = engine?.uptime;
  const response = buildPingResponse(engine, VERSION, uptime);
  console.log(JSON.stringify(response, null, 2));
}

// ---- stop command ----------------------------------------------------------

function cmdStop(): void {
  const result = checkExistingPid(PID_PATH);
  if (!result.alive || !result.pid) {
    console.log('Engine is not running');
    return;
  }

  try {
    process.kill(result.pid, 'SIGTERM');
    removePidFile(PID_PATH);
    console.log(`Engine stopped (pid: ${result.pid})`);
  } catch {
    console.error(`Failed to stop engine (pid: ${result.pid})`);
    process.exit(1);
  }
}

// ---- smoke-test command ----------------------------------------------------

function cmdSmokeTest(): void {
  const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/smoke-test-e1a.sh');
  try {
    execSync(`bash "${scriptPath}"`, { stdio: 'inherit' });
  } catch {
    process.exit(1);
  }
}

// ---- Main entry point ------------------------------------------------------

function main(): void {
  const { values, positionals } = parseArgs({
    options: {
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
      daemon: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.version) {
    console.log(`zaivim v${VERSION}`);
    process.exit(0);
  }

  if (values.help) {
    showHelp();
    process.exit(0);
  }

  const command = positionals[0];

  // Internal worker mode for daemon (stdio is /dev/null — skip transport)
  if (command === '_serve_worker') {
    startEngine(getEngineConfig(), { daemon: true });
    return;
  }

  // JSON-RPC stdio mode: echo '{"jsonrpc":"2.0","method":"health","id":1}' | zaivim
  if (!command && !process.stdin.isTTY) {
    const engine = createEngine(getEngineConfig());
    createStdioTransport(engine);
    // Transport will exit on stdin close
    return;
  }

  switch (command) {
    case 'serve':
      cmdServe(values.daemon as boolean);
      break;
    case 'status':
      cmdStatus();
      break;
    case 'ping':
      cmdPing();
      break;
    case 'stop':
      cmdStop();
      break;
    case 'smoke-test':
      cmdSmokeTest();
      break;
    case 'chat':
    case 'tui':
    case 'skill':
    case 'import':
      console.log(`Command "${command}" is not yet available. Coming in a future version.`);
      process.exit(1);
    default:
      showHelp();
      process.exit(1);
  }
}

main();
