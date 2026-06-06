// @zaivim/engine — ShutdownSequencer tests
// Red-green-refactor: RED phase (tests before implementation)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ShutdownOptions, ShutdownStage, ShutdownEvent } from '@zaivim/core';
import { ShutdownSequencer } from '../lifecycle/shutdown-sequencer.js';

// Mock dependencies
const mockStateMachine = {
  transition: vi.fn(),
  state: 'running',
};

const mockAgentPool = {
  drain: vi.fn().mockResolvedValue(undefined),
  terminateAll: vi.fn().mockResolvedValue(undefined),
};

const mockSessionManager = {
  persistAll: vi.fn().mockResolvedValue(undefined),
  flushAuditLog: vi.fn().mockResolvedValue(undefined),
};

const mockPidFile = {
  remove: vi.fn().mockResolvedValue(undefined),
};

describe('ShutdownSequencer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('正常关闭流程', () => {
    it('应按顺序执行所有关闭阶段', async () => {
      const sequencer = new ShutdownSequencer({
        stateMachine: mockStateMachine as any,
        agentPool: mockAgentPool as any,
        sessionManager: mockSessionManager as any,
        pidFile: mockPidFile as any,
        eventEmitter: new EventEmitter() as any,
      });

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      await expect(
        sequencer.shutdown({ force: false, reason: 'SIGTERM' })
      ).rejects.toThrow('process.exit called');

      // 验证调用顺序
      expect(mockStateMachine.transition).toHaveBeenCalledWith('drain');
      expect(mockAgentPool.drain).toHaveBeenCalled();
      expect(mockSessionManager.persistAll).toHaveBeenCalled();
      expect(mockSessionManager.flushAuditLog).toHaveBeenCalled();
      expect(mockPidFile.remove).toHaveBeenCalled();
      expect(mockStateMachine.transition).toHaveBeenCalledWith('shutdown');
      expect(mockStateMachine.transition).toHaveBeenCalledWith('terminate');

      exitSpy.mockRestore();
    });

    it('应在每个阶段发出事件', async () => {
      const emitter = new EventEmitter();
      const eventLog: ShutdownEvent[] = [];

      emitter.on('engine:shutdown:stage', (event: ShutdownEvent) => {
        eventLog.push(event);
      });

      const sequencer = new ShutdownSequencer({
        stateMachine: mockStateMachine as any,
        agentPool: mockAgentPool as any,
        sessionManager: mockSessionManager as any,
        pidFile: mockPidFile as any,
        eventEmitter: emitter as any,
      });

      vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      await expect(
        sequencer.shutdown({ force: false, reason: 'test' })
      ).rejects.toThrow();

      // 验证事件发出的顺序
      const stages = eventLog.map((e) => e.stage);
      expect(stages).toEqual([
        'drain-requests',
        'drain-agents',
        'persist-sessions',
        'flush-audit',
        'clean-pid',
        'exit',
      ]);

      vi.restoreAllMocks();
    });
  });

  describe('超时强制关闭', () => {
    it('强制关闭应跳过等待但仍然持久化状态', async () => {
      const sequencer = new ShutdownSequencer({
        stateMachine: mockStateMachine as any,
        agentPool: mockAgentPool as any,
        sessionManager: mockSessionManager as any,
        pidFile: mockPidFile as any,
        eventEmitter: new EventEmitter() as any,
      });

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      await expect(
        sequencer.shutdown({ force: true, reason: 'manual-force' })
      ).rejects.toThrow('process.exit called');

      // 强制关闭仍应持久化和清理
      expect(mockSessionManager.persistAll).toHaveBeenCalled();
      expect(mockSessionManager.flushAuditLog).toHaveBeenCalled();
      expect(mockPidFile.remove).toHaveBeenCalled();

      // 但应调用 terminate 而不是 drain
      expect(mockAgentPool.terminateAll).toHaveBeenCalled();
      expect(mockAgentPool.drain).not.toHaveBeenCalled();

      exitSpy.mockRestore();
    });

    it('双重 SIGTERM 应立即退出', () => {
      const sequencer = new ShutdownSequencer({
        stateMachine: mockStateMachine as any,
        agentPool: mockAgentPool as any,
        sessionManager: mockSessionManager as any,
        pidFile: mockPidFile as any,
        eventEmitter: new EventEmitter() as any,
      });

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      // 第一次关闭（模拟已开始）
      sequencer.markShutdownInProgress();

      // 第二次调用应立即 exit(1)
      expect(() => sequencer.handleSecondSigterm()).toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
    });
  });

  describe('双重 SIGTERM 防护', () => {
    it('第二次 SIGTERM 应立即退出', () => {
      const sequencer = new ShutdownSequencer({
        stateMachine: mockStateMachine as any,
        agentPool: mockAgentPool as any,
        sessionManager: mockSessionManager as any,
        pidFile: mockPidFile as any,
        eventEmitter: new EventEmitter() as any,
      });

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      // 第一次关闭（模拟已开始）
      sequencer.markShutdownInProgress();

      // 第二次调用应立即 exit(1)
      expect(() => sequencer.handleSecondSigterm()).toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
    });
  });

  describe('错误处理', () => {
    it('某个阶段失败应继续执行后续阶段', async () => {
      mockSessionManager.persistAll.mockRejectedValue(new Error('Persist failed'));

      const sequencer = new ShutdownSequencer({
        stateMachine: mockStateMachine as any,
        agentPool: mockAgentPool as any,
        sessionManager: mockSessionManager as any,
        pidFile: mockPidFile as any,
        eventEmitter: new EventEmitter() as any,
      });

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      await expect(
        sequencer.shutdown({ force: true, reason: 'error-test' })
      ).rejects.toThrow('process.exit called');

      // 验证即使 persistAll 失败，强制模式下仍继续
      expect(mockSessionManager.flushAuditLog).toHaveBeenCalled();
      expect(mockPidFile.remove).toHaveBeenCalled();

      exitSpy.mockRestore();
    });
  });
});
