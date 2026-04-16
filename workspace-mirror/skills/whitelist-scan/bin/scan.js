#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { createSourcesStore } from "shared/sources-store";
import { createYtdlp } from "../ytdlp.js";
import { createWhitelistScan } from "../index.js";

const sourcesPath = `${process.env.HOME}/.openclaw/workspace/config/sources.yaml`;
const cacheRoot = `${process.env.HOME}/openclaw-drafts/whitelist`;

const sourcesStore = createSourcesStore({ path: sourcesPath });
const ytdlp = createYtdlp();

async function freeSpaceBytes() {
  const s = await statfs(cacheRoot);
  return Number(s.bavail) * Number(s.bsize);
}

const scan = createWhitelistScan({
  sourcesStore,
  listNewVideos: ytdlp.listNewVideos,
  downloadAudio: ytdlp.downloadAudio,
  downloadVideo: ytdlp.downloadVideo,
  readManifest: (p) => existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { episodes: [] },
  writeManifest: (p, m) => writeFileSync(p, JSON.stringify(m, null, 2)),
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  freeSpaceBytes,
  now: () => new Date(),
  cacheRoot,
});

mkdirSync(cacheRoot, { recursive: true });
const result = await scan.run();
console.log(JSON.stringify(result));
