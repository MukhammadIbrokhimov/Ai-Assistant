#!/usr/bin/env node
// Render the video for an existing pending draft:
//   bin/render.js 2026-04-16-slideshow-abcd
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { renderSlideshow } from "../index.js";

const execFileP = promisify(execFile);

const draftId = process.argv[2];
if (!draftId) {
  console.error("Usage: bin/render.js <draft-id>");
  process.exit(1);
}

const draftsRoot = `${homedir()}/openclaw-drafts`;
const draftDir = `${draftsRoot}/pending/${draftId}`;
const draft = JSON.parse(readFileSync(`${draftDir}/draft.json`, "utf8"));
const storyboard = JSON.parse(readFileSync(`${draftDir}/media/storyboard.json`, "utf8"));

const voice = process.env.OPENCLAW_TTS_VOICE || "Alex";

const result = await renderSlideshow({
  draftId,
  draftsRoot,
  storyboard,
  draft,
  fetchImage: async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetchImage: ${res.status} ${url}`);
    return new Uint8Array(await res.arrayBuffer());
  },
  speak: async ({ text, outPath }) => {
    await execFileP("say", ["-v", voice, "-o", outPath, text]);
  },
  runFfmpeg: async (argv) => execFileP("ffmpeg", argv, { maxBuffer: 32 * 1024 * 1024 }),
  writeFile: (path, content) => writeFileSync(path, content),
  writeDraft: (id, d) => writeFileSync(`${draftsRoot}/pending/${id}/draft.json`, JSON.stringify(d, null, 2)),
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  log: (m) => console.log(m),
});

console.log(result.videoPath);
