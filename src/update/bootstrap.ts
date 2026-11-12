#!/usr/bin/env node
/**
 * Entry for install.sh and install.ps1: runs `sculk update` from a fresh clone before its dependencies are installed
 * (src/cli.ts loads every feature and needs node_modules). Usage: node src/update/bootstrap.ts --install [...]
 */
import { runMain } from "../core/cli.ts";
import { runUpdate } from "./cli.ts";

void runMain(() => runUpdate(process.argv.slice(2)));
