#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
let vitestArgs;

if (args.length === 0) {
  vitestArgs = ["vitest", "run"];
} else if (args[0] === "--run") {
  vitestArgs = ["vitest", "run", ...args.slice(1)];
} else {
  vitestArgs = ["vitest", "related", "--run", "--passWithNoTests", ...args];
}

const result = spawnSync("npx", vitestArgs, {
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
