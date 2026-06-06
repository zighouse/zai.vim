#!/usr/bin/env node
// @zaivim/gateway — CLI entry point
// Uses Node 22 util.parseArgs() — zero external dependencies for MVP

import { parseArgs } from 'node:util';
import { createEngine, getEngineInstance, loadConfig, EventBus, ClientManager } from '@zaivim/engine';
import { buildPingResponse } from '@zaivim/engine';
import { writePidFile, checkExistingPid, removePidFile, readPidFile, InstanceGuard } from '@zaivim/engine';
import type { EngineConfig, EngineStatus, EngineAPI } from '@zaivim/core';
import { ZaiConfigError, ZaiInstanceConflictError } from '@zaivim/core';
import { createStdioTransport } from './stdio/transport.js';
import { TransportContext } from './stdio/transport-context.js';
import { generateAdminToken, removeAdminToken } from './admin-token.js';
import { resolve, dirname, join } from 'node:path';
import { openSync, mkdirSync } from 'node:fs';
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

async function startEngine(config: EngineConfig, opts?: { daemon?: boolean }): Promise<void> {
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

  // Generate admin token for ACL (AC5)
  const adminToken = generateAdminToken();

  // Create EventBus and ClientManager for event system (AC6, AC7)
  const eventBus = new EventBus();
  const clientManager = new ClientManager(eventBus);
  const transportContext = new TransportContext({ eventBus, clientManager });

  // Enforce startup timeout (NFR4)
  const startupTimer = setTimeout(() => {
    console.error(`Engine startup timed out after ${config.startupTimeout}ms`);
    process.exit(1);
  }, config.startupTimeout);

  // Write PID file after engine is ready
  writePidFile(config.pidFile, VERSION);

  const shutdown = () => {
    removeAdminToken();
    transportContext.dispose();
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
    clearTimeout(startupTimer);

    console.log(`Engine running in daemon mode (pid: ${process.pid})`);

    // Keep the event loop alive by not returning
    // Use a simple interval to keep event loop active
    const keepAlive = setInterval(() => {
      // Do nothing - just keep event loop alive
    }, 60000); // Once per minute

    // Clean up on signals
    const cleanup = () => {
      clearInterval(keepAlive);
    };

    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);

    // Keep function from returning - this keeps the promise chain alive
    return new Promise<never>(() => {});
  }

  // Wire stdio transport for JSON-RPC with ACL + event support (AC1, AC5, AC6)
  createStdioTransport(engine, config.pidFile, undefined, { transportContext });

  // Engine is ready — clear startup timeout
  clearTimeout(startupTimer);

  // Handle stdin-end for non-daemon mode (auto-shutdown when stdin closes)
  process.stdin.on('end', () => {
    const engineInstance = getEngineInstance();
    engineInstance?.handleStdinEnd();
  });

  // Keep process alive
  process.stdin.resume();
}

async function cmdServe(daemon: boolean): Promise<void> {
  const config = getEngineConfig();

  // Check for instance conflicts before starting
  const guard = new InstanceGuard(config.pidFile);
  try {
    guard.checkOrThrow();
  } catch (err) {
    if (err instanceof ZaiInstanceConflictError) {
      const response = {
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'ENGINE_INSTANCE_CONFLICT',
          data: {
            existingPid: err.existingPid,
            existingStartedAt: err.existingStartedAt,
          },
        },
        id: null,
      };
      console.log(JSON.stringify(response));
      process.exit(1);
    }
    throw err;
  }

  if (daemon) {
    const { spawn } = await import('node:child_process');
    const selfPath = fileURLToPath(import.meta.url);
    const nodeArgs = [selfPath, '_serve_worker'];

    // Redirect stdout/stderr to engine.log (AC6)
    const logPath = join(homedir(), '.zaivim', 'logs', 'engine.log');
    mkdirSync(dirname(logPath), { recursive: true });
    const logFd = openSync(logPath, 'a');

    const child = spawn(process.execPath, nodeArgs, {
      detached: true,
      stdio: ['ignore', logFd, logFd, 'ipc'],
      cwd: process.cwd(),
    });
    child.unref();
    // child process writes PID file in _serve_worker → startEngine()
    console.log(`zaivim engine started (pid: ${child.pid})`);

    child.on('error', (err) => {
      console.error(`Failed to start daemon: ${err.message}`);
      process.exit(1);
    });

    // Don't wait - let parent exit immediately
    // Child process should continue running independently
    process.exit(0);
  } else {
    await startEngine(config);
  }
}

/** Find engine daemon PIDs via pgrep (AC4: PID file manually deleted fallback) */
function findZaivimDaemonPids(): number[] {
  try {
    const out = execSync('pgrep -f "gateway/dist/cli\\.js"', { encoding: 'utf-8' });
    const pids = out.trim().split('\n').filter(Boolean).map(Number);
    // Exclude current process (zaivim stop itself)
    return pids.filter((pid) => pid !== process.pid);
  } catch {
    return [];
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

// ---- session command --------------------------------------------------------

async function cmdSession(
  args: string[],
  _opts: Record<string, unknown>,
): Promise<void> {
  const subcommand = args[0];
  const engine = getEngineInstance() as EngineAPI | undefined;
  if (!engine) {
    console.error('Error: no engine running');
    process.exit(1);
  }

  switch (subcommand) {
    case 'create': {
      const projectDir = args.find((a, i) => args[i - 1] === '--project-dir');
      const session = await engine.createSession(undefined, projectDir);
      console.log(JSON.stringify({ sessionId: session.id, status: session.status, createdAt: session.createdAt }));
      break;
    }
    case 'list': {
      const health = engine.getHealth();
      console.log(JSON.stringify({ activeSessions: health.activeSessions }));
      break;
    }
    case 'get': {
      const id = args[1];
      if (!id) {
        console.error('Usage: zaivim session get <session-id>');
        process.exit(1);
      }
      const session = engine.getSession(id);
      if (!session) {
        console.error(`Session not found: ${id}`);
        process.exit(1);
      }
      console.log(JSON.stringify({
        sessionId: session.id,
        status: session.status,
        createdAt: session.createdAt,
        projectDir: session.projectDir,
        messageCount: session.messages.length,
        messages: session.messages,
      }, null, 2));
      break;
    }
    case 'close': {
      const closeId = args[1];
      if (!closeId) {
        console.error('Usage: zaivim session close <session-id>');
        process.exit(1);
      }
      await engine.closeSession(closeId);
      console.log(JSON.stringify({ sessionId: closeId, status: 'closed' }));
      break;
    }
    default:
      console.log('Usage: zaivim session <create|list|get|close> [options]');
      console.log('  create [--project-dir <path>]  Create a new session');
      console.log('  list                           List active sessions');
      console.log('  get <id>                       Get session details');
      console.log('  close <id>                     Close a session');
      break;
  }
}

// ---- ping command ----------------------------------------------------------

function cmdPing(): void {
  // Try to get engine instance first (for foreground mode)
  const engine = getEngineInstance() as EngineAPI | undefined;
  const uptime = engine?.uptime;

  // If no engine instance, check PID file (for daemon mode)
  if (!engine) {
    const alive = checkExistingPid(PID_PATH);
    if (alive.alive && alive.pid && alive.data) {
      // Engine is running in daemon mode
      const daemonUptime = Date.now() - alive.data.startedAt;
      const response = buildPingResponse(engine, VERSION, daemonUptime);
      console.log(JSON.stringify(response, null, 2));
      return;
    }
  }

  // Either foreground mode with engine instance, or engine not running
  const response = buildPingResponse(engine, VERSION, uptime);
  console.log(JSON.stringify(response, null, 2));
}

// ---- stop command ----------------------------------------------------------

async function cmdStop(): Promise<void> {
  const result = checkExistingPid(PID_PATH);
  if (!result.alive || !result.pid) {
    // AC4: PID file missing/manually deleted — try pgrep fallback
    const pids = findZaivimDaemonPids();
    if (pids.length > 0) {
      for (const pid of pids) {
        process.kill(pid, 'SIGTERM');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      const response = { status: 'stopped', pid: pids[0] };
      console.log(JSON.stringify(response));
      return;
    }
    const response = { status: 'not_running' };
    console.log(JSON.stringify(response));
    return;
  }

  try {
    // Send JSON-RPC stop request via stdin to the running engine
    const stopRequest = JSON.stringify({
      jsonrpc: '2.0',
      method: 'stop',
      id: 1,
    });

    // For now, send SIGTERM to trigger graceful shutdown
    // TODO: In future, implement proper JSON-RPC client that connects to engine
    process.kill(result.pid, 'SIGTERM');

    // Wait a bit for graceful shutdown
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Check if process still exists
    const stillAlive = checkExistingPid(PID_PATH);
    if (!stillAlive.alive) {
      const response = { status: 'stopped', pid: result.pid };
      console.log(JSON.stringify(response));
      return;
    }

    // If still alive after 100ms, it's shutting down gracefully
    const response = { status: 'stopping', pid: result.pid };
    console.log(JSON.stringify(response));
  } catch (err) {
    const response = { status: 'error', message: (err as Error).message };
    console.log(JSON.stringify(response));
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

async function main(): Promise<void> {
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
    await startEngine(getEngineConfig(), { daemon: true });
    return;
  }

  // JSON-RPC stdio mode: echo '{"jsonrpc":"2.0","method":"health","id":1}' | zaivim
  if (!command && !process.stdin.isTTY) {
    const config = getEngineConfig();
    const engine = createEngine(config);
    const adminToken = generateAdminToken();
    const eventBus = new EventBus();
    const clientManager = new ClientManager(eventBus);
    const transportContext = new TransportContext({ eventBus, clientManager });
    createStdioTransport(engine, config.pidFile, undefined, { transportContext });
    // Transport will exit on stdin close
    return;
  }

  // Handle smoke-test separately (it's sync)
  if (command === 'smoke-test') {
    cmdSmokeTest();
    return;
  }

  switch (command) {
    case 'serve':
      await cmdServe(values.daemon as boolean);
      break;
    case 'status':
      cmdStatus();
      break;
    case 'ping':
      cmdPing();
      break;
    case 'stop':
      cmdStop().catch((err) => {
        console.error('Stop command failed:', err);
        process.exit(1);
      });
      break;
    case 'session':
      await cmdSession(positionals.slice(1), values);
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
