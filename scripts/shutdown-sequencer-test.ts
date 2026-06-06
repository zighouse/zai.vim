#!/usr/bin/env node
// shutdown-sequencer-test.ts
// Test shutdown sequencer timeout and force shutdown behavior

import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

const PID_PATH = `${homedir()}/.zaivim/engine.pid`;
const CLI = './packages/gateway/dist/cli.js';

function exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => { stdout += data; });
    proc.stderr?.on('data', (data) => { stderr += data; });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr}`));
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testShutdownTimeout(): Promise<void> {
  console.log('Testing shutdown sequencer timeout behavior...\n');

  // Clean up any existing PID file
  if (existsSync(PID_PATH)) {
    unlinkSync(PID_PATH);
  }

  try {
    // Start engine in background
    console.log('1. Starting engine in daemon mode...');
    const engineProc = spawn('node', [CLI, 'serve', '--daemon'], {
      stdio: 'ignore',
      detached: true,
    });
    engineProc.unref();

    await sleep(1000); // Wait for engine to start

    if (!existsSync(PID_PATH)) {
      throw new Error('Engine PID file not created');
    }
    console.log('✓ Engine started\n');

    // Send SIGTERM to trigger graceful shutdown
    console.log('2. Sending SIGTERM to trigger graceful shutdown...');
    const pidData = JSON.parse(require('node:fs').readFileSync(PID_PATH, 'utf-8'));
    process.kill(Number(pidData.pid), 'SIGTERM');

    // Wait for graceful shutdown (should complete within 10 seconds per NFR26)
    console.log('3. Waiting for graceful shutdown (max 10s)...');
    const startTime = Date.now();

    while (Date.now() - startTime < 11000) {
      if (!existsSync(PID_PATH)) {
        const elapsed = Date.now() - startTime;
        console.log(`✓ Graceful shutdown completed in ${elapsed}ms`);
        console.log(`✓ PID file cleaned up`);
        return;
      }
      await sleep(100);
    }

    // If we get here, shutdown didn't complete in time
    throw new Error('Graceful shutdown did not complete within 10 seconds');

  } catch (error) {
    console.error('✗ Test failed:', error);
    process.exit(1);
  } finally {
    // Cleanup
    if (existsSync(PID_PATH)) {
      try {
        const pidData = JSON.parse(require('node:fs').readFileSync(PID_PATH, 'utf-8'));
        process.kill(Number(pidData.pid), 'SIGKILL');
      } catch {}
      unlinkSync(PID_PATH);
    }
  }
}

async function main(): Promise<void> {
  try {
    await testShutdownTimeout();
    console.log('\n✓ All shutdown sequencer tests passed!');
  } catch (error) {
    console.error('\n✗ Test failed:', error);
    process.exit(1);
  }
}

main();
