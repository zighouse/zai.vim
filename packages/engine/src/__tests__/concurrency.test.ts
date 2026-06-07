// @zaivim/engine — Concurrency safety tests
// JavaScript single-thread guarantees atomic seqCounter increments,
// but verify the behavior explicitly.

import { describe, it, expect } from 'vitest';
import type { Message, ZaiConfig } from '@zaivim/core';
import { InMemorySessionStoreFull } from '../session/memory-store.js';

function makeMessage(role: Message['role'] = 'user', content = 'hello'): Message {
  return { id: `msg-${Math.random()}`, role, content, createdAt: Date.now() };
}

describe('InMemorySessionStoreFull — concurrent pushMessage', () => {
  it('seqCounter increments atomically under sequential concurrency', () => {
    const store = new InMemorySessionStoreFull();
    const session = store.create();

    // Simulate 3 chat() calls pushing messages
    const promises = Array.from({ length: 10 }, (_, i) =>
      Promise.resolve().then(() => store.pushMessage(session.id, makeMessage('user', `msg ${i}`))),
    );

    return Promise.all(promises).then(() => {
      const s = store.get(session.id)!;
      expect(s.seqCounter).toBe(10);
      expect(s.messages).toHaveLength(10);

      // seq values should be 1..10
      const seqs = s.messages.map(m => m.seq).sort((a, b) => (a ?? 0) - (b ?? 0));
      for (let i = 0; i < 10; i++) {
        expect(seqs[i]).toBe(i + 1);
      }
    });
  });

  it('multiple sessions have independent seqCounters', () => {
    const store = new InMemorySessionStoreFull();
    const s1 = store.create();
    const s2 = store.create();

    store.pushMessage(s1.id, makeMessage());
    store.pushMessage(s2.id, makeMessage());
    store.pushMessage(s1.id, makeMessage());

    expect(store.get(s1.id)!.seqCounter).toBe(2);
    expect(store.get(s2.id)!.seqCounter).toBe(1);
  });

  it('pushes from 3 simulated chat() calls do not mix messages', async () => {
    const store = new InMemorySessionStoreFull();
    const s1 = store.create();
    const s2 = store.create();
    const s3 = store.create();

    // Simulate concurrent chat()
    await Promise.all([
      Promise.resolve().then(() => store.pushMessage(s1.id, makeMessage('user', 'a1'))),
      Promise.resolve().then(() => store.pushMessage(s2.id, makeMessage('user', 'b1'))),
      Promise.resolve().then(() => store.pushMessage(s3.id, makeMessage('user', 'c1'))),
      Promise.resolve().then(() => store.pushMessage(s1.id, makeMessage('user', 'a2'))),
      Promise.resolve().then(() => store.pushMessage(s2.id, makeMessage('user', 'b2'))),
    ]);

    expect(store.get(s1.id)!.messages.map(m => m.content)).toEqual(['a1', 'a2']);
    expect(store.get(s2.id)!.messages.map(m => m.content)).toEqual(['b1', 'b2']);
    expect(store.get(s3.id)!.messages.map(m => m.content)).toEqual(['c1']);
  });
});
