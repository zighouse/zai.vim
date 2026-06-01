#!/usr/bin/env node
// @zaivim/gateway CLI entry point
// Growth phase: full CLI with commander
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    version: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: false,
});

if (values.version) {
  console.log('zaivim v0.0.1');
  process.exit(0);
}

if (values.help) {
  console.log('Usage: zaivim [serve|tui] [options]');
  process.exit(0);
}

console.log('zaivim: no command specified. Try --help');
