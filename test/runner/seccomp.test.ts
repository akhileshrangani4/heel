import { describe, expect, it } from "vitest";
import { buildSeccompFilter, DENIED_SYSCALLS, seccompArch } from "../../src/runner/seccomp.ts";

const RET_KILL_PROCESS = 0x80000000;
const RET_ERRNO = 0x00050000;
const RET_ALLOW = 0x7fff0000;
const RET = 0x06;
const JEQ = 0x15;

interface Instruction {
  readonly code: number;
  readonly jt: number;
  readonly jf: number;
  readonly k: number;
}

function decode(filter: Buffer): Instruction[] {
  const program: Instruction[] = [];
  for (let at = 0; at < filter.length; at += 8) {
    program.push({
      code: filter.readUInt16LE(at),
      jt: filter.readUInt8(at + 2),
      jf: filter.readUInt8(at + 3),
      k: filter.readUInt32LE(at + 4),
    });
  }
  return program;
}

/** The return value a syscall number reaches, walking the program as the kernel would after the ABI checks. */
function verdict(program: readonly Instruction[], nr: number): number | undefined {
  const start = program.findIndex((op, i) => i > 2 && op.code === 0x20 && op.k === 0);
  for (let pc = start + 1; pc < program.length; ) {
    const op = program[pc];
    if (op === undefined) return undefined;
    if (op.code === RET) return op.k;
    if (op.code === JEQ) pc += 1 + (nr === op.k ? op.jt : op.jf);
    else pc += 1 + (nr >= op.k ? op.jt : op.jf);
  }
  return undefined;
}

describe("seccompArch", () => {
  it("knows x64 and arm64 only", () => {
    expect(seccompArch("x64")).toBe("x64");
    expect(seccompArch("arm64")).toBe("arm64");
    expect(seccompArch("ia32")).toBeUndefined();
    expect(seccompArch("riscv64")).toBeUndefined();
  });
});

describe.each(["x64", "arm64"] as const)("buildSeccompFilter(%s)", (arch) => {
  const program = decode(buildSeccompFilter(arch));

  it("is a whole number of sock_filter structs and is deterministic", () => {
    expect(buildSeccompFilter(arch).length % 8).toBe(0);
    expect(buildSeccompFilter(arch).equals(buildSeccompFilter(arch))).toBe(true);
  });

  it("kills a process that calls in with another architecture", () => {
    expect(program[0]).toMatchObject({ code: 0x20, k: 4 });
    expect(program[1]).toMatchObject({ code: JEQ, jt: 1, jf: 0 });
    expect(program[2]).toEqual({ code: RET, jt: 0, jf: 0, k: RET_KILL_PROCESS });
  });

  it("refuses every denied syscall with its errno and allows the rest", () => {
    for (const syscall of DENIED_SYSCALLS) {
      const nr = syscall[arch];
      if (nr === undefined) continue;
      expect(verdict(program, nr), syscall.name).toBe((RET_ERRNO | (syscall.errno ?? 1)) >>> 0);
    }
    // read(2) and openat(2) stay allowed.
    expect(verdict(program, arch === "x64" ? 0 : 63)).toBe(RET_ALLOW);
    expect(verdict(program, arch === "x64" ? 257 : 56)).toBe(RET_ALLOW);
  });

  it("denies the calls that would let a program leave or inspect the sandbox", () => {
    const names = DENIED_SYSCALLS.filter((syscall) => syscall[arch] !== undefined).map(
      (syscall) => syscall.name,
    );
    for (const name of [
      "mount",
      "unshare",
      "setns",
      "ptrace",
      "process_vm_readv",
      "bpf",
      "keyctl",
    ]) {
      expect(names).toContain(name);
    }
  });
});

describe("buildSeccompFilter(x64)", () => {
  it("kills x32-ABI syscalls, which would otherwise dodge the number checks", () => {
    const program = decode(buildSeccompFilter("x64"));
    expect(program[4]).toMatchObject({ code: 0x35, k: 0x40000000, jt: 0, jf: 1 });
    expect(program[5]).toEqual({ code: RET, jt: 0, jf: 0, k: RET_KILL_PROCESS });
    expect(verdict(program, 0x40000000)).toBe(RET_KILL_PROCESS);
  });
});
