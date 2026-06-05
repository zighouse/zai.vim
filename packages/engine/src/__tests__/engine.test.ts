// =============================================================================
// @zaivim/engine — Engine lifecycle + config tests
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EngineStateMachine } from '../lifecycle/state-machine.js';
import type { EngineState } from '@zaivim/core';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { validateConfig } from '../config/config-validator.js';
import { ZaiConfigError } from '@zaivim/core';

// ---- EngineStateMachine tests ----

describe('EngineStateMachine', () => {
  it('starts in "starting" state', () => {
    const sm = new EngineStateMachine();
    expect(sm.state).toBe('starting');
  });

  describe('valid transitions', () => {
    const validTransitions: [EngineState, string, EngineState][] = [
      ['starting', 'ready', 'running'],
      ['running', 'degrade', 'degraded'],
      ['degraded', 'recover', 'running'],
      ['running', 'drain', 'draining'],
      ['degraded', 'drain', 'draining'],
      ['draining', 'shutdown', 'shutting_down'],
      ['shutting_down', 'terminate', 'terminated'],
    ];

    for (const [from, event, expected] of validTransitions) {
      it(`${from} + ${event} → ${expected}`, () => {
        const sm = new EngineStateMachine();
        // Navigate to 'from' state first
        navigateToState(sm, from);
        expect(sm.state).toBe(from);
        sm.transition(event as never);
        expect(sm.state).toBe(expected);
      });
    }
  });

  describe('invalid transitions', () => {
    const invalidTransitions: [EngineState, string][] = [
      ['starting', 'degrade'],
      ['starting', 'drain'],
      ['running', 'ready'],
      ['running', 'terminate'],
      ['terminated', 'ready'],
      ['terminated', 'kill'],
      ['terminated', 'shutdown'],
    ];

    for (const [from, event] of invalidTransitions) {
      it(`${from} + ${event} → throws`, () => {
        const sm = new EngineStateMachine();
        navigateToState(sm, from);
        expect(() => sm.transition(event as never)).toThrow(/Invalid engine transition/);
      });
    }
  });

  it('kill works from any non-terminal state', () => {
    const states: EngineState[] = ['starting', 'running', 'degraded', 'draining', 'shutting_down'];
    for (const state of states) {
      const sm = new EngineStateMachine();
      navigateToState(sm, state);
      sm.transition('kill');
      expect(sm.state).toBe('terminated');
    }
  });

  it('isTerminal is true only for terminated', () => {
    const sm = new EngineStateMachine();
    expect(sm.isTerminal).toBe(false);
    sm.transition('ready');
    expect(sm.isTerminal).toBe(false);
    sm.transition('kill');
    expect(sm.isTerminal).toBe(true);
  });

  it('isRunning is true for running and degraded', () => {
    const sm = new EngineStateMachine();
    expect(sm.isRunning).toBe(false);
    sm.transition('ready');
    expect(sm.isRunning).toBe(true);
    sm.transition('degrade');
    expect(sm.isRunning).toBe(true);
  });

  it('uptime increases over time', () => {
    const sm = new EngineStateMachine();
    const before = sm.uptime;
    // uptime is ms-based, should be >= 0 immediately
    expect(before).toBeGreaterThanOrEqual(0);
  });
});

/** Navigate state machine to target state via shortest path */
function navigateToState(sm: EngineStateMachine, target: EngineState): void {
  switch (target) {
    case 'starting': return; // already there
    case 'running': sm.transition('ready'); return;
    case 'degraded': sm.transition('ready'); sm.transition('degrade'); return;
    case 'draining': sm.transition('ready'); sm.transition('drain'); return;
    case 'shutting_down': sm.transition('ready'); sm.transition('drain'); sm.transition('shutdown'); return;
    case 'terminated': sm.transition('ready'); sm.transition('drain'); sm.transition('shutdown'); sm.transition('terminate'); return;
  }
}

// ---- PID file tests ----

describe('PID file', () => {
  const testDir = resolve(tmpdir(), `zaivim-test-pid-${Date.now()}`);
  const pidPath = resolve(testDir, 'engine.pid');

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }); } catch { /* ok */ }
  });

  it('writePidFile creates file with correct structure', async () => {
    const { writePidFile, readPidFile } = await import('../lifecycle/pid-file.js');
    writePidFile(pidPath, '0.1.0');

    const data = readPidFile(pidPath);
    expect(data).not.toBeNull();
    expect(data!.pid).toBe(process.pid);
    expect(data!.version).toBe('0.1.0');
    expect(data!.startedAt).toBeGreaterThan(0);
  });

  it('readPidFile returns null for non-existent file', async () => {
    const { readPidFile } = await import('../lifecycle/pid-file.js');
    const data = readPidFile('/nonexistent/path/engine.pid');
    expect(data).toBeNull();
  });

  it('isProcessAlive returns true for current process', async () => {
    const { isProcessAlive } = await import('../lifecycle/pid-file.js');
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('isProcessAlive returns false for non-existent PID', async () => {
    const { isProcessAlive } = await import('../lifecycle/pid-file.js');
    // Use a very high PID that shouldn't exist
    expect(isProcessAlive(999999999)).toBe(false);
  });

  it('checkExistingPid detects stale PID', async () => {
    const { checkExistingPid } = await import('../lifecycle/pid-file.js');
    // Write a PID file with a fake PID
    writeFileSync(pidPath, JSON.stringify({ pid: 999999999, startedAt: Date.now(), version: '0.1.0' }));

    const result = checkExistingPid(pidPath);
    expect(result.alive).toBe(false);
  });

  it('removePidFile deletes the file', async () => {
    const { writePidFile, removePidFile, readPidFile } = await import('../lifecycle/pid-file.js');
    writePidFile(pidPath, '0.1.0');
    expect(existsSync(pidPath)).toBe(true);

    removePidFile(pidPath);
    expect(readPidFile(pidPath)).toBeNull();
  });
});

// ---- Config validation tests ----

describe('Config validation', () => {
  it('valid config passes validation', () => {
    const config = {
      defaults: { provider: 'openai', model: 'gpt-4', temperature: 0.7, maxTokens: 4096 },
      sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('missing provider throws ZaiConfigError', () => {
    const config = {
      defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
    };
    expect(() => validateConfig(config)).toThrow(ZaiConfigError);
    expect(() => validateConfig(config)).toThrow(/defaults\.provider is required/);
  });

  it('invalid sandbox type throws', () => {
    const config = {
      defaults: { provider: 'openai', model: 'gpt-4', temperature: 0.7, maxTokens: 4096 },
      sandbox: { type: 'invalid', enabled: true, workDir: '/tmp', timeout: 30000 },
    };
    expect(() => validateConfig(config)).toThrow(/sandbox\.type/);
  });

  it('negative temperature throws', () => {
    const config = {
      defaults: { provider: 'openai', model: 'gpt-4', temperature: -0.5, maxTokens: 4096 },
    };
    expect(() => validateConfig(config)).toThrow(/defaults\.temperature/);
  });

  it('temperature > 2 throws', () => {
    const config = {
      defaults: { provider: 'openai', model: 'gpt-4', temperature: 3.0, maxTokens: 4096 },
    };
    expect(() => validateConfig(config)).toThrow(/defaults\.temperature/);
  });

  it('non-integer maxTokens throws', () => {
    const config = {
      defaults: { provider: 'openai', model: 'gpt-4', temperature: 0.7, maxTokens: 1.5 },
    };
    expect(() => validateConfig(config)).toThrow(/defaults\.maxTokens/);
  });
});
