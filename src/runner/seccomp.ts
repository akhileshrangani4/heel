/**
 * The seccomp filter every sandboxed process runs under (spec: CLI runner,
 * "a seccomp filter"). bubblewrap already drops every capability and, with
 * `--disable-userns`, forbids new user namespaces, so mounts and namespace
 * changes fail without this filter. It narrows what is left of the kernel:
 * debugging other processes, keyrings, eBPF, perf, io_uring, module loading
 * and the clock, none of which a CLI talking to an API needs.
 *
 * The program is classic BPF over `struct seccomp_data`, built here instead
 * of through libseccomp so heel has no native dependency. Syscall numbers come
 * from the kernel's uapi headers (`asm/unistd_64.h` for x86_64,
 * `asm-generic/unistd.h` for aarch64); a test pins them.
 */

export type SeccompArch = "x64" | "arm64";

// <linux/audit.h>: EM_* | __AUDIT_ARCH_64BIT | __AUDIT_ARCH_LE.
const AUDIT_ARCH: Readonly<Record<SeccompArch, number>> = {
  x64: 0xc000003e,
  arm64: 0xc00000b7,
};

// <asm/unistd.h>: x86_64 marks x32-ABI syscalls with this bit.
const X32_SYSCALL_BIT = 0x40000000;

// <linux/seccomp.h>
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_ALLOW = 0x7fff0000;

// <asm-generic/errno*.h>
const EPERM = 1;
const ENOSYS = 38;

// <linux/bpf_common.h>
const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_JMP_JGE_K = 0x35;
const BPF_RET_K = 0x06;

// offsetof(struct seccomp_data, …)
const OFFSET_NR = 0;
const OFFSET_ARCH = 4;

interface DeniedSyscall {
  readonly name: string;
  readonly x64?: number;
  readonly arm64?: number;
  /** ENOSYS where a runtime probes for the call and falls back (io_uring); EPERM otherwise. */
  readonly errno?: typeof ENOSYS;
}

/** Each entry with its number per architecture; a missing number means the arch has no such call. */
export const DENIED_SYSCALLS: readonly DeniedSyscall[] = [
  // Mounts, namespaces and the root directory.
  { name: "mount", x64: 165, arm64: 40 },
  { name: "umount2", x64: 166, arm64: 39 },
  { name: "pivot_root", x64: 155, arm64: 41 },
  { name: "chroot", x64: 161, arm64: 51 },
  { name: "unshare", x64: 272, arm64: 97 },
  { name: "setns", x64: 308, arm64: 268 },
  { name: "fsopen", x64: 430, arm64: 430 },
  { name: "fsconfig", x64: 431, arm64: 431 },
  { name: "fsmount", x64: 432, arm64: 432 },
  { name: "fspick", x64: 433, arm64: 433 },
  { name: "move_mount", x64: 429, arm64: 429 },
  { name: "open_tree", x64: 428, arm64: 428 },
  { name: "mount_setattr", x64: 442, arm64: 442 },
  { name: "open_by_handle_at", x64: 304, arm64: 265 },
  // Reading or steering other processes.
  { name: "ptrace", x64: 101, arm64: 117 },
  { name: "process_vm_readv", x64: 310, arm64: 270 },
  { name: "process_vm_writev", x64: 311, arm64: 271 },
  // Kernel keyrings, eBPF, perf and userfaultfd.
  { name: "keyctl", x64: 250, arm64: 219 },
  { name: "add_key", x64: 248, arm64: 217 },
  { name: "request_key", x64: 249, arm64: 218 },
  { name: "bpf", x64: 321, arm64: 280 },
  { name: "perf_event_open", x64: 298, arm64: 241 },
  { name: "userfaultfd", x64: 323, arm64: 282 },
  { name: "io_uring_setup", x64: 425, arm64: 425, errno: ENOSYS },
  { name: "io_uring_enter", x64: 426, arm64: 426, errno: ENOSYS },
  { name: "io_uring_register", x64: 427, arm64: 427, errno: ENOSYS },
  // Modules, kexec and machine state.
  { name: "kexec_load", x64: 246, arm64: 104 },
  { name: "kexec_file_load", x64: 320, arm64: 294 },
  { name: "init_module", x64: 175, arm64: 105 },
  { name: "finit_module", x64: 313, arm64: 273 },
  { name: "delete_module", x64: 176, arm64: 106 },
  { name: "syslog", x64: 103, arm64: 116 },
  { name: "acct", x64: 163, arm64: 89 },
  { name: "swapon", x64: 167, arm64: 224 },
  { name: "swapoff", x64: 168, arm64: 225 },
  { name: "reboot", x64: 169, arm64: 142 },
  { name: "quotactl", x64: 179, arm64: 60 },
  { name: "quotactl_fd", x64: 443, arm64: 443 },
  { name: "lookup_dcookie", x64: 212, arm64: 18 },
  { name: "vhangup", x64: 153, arm64: 58 },
  { name: "uselib", x64: 134 },
  { name: "ioperm", x64: 173 },
  { name: "iopl", x64: 172 },
  // The clock and host identity.
  { name: "settimeofday", x64: 164, arm64: 170 },
  { name: "clock_settime", x64: 227, arm64: 112 },
  { name: "clock_adjtime", x64: 305, arm64: 266 },
  { name: "adjtimex", x64: 159, arm64: 171 },
  { name: "sethostname", x64: 170, arm64: 161 },
  { name: "setdomainname", x64: 171, arm64: 162 },
];

/** The host's architecture, or undefined when heel has no filter for it. */
export function seccompArch(nodeArch: string): SeccompArch | undefined {
  return nodeArch === "x64" || nodeArch === "arm64" ? nodeArch : undefined;
}

/**
 * The filter as the bytes of a `struct sock_filter[]`, ready for bwrap
 * `--seccomp FD`. A syscall from another ABI (i386 on x86_64, x32) kills the
 * process, so the number checks below can't be sidestepped by switching ABI.
 */
export function buildSeccompFilter(arch: SeccompArch): Buffer {
  const denied = DENIED_SYSCALLS.flatMap((syscall) => {
    const nr = syscall[arch];
    return nr === undefined ? [] : [{ nr, errno: syscall.errno ?? EPERM }];
  });
  const program: Instruction[] = [
    [BPF_LD_W_ABS, 0, 0, OFFSET_ARCH],
    [BPF_JMP_JEQ_K, 1, 0, AUDIT_ARCH[arch]],
    [BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS],
    [BPF_LD_W_ABS, 0, 0, OFFSET_NR],
  ];
  if (arch === "x64") {
    program.push(
      [BPF_JMP_JGE_K, 0, 1, X32_SYSCALL_BIT],
      [BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS],
    );
  }
  for (const { nr, errno } of denied) {
    program.push([BPF_JMP_JEQ_K, 0, 1, nr], [BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | errno]);
  }
  program.push([BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW]);
  return encode(program);
}

/** `[code, jt, jf, k]`, one `struct sock_filter`. */
type Instruction = readonly [code: number, jt: number, jf: number, k: number];

function encode(program: readonly Instruction[]): Buffer {
  const bytes = Buffer.alloc(program.length * 8);
  program.forEach(([code, jt, jf, k], i) => {
    // The kernel reads the struct in host byte order; both supported arches are little-endian.
    bytes.writeUInt16LE(code, i * 8);
    bytes.writeUInt8(jt, i * 8 + 2);
    bytes.writeUInt8(jf, i * 8 + 3);
    bytes.writeUInt32LE(k >>> 0, i * 8 + 4);
  });
  return bytes;
}
