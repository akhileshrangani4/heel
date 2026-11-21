#!/usr/bin/env node
// From a checkout or the OCI image, Node runs heel's TypeScript source
// directly by stripping types. The npm package ships it compiled to dist,
// because Node won't strip types inside node_modules.
import { existsSync } from "node:fs";

const source = new URL("../src/cli/main.ts", import.meta.url);
// Under code mode's locked-down helper, checking a path heel may not read throws instead of
// answering false; it is only ever refused where there's no source to read.
const hasSource = (() => {
  try {
    return existsSync(source);
  } catch {
    return false;
  }
})();
const entry = hasSource ? source : new URL("../dist/cli/main.js", import.meta.url);
const { main, runProgram } = await import(entry.href);

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  exec: runProgram,
});
