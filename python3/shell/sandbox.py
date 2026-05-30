#!/usr/bin/env python3
# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""Sandbox builder for bubblewrap (bwrap) isolation and seccomp BPF filtering.

Provides SandboxBuilder for detecting bwrap availability, constructing sandbox
configurations, and generating seccomp BPF profiles to restrict dangerous syscalls.

THREAD_SAFE: READ_ONLY — after construction, all objects are immutable.
"""

from __future__ import annotations

import atexit
import json
import os
import platform
import shutil
import struct
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Tuple

from paths import get_user_dir
from .error import SafetyError

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_BWRAP_MIN_VERSION = "0.4.0"
_CACHE_MAX_AGE_DAYS = 7
_CACHE_DIR = get_user_dir()
_CACHE_FILE = _CACHE_DIR / "sandbox_cache.json"

# seccomp BPF constants
_SECCOMP_RET_ALLOW = 0x7FFF0000
_SECCOMP_RET_KILL = 0x00000000
_BPF_LD_W_ABS = 0x20     # BPF_LD | BPF_W | BPF_ABS
_BPF_JMP_JEQ = 0x10      # BPF_JMP | BPF_JEQ
_BPF_RET = 0x06           # BPF_RET | BPF_K
_BPF_JA = 0x05            # BPF_JMP | BPF_JA

# Syscall whitelist (~45 entries) covering standard shell command needs
_SYSCALL_WHITELIST: list[int] = [
    # File I/O
    0,    # read
    1,    # write
    2,    # open
    3,    # close
    4,    # stat
    5,    # fstat
    6,    # lstat
    7,    # poll
    8,    # lseek
    9,    # mmap
    10,   # mprotect
    11,   # munmap
    12,   # brk
    13,   # rt_sigaction
    14,   # rt_sigprocmask
    15,   # rt_sigreturn
    20,   # writev
    21,   # access
    32,   # dup
    33,   # dup2 (x86_64); pipe on aarch64
    39,   # getpid
    41,   # socket (needed for basic ops in some environments)
    42,   # connect
    57,   # fork (x86_64)
    59,   # execve (x86_64)
    63,   # uname
    72,   # fcntl (x86_64)
    73,   # flock (x86_64)
    78,   # getdents (x86_64)
    79,   # getcwd (x86_64)
    80,   # chdir (x86_64)
    83,   # mkdir (x86_64)
    89,   # readlink (x86_64)
    96,   # gettimeofday (x86_64)
    97,   # getrlimit (x86_64)
    99,   # sysinfo (x86_64)
    102,  # getuid (x86_64)
    104,  # getgid (x86_64)
    107,  # geteuid (x86_64)
    108,  # getegid (x86_64)
    110,  # getppid (x86_64)
    131,  # sigaltstack (x86_64)
    186,  # gettid (x86_64)
    217,  # getdents64
    218,  # set_tid_address (x86_64)
    231,  # exit_group (x86_64)
    273,  # set_robust_list (x86_64)
    302,  # prlimit64 (x86_64)
    # Common across arches (use large numbers that work for both)
    221,  # fadvise64 (x86_64; execve on aarch64)
]

# aarch64 syscall whitelist — numbers from the Linux generic/unified syscall table
# (include/uapi/asm-generic/unistd.h). aarch64 uses a dense numbering scheme
# starting at 0; traditional syscalls like open/stat/poll/select do NOT exist —
# only their *at variants are available.
_SYSCALL_WHITELIST_AARCH64: list[int] = [
    # File I/O
    63,   # read
    64,   # write
    56,   # openat
    57,   # close
    62,   # lseek
    80,   # fstat
    79,   # fstatfs (aarch64: newfstatat/fstatat)
    48,   # faccessat
    78,   # readlinkat
    61,   # getdents64
    82,   # fsync
    66,   # writev
    # Memory
    214,  # brk
    222,  # mmap
    226,  # mprotect
    215,  # munmap
    216,  # mremap
    233,  # madvise
    # Process
    220,  # clone
    221,  # execve
    93,   # exit
    94,   # exit_group
    260,  # wait4
    172,  # getpid
    173,  # getppid
    174,  # getuid
    175,  # geteuid
    176,  # getgid
    177,  # getegid
    178,  # gettid
    96,   # set_tid_address
    99,   # set_robust_list
    98,   # futex
    # Signal
    134,  # rt_sigaction
    135,  # rt_sigprocmask
    139,  # rt_sigreturn
    129,  # kill
    131,  # tgkill
    # Time
    113,  # clock_gettime
    169,  # gettimeofday
    101,  # nanosleep
    # Filesystem metadata
    29,   # ioctl
    25,   # fcntl
    32,   # flock
    23,   # dup
    24,   # dup3
    59,   # pipe2
    73,   # ppoll
    34,   # mkdirat
    35,   # unlinkat
    38,   # renameat
    53,   # fchmodat
    49,   # chdir
    # System info
    160,  # uname
    163,  # getrlimit
    179,  # sysinfo
    167,  # prctl
    261,  # prlimit64
    124,  # sched_yield
    128,  # restart_syscall
]

# Syscalls that MUST be blocked (dangerous)
_BLOCKED_SYSCALLS_X86: list[int] = [
    101,  # ptrace
    165,  # mount
    166,  # umount2
    246,  # kexec_load
    322,  # execveat
    298,  # perf_event_open
    321,  # bpf
    319,  # keyctl
    272,  # unshare
]

_BLOCKED_SYSCALLS_AARCH64: list[int] = [
    117,  # ptrace
    40,   # mount
    39,   # umount2
    104,  # kexec_load
    286,  # execveat
    241,  # perf_event_open
    285,  # bpf
    219,  # keyctl
    97,   # unshare
]


# ---------------------------------------------------------------------------
# SandboxConfig
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SandboxConfig:
    """Immutable sandbox configuration returned by SandboxBuilder.build().

    THREAD_SAFE: READ_ONLY — all fields are immutable after construction.
    """

    effective_sandbox: str      # "bwrap+seccomp" | "bwrap" | "seccomp-only" | "none"
    network_mode: str           # "none" | "full"
    degraded: bool = False
    degraded_reason: str = ""
    bwrap_args: Tuple[str, ...] = ()
    seccomp_bpf_path: str = ""


# ---------------------------------------------------------------------------
# SeccompBPF — BPF bytecode generation
# ---------------------------------------------------------------------------

class SeccompBPF:
    """Generate seccomp BPF programs to restrict dangerous syscalls.

    Produces a whitelist-based BPF filter: allowed syscalls return ALLOW,
    everything else returns KILL (SIGSYS).
    """

    # Registered BPF file paths for cleanup
    _bpf_files: set[str] = set()
    _atexit_registered: bool = False

    def __init__(self, arch: str | None = None) -> None:
        self._arch = arch or self._detect_audit_arch()
        self._whitelist, self._blocked = self._get_syscall_lists()

        # Validate: blocked syscalls MUST NOT be in the whitelist
        _whitelist_set = set(self._whitelist)
        for blocked_nr in self._blocked:
            if blocked_nr in _whitelist_set:
                raise ValueError(
                    f"syscall {blocked_nr} is in both whitelist and blocked list — "
                    f"this is a security bug"
                )

    @staticmethod
    def _detect_audit_arch() -> str:
        """Detect AUDIT_ARCH value for the current platform."""
        machine = platform.machine().lower()
        if machine in ("x86_64", "amd64"):
            return "AUDIT_ARCH_X86_64"
        if machine in ("aarch64", "arm64"):
            return "AUDIT_ARCH_AARCH64"
        # Fallback: assume x86_64 for unknown architectures
        print(f"[shell/sandbox] WARN: unknown architecture '{machine}', "
              f"defaulting to AUDIT_ARCH_X86_64", file=sys.stderr)
        return "AUDIT_ARCH_X86_64"

    def _get_audit_arch_value(self) -> int:
        """Get the numeric AUDIT_ARCH value."""
        if "X86_64" in self._arch:
            return 0xC000003E  # AUDIT_ARCH_X86_64
        if "AARCH64" in self._arch:
            return 0xC00000B7  # AUDIT_ARCH_AARCH64
        return 0xC000003E

    def _get_syscall_lists(self) -> Tuple[list[int], list[int]]:
        """Get syscall whitelist and blocked list for current arch."""
        if "AARCH64" in self._arch:
            return _SYSCALL_WHITELIST_AARCH64, _BLOCKED_SYSCALLS_AARCH64
        return _SYSCALL_WHITELIST, _BLOCKED_SYSCALLS_X86

    def _make_filter(self, code: int, jt: int, jf: int, k: int) -> bytes:
        """Pack a single BPF instruction (struct sock_filter)."""
        return struct.pack("HBBI", code, jt, jf, k)

    def generate(self) -> bytes:
        """Generate the complete seccomp BPF program as bytes."""
        arch_val = self._get_audit_arch_value()
        whitelist = sorted(set(self._whitelist))
        n_whitelist = len(whitelist)

        program = bytearray()

        # Instruction 0: Load arch (offset 0 of seccomp_data)
        program += self._make_filter(_BPF_LD_W_ABS, 0, 0, 0x04)

        # Instruction 1: Compare arch, if not equal jump past all whitelist checks + 1
        # (jt=0 means fall through on match, jf=n_whitelist+1 means skip on mismatch)
        program += self._make_filter(
            _BPF_JMP_JEQ, 0, n_whitelist + 1, arch_val
        )

        # Instruction 2: Load syscall number (offset 8 of seccomp_data)
        program += self._make_filter(_BPF_LD_W_ABS, 0, 0, 0x00)

        # Instructions 3..n_whitelist+2: Compare against each whitelisted syscall
        for i, syscall_nr in enumerate(whitelist):
            remaining = n_whitelist - i - 1
            # On match (jt=0): jump to ALLOW (1 instruction after last compare)
            # On mismatch (jf=0): fall through to next compare
            program += self._make_filter(
                _BPF_JMP_JEQ, remaining, 0, syscall_nr
            )

        # ALLOW target: SECCOMP_RET_ALLOW
        allow_idx = 3 + n_whitelist
        program += self._make_filter(_BPF_RET, 0, 0, _SECCOMP_RET_ALLOW)

        # KILL target (arch mismatch or syscall not in whitelist): SECCOMP_RET_KILL
        program += self._make_filter(_BPF_RET, 0, 0, _SECCOMP_RET_KILL)

        return bytes(program)

    @property
    def whitelist_count(self) -> int:
        """Number of whitelisted syscalls."""
        return len(set(self._whitelist))

    def write_profile(self, path: str | None = None) -> str:
        """Write the BPF program to a temporary file for bwrap --seccomp.

        Returns the path to the written file. The file is registered for cleanup
        at process exit via atexit.
        """
        bpf_data = self.generate()
        if path is None:
            path = os.path.join(
                tempfile.gettempdir(),
                f"zai-seccomp-{uuid.uuid4().hex[:12]}.bpf"
            )
        with open(path, "wb") as f:
            f.write(bpf_data)
        SeccompBPF._register_cleanup(path)
        return path

    @classmethod
    def cleanup_profile(cls, path: str) -> None:
        """Remove a BPF profile file. Safe to call on already-removed paths."""
        try:
            if os.path.exists(path):
                os.unlink(path)
        except OSError:
            pass
        cls._bpf_files.discard(path)

    @classmethod
    def _register_cleanup(cls, path: str) -> None:
        """Register a BPF file for atexit cleanup."""
        cls._bpf_files.add(path)
        if not cls._atexit_registered:
            atexit.register(cls._cleanup_all)
            cls._atexit_registered = True

    @classmethod
    def _cleanup_all(cls) -> None:
        """Remove all registered BPF profile files."""
        for path in list(cls._bpf_files):
            cls.cleanup_profile(path)


# ---------------------------------------------------------------------------
# SandboxBuilder
# ---------------------------------------------------------------------------

class SandboxBuilder:
    """Detect bwrap availability and construct sandbox configurations.

    Usage:
        available, err = SandboxBuilder.available()
        if available:
            config, err = SandboxBuilder.build(allow_network=False)
            if config:
                # use config.bwrap_args with subprocess.Popen
    """

    # Process-level cache for available() result
    _available_cache: Optional[bool] = None

    @classmethod
    def available(cls) -> Tuple[bool, Optional[SafetyError]]:
        """Check if bwrap sandbox is available (AC #1, #2, #3, #14).

        Returns (True, None) if bwrap >= 0.4.0 is installed and user namespaces
        are available. Result is cached for the process lifetime and across
        sessions via ~/.local/share/zai/sandbox_cache.json.

        Returns (False, SafetyError) with degraded=True on failure.
        """
        # Check process cache first
        if cls._available_cache is not None:
            if cls._available_cache:
                return (True, None)
            return (False, SafetyError(
                layer="L3_sandbox",
                code="SANDBOX_UNAVAILABLE",
                message="bwrap not available (cached result)",
                degraded=True,
            ))

        # Check disk cache
        disk_result = cls._load_disk_cache()
        if disk_result is not None:
            cls._available_cache = disk_result
            if disk_result:
                return (True, None)
            return (False, SafetyError(
                layer="L3_sandbox",
                code="SANDBOX_UNAVAILABLE",
                message="bwrap not available (cached result)",
                degraded=True,
            ))

        # Perform actual detection
        result, err = cls._detect_availability()
        cls._available_cache = result

        # Save to disk cache
        cls._save_disk_cache(result)

        if result:
            return (True, None)
        return (False, err)

    @classmethod
    def build(
        cls,
        allow_network: bool = False,
        working_dir: str | None = None,
    ) -> Tuple[Optional[SandboxConfig], Optional[SafetyError]]:
        """Build a sandbox configuration (AC #4-8).

        Returns (SandboxConfig, None) on success or (None, SafetyError) on failure.
        """
        available, avail_err = cls.available()
        if not available:
            return (None, avail_err)

        # Check userns separately for degraded mode detection
        userns_ok = cls._check_userns_available()

        if not userns_ok:
            return (None, SafetyError(
                layer="L3_sandbox",
                code="USERNS_UNAVAILABLE",
                message="user namespaces not available",
                degraded=True,
            ))

        try:
            bwrap_args = cls._build_bwrap_args(
                allow_network=allow_network,
                working_dir=working_dir,
            )

            # Generate seccomp BPF profile
            seccomp = SeccompBPF()
            seccomp_path = ""
            try:
                seccomp_path = seccomp.write_profile()
            except Exception as exc:
                print(f"[shell/sandbox] WARN: seccomp BPF generation failed: {exc}",
                      file=sys.stderr)

            effective = "bwrap+seccomp" if seccomp_path else "bwrap"
            degraded = not seccomp_path

            config = SandboxConfig(
                effective_sandbox=effective,
                network_mode="none" if not allow_network else "full",
                degraded=degraded,
                degraded_reason="" if not degraded else "seccomp BPF generation failed",
                bwrap_args=tuple(
                    bwrap_args + (["--seccomp", seccomp_path] if seccomp_path else [])
                ),
                seccomp_bpf_path=seccomp_path,
            )
            return (config, None)

        except Exception as exc:
            return (None, SafetyError(
                layer="L3_sandbox",
                code="BUILD_FAILED",
                message=f"sandbox build failed: {exc!s}"[:80],
                degraded=True,
            ))

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @classmethod
    def _detect_availability(cls) -> Tuple[bool, Optional[SafetyError]]:
        """Perform actual bwrap detection."""
        # Check bwrap binary exists
        bwrap_path = shutil.which("bwrap")
        if not bwrap_path:
            return (False, SafetyError(
                layer="L3_sandbox",
                code="SANDBOX_UNAVAILABLE",
                message="bwrap binary not found in PATH",
                degraded=True,
            ))

        # Check bwrap version >= 0.4.0
        if not cls._check_bwrap_version(bwrap_path):
            return (False, SafetyError(
                layer="L3_sandbox",
                code="SANDBOX_UNAVAILABLE",
                message="bwrap version < 0.4.0, --seccomp unsupported",
                degraded=True,
            ))

        # Check user namespace availability
        if not cls._check_userns_available():
            return (False, SafetyError(
                layer="L3_sandbox",
                code="USERNS_UNAVAILABLE",
                message="user namespaces not available on this system",
                degraded=True,
            ))

        return (True, None)

    @classmethod
    def _check_bwrap_version(cls, bwrap_path: str) -> bool:
        """Check if bwrap version >= 0.4.0 (AC #14)."""
        try:
            result = subprocess.run(
                [bwrap_path, "--version"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            output = (result.stdout or result.stderr or "").strip()
            # Parse version from output like "bubblewrap 0.6.1"
            for part in output.split():
                if part and part[0].isdigit():
                    version_str = part
                    break
            else:
                return False

            # Compare versions
            return cls._version_gte(version_str, _BWRAP_MIN_VERSION)

        except Exception:
            return False

    @staticmethod
    def _version_gte(version: str, minimum: str) -> bool:
        """Compare two version strings: version >= minimum."""
        def parse(v: str) -> Tuple[int, ...]:
            return tuple(int(x) for x in v.split("."))
        try:
            return parse(version) >= parse(minimum)
        except (ValueError, TypeError):
            return False

    @staticmethod
    def _check_userns_available() -> bool:
        """Check if user namespaces are available.

        Uses /proc/sys/kernel/unprivileged_userns_clone first, then
        falls back to checking /proc/sys/user/max_user_namespaces.
        """
        # Method 1: Check unprivileged_userns_clone sysctl
        try:
            with open("/proc/sys/kernel/unprivileged_userns_clone") as f:
                return f.read().strip() == "1"
        except FileNotFoundError:
            pass

        # Method 2: Check max_user_namespaces (> 0 means supported)
        try:
            with open("/proc/sys/user/max_user_namespaces") as f:
                return int(f.read().strip()) > 0
        except (FileNotFoundError, ValueError):
            pass

        # Method 3: Assume available on modern kernels (most distros enable it)
        # This is a conservative fallback — bwrap itself will fail if not available
        print(f"[shell/sandbox] WARN: cannot determine user namespace availability, "
              f"assuming available", file=sys.stderr)
        return True

    @classmethod
    def _build_bwrap_args(
        cls,
        allow_network: bool = False,
        working_dir: str | None = None,
    ) -> list[str]:
        """Build bwrap command-line arguments (AC #4, #5, #6, #7)."""
        cwd = working_dir or os.getcwd()
        args: list[str] = []

        # Basic filesystem mounts (read-only system dirs)
        for src in ("/usr", "/lib", "/lib64", "/bin", "/etc"):
            if os.path.exists(src):
                args.extend(["--ro-bind", src, src])

        # Working directory (read-write)
        args.extend(["--bind", cwd, cwd])

        # /tmp (read-write)
        args.extend(["--bind", "/tmp", "/tmp"])

        # /proc and /dev
        args.extend(["--proc", "/proc"])
        args.extend(["--dev", "/dev"])

        # Die with parent process
        args.append("--die-with-parent")

        # Network control (AC #4, #5)
        if not allow_network:
            args.append("--unshare-net")

        # SSH credential isolation (AC #6, #7)
        home = os.path.expanduser("~")
        ssh_dir = os.path.join(home, ".ssh")
        if os.path.isdir(ssh_dir):
            # Mount tmpfs over ~/.ssh to hide private keys
            args.extend(["--tmpfs", ssh_dir])

            # Re-mount known_hosts read-only if it exists
            known_hosts = os.path.join(ssh_dir, "known_hosts")
            if os.path.exists(known_hosts):
                args.extend(["--ro-bind", known_hosts, known_hosts])

        return args

    @classmethod
    def _load_disk_cache(cls) -> Optional[bool]:
        """Load cached availability result from disk."""
        try:
            if not _CACHE_FILE.exists():
                return None
            with open(_CACHE_FILE) as f:
                cache = json.load(f)

            # Check cache age
            detected_at = cache.get("detected_at", "")
            if detected_at:
                dt = datetime.fromisoformat(detected_at)
                if datetime.now(timezone.utc) - dt > timedelta(days=_CACHE_MAX_AGE_DAYS):
                    return None

            # Check if bwrap version changed
            bwrap_path = shutil.which("bwrap")
            if bwrap_path:
                try:
                    result = subprocess.run(
                        [bwrap_path, "--version"],
                        capture_output=True, text=True, timeout=5,
                    )
                    output = (result.stdout or result.stderr or "").strip()
                    cached_version = cache.get("bwrap_version", "")
                    if cached_version and cached_version not in output:
                        return None  # Version changed, re-detect
                except Exception:
                    pass

            return cache.get("available")

        except Exception:
            return None

    @classmethod
    def _save_disk_cache(cls, available: bool) -> None:
        """Save availability result to disk cache."""
        try:
            _CACHE_DIR.mkdir(parents=True, exist_ok=True)
            bwrap_path = shutil.which("bwrap") or ""
            version = ""
            if bwrap_path:
                try:
                    result = subprocess.run(
                        [bwrap_path, "--version"],
                        capture_output=True, text=True, timeout=5,
                    )
                    output = (result.stdout or result.stderr or "").strip()
                    for part in output.split():
                        if part and part[0].isdigit():
                            version = part
                            break
                except Exception:
                    pass

            cache = {
                "available": available,
                "bwrap_version": version,
                "userns_available": cls._check_userns_available(),
                "detected_at": datetime.now(timezone.utc).isoformat(),
                "arch": platform.machine(),
            }

            # Atomic write via temp file
            tmp_fd, tmp_path = tempfile.mkstemp(dir=str(_CACHE_DIR), suffix=".json")
            try:
                with os.fdopen(tmp_fd, "w") as f:
                    json.dump(cache, f, indent=2)
                os.replace(tmp_path, str(_CACHE_FILE))
            except Exception:
                os.unlink(tmp_path) if os.path.exists(tmp_path) else None

        except Exception:
            pass  # Cache write failure is non-critical
