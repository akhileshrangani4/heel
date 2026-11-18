#!/usr/bin/env node
// From a checkout or the OCI image, Node runs heel's TypeScript source
// directly by stripping types. The npm package ships it compiled to dist,
// because Node won't strip types inside node_modules.
import { existsSync } from "node:fs";

const source = new URL("../src/cli/main.ts", import.meta.url);
const entry = existsSync(source) ? source : new URL("../dist/cli/main.js", import.meta.url);
const { main } = await import(entry.href);

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
