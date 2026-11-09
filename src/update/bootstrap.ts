#!/usr/bin/env node
/**
 * Entry for install.sh and install.ps1: runs `sculk update` from a fresh clone before its dependencies are installed
 * (src/cli.ts loads every feature and needs node_modules). Usage: node src/update/bootstrap.ts --install [...]
 */
import { runUpdate } from "./cli.ts";

runUpdate(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 2;
  },
);
