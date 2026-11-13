/**
 * Runs the boot probe once and prints its verdict as one JSON line. The probe
 * e2e test runs this inside a user namespace whose nesting limit is zero, to
 * see the probe on a host where user namespaces are unavailable.
 */
import { probeSandbox } from "../../src/runner/index.ts";

const probe = await probeSandbox();
const verdict = probe.ok ? { ok: true } : { ok: false, reason: probe.reason, detail: probe.detail };
process.stdout.write(`${JSON.stringify(verdict)}\n`);
