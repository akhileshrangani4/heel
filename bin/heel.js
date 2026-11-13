#!/usr/bin/env node
// Node 26 runs heel's TypeScript directly by stripping types, so the entry
// point imports the source; nothing is compiled.
import { main } from "../src/cli/main.ts";

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
