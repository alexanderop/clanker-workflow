#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { buildNodeDeps } from "./node-deps.js";
import { dispatch } from "./dispatch.js";

const cliPath = fileURLToPath(import.meta.url);
const deps = await buildNodeDeps(cliPath);
const code = await dispatch(process.argv.slice(2), deps);

// `watch` stays alive via fs.watch handles until the run finishes (the tail closes the
// watcher), so it exits naturally. Every other command has fully completed by here.
if (process.argv[2] !== "watch") process.exit(code);
