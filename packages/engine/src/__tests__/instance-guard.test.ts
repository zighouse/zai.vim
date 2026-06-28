// @zaivim/engine — InstanceGuard tests
// Red-green-refactor: RED phase (tests before implementation)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZaiInstanceConflictError } from '@zaivim/core';
import { InstanceGuard } from '../daemon/instance-guard.js';

// Mock fs functions
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('node:path', () => ({
  resolve: vi.fn((path: string) => path.replace(/^~/, '/home/test')),
  dirname: vi.fn((path: string) => path.split('/').slice(0, -1).join('/')),
}));

import { existsSync, readFileSync, unlinkSync } from 'node:fs';

describe('InstanceGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkOrThrow', () => {
    it('PID 文件不存在时应返回正常', () => {
      (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const guard = new InstanceGuard('/tmp/test.pid');
      expect(() => guard.checkOrThrow()).not.toThrow();
    });

    it('PID 存活时应抛出 ZaiInstanceConflictError', () => {
      (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
        JSON.stringify({ pid: 12345, startedAt: Date.now(), version: '1.0.0' })
      );

      // Mock process.kill to indicate process is alive
      vi.spyOn(process, 'kill').mockImplementation(() => {
        // No error = process exists
      });

      const guard = new InstanceGuard('/tmp/test.pid');
      expect(() => guard.checkOrThrow()).toThrow(ZaiInstanceConflictError);
      expect(() => guard.checkOrThrow()).toThrow('Existing instance running');

      vi.restoreAllMocks();
    });

    it('Stale PID (ESRCH) 时应自动清理并返回', () => {
      (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
        JSON.stringify({ pid: 12345, startedAt: Date.now(), version: '1.0.0' })
      );

      // Mock process.kill to throw ESRCH (no such process)
      vi.spyOn(process, 'kill').mockImplementation((pid: number, signal: number) => {
        if (signal === 0) {
          const err: any = new Error('Process not found');
          err.code = 'ESRCH';
          throw err;
        }
      });

      (unlinkSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      const guard = new InstanceGuard('/tmp/test.pid');
      expect(() => guard.checkOrThrow()).not.toThrow();
      expect(unlinkSync).toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('应正确解析 PID 文件路径中的 ~', () => {
      (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const guard = new InstanceGuard('~/test.pid');
      expect(() => guard.checkOrThrow()).not.toThrow();
    });
  });

  describe('findProcessByPidFile', () => {
    it('PID 文件缺失时应返回 null', () => {
      (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const guard = new InstanceGuard('/tmp/test.pid');
      const result = guard.findProcessByPidFile();
      expect(result).toBeNull();
    });

    it('应从 PID 文件读取进程信息', () => {
      (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const mockPidData = { pid: 12345, startedAt: 1717680000000, version: '1.0.0' };
      (readFileSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
        JSON.stringify(mockPidData)
      );

      vi.spyOn(process, 'kill').mockImplementation(() => {});

      const guard = new InstanceGuard('/tmp/test.pid');
      const result = guard.findProcessByPidFile();
      expect(result).toEqual(mockPidData);

      vi.restoreAllMocks();
    });
  });

  describe('cleanupStalePid', () => {
    it('应删除 stale PID 文件', () => {
      (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (unlinkSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      const guard = new InstanceGuard('/tmp/test.pid');
      guard.cleanupStalePid();

      expect(unlinkSync).toHaveBeenCalled();
    });

    it('文件不存在时不应报错', () => {
      (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const guard = new InstanceGuard('/tmp/test.pid');
      expect(() => guard.cleanupStalePid()).not.toThrow();
    });
  });
});
