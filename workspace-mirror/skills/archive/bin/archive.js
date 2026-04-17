#!/usr/bin/env node
import { pruneCache } from "../archive.js";

const HOME = process.env.HOME;
const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const match = args.find(a => a.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : (args.includes(`--${name}`) ? true : fallback);
}
const job = arg("job");
const retainDays = Number(arg("retain_days", 7));
const sandbox = !!arg("sandbox", false);
const DRAFTS = sandbox ? "/tmp/openclaw-smoke" : `${HOME}/openclaw-drafts`;

if (job === "prune-cache") {
  const res = pruneCache({ drafts: DRAFTS, retainDays, now: new Date() });
  console.log(JSON.stringify(res));
} else {
  console.error(`archive: unknown --job=${job}. Supported: prune-cache`);
  process.exit(2);
}
