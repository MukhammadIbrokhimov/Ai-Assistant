#!/usr/bin/env node
import { createRouter } from "../router.js";
import ollama from "../providers/ollama.js";
import anthropic from "../providers/anthropic.js";
import { CONFIG_PATH } from "../lib/load-config.js";
import { join } from "node:path";
import { homedir } from "node:os";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const router = createRouter({
  configPath: CONFIG_PATH,
  adapters: { ollama, anthropic },
  logPath: join(homedir(), "openclaw-drafts", "logs", "router.jsonl"),
});

const result = await router.complete({
  taskClass: args["task-class"] ?? "write",
  prompt: args.prompt ?? "say hello",
  maxTokens: args["max-tokens"] ? Number(args["max-tokens"]) : 200,
});

console.log(JSON.stringify({ ...result, mode: router.getMode() }, null, 2));
