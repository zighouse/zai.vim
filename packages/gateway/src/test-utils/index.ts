// @zaivim/gateway — Test utilities
// Factory functions for creating mock stream objects in tests.

import { Writable } from 'node:stream';

/** Create a mock Writable stream that captures writes for test assertions. */
export function createMockWritable(): Writable & { written: string[] } {
  const written: string[] = [];
  const stream = new Writable({
    write(chunk: any, _encoding: unknown, callback: (error?: Error | null) => void) {
      written.push(chunk.toString());
      callback();
    },
  }) as Writable & { written: string[] };
  stream.written = written;
  return stream;
}

/** Create a mock Readable stream that emits provided lines. */
export function createMockReadable(lines: string[]): NodeJS.ReadableStream {
  const { Readable } = require('node:stream');
  return Readable.from(lines.map(l => l + '\n'));
}

export { Writable };
