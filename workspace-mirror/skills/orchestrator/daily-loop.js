import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { matchTopicToEpisode } from "./topic-episode-match.js";
import { isInQuietHours } from "./time.js";

function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function walkDraftsRecursive(dir, byMode, today) {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const p = join(dir, entry.name);
    const draftFile = join(p, "draft.json");
    if (existsSync(draftFile)) {
      try {
        const d = JSON.parse(readFileSync(draftFile, "utf8"));
        const created = new Date(d.created_at);
        if (!isNaN(created) && sameLocalDay(created, today) && byMode[d.mode] !== undefined) {
          byMode[d.mode]++;
        }
      } catch { /* skip malformed */ }
    } else {
      walkDraftsRecursive(p, byMode, today);
    }
  }
}

function readDraftsByMode(draftsRoot, today) {
  const byMode = { clip: 0, slideshow: 0, quotecard: 0 };
  for (const bucket of ["pending", "approved", "rejected"]) {
    walkDraftsRecursive(join(draftsRoot, bucket), byMode, today);
  }
  return byMode;
}

async function callSkill(mode, skills, topic, episode, transcripts) {
  switch (mode) {
    case "clip": {
      const transcript = episode ? transcripts.find(t => t.episode_id === episode.episode_id) : null;
      return (await skills.clipExtract.run({ transcript, source: episode, videoPath: episode?.video_path })).draft;
    }
    case "slideshow":
      return (await skills.slideshowDraft.run({ topic: topic.topic, niche: topic.niche })).draft;
    case "quotecard":
      return (await skills.quotecardDraft.run({ topic: topic.topic, niche: topic.niche })).draft;
    default:
      throw new Error(`unknown mode: ${mode}`);
  }
}

function isTransient(err) {
  const m = String(err?.message ?? "");
  if (/HTTP (5\d\d|429)/.test(m)) return true;
  if (/ECONN|timeout|ETIMEDOUT|fetch failed/i.test(m)) return true;
  return false;
}

export async function runDailyLoop({
  clock, providerRouter, skills, approval, quietQueue, logger,
  paths, transcripts = [], telegramClient, chatId,
}) {
  const today = clock instanceof Date ? clock : new Date();
  const nichesDoc = yaml.load(readFileSync(join(paths.workspace, "config/niches.yaml"), "utf8"));
  const telegramDoc = yaml.load(readFileSync(join(paths.workspace, "config/telegram.yaml"), "utf8"));
  const niches = Object.keys(nichesDoc?.niches ?? {});

  const produced = readDraftsByMode(paths.drafts, today);
  const modesNeeded = ["clip", "slideshow", "quotecard"].filter(m => produced[m] === 0);
  if (modesNeeded.length === 0) {
    logger.jsonl({ event: "daily_loop_skip", reason: "all_modes_produced_today" });
    return { drafts: [], produced: 0, skipped: [], durationMs: 0 };
  }

  const topics = [];
  for (const niche of niches) {
    try {
      const items = await skills.research.run(niche);
      topics.push(...items);
    } catch (err) {
      logger.errorjsonl(err, { phase: "research", niche });
    }
  }
  topics.sort((a, b) => b.score - a.score);
  if (topics.length === 0) {
    logger.jsonl({ event: "daily_loop_skip", reason: "no_topics" });
    return { drafts: [], produced: 0, skipped: [], durationMs: 0 };
  }

  const assignments = {};
  const usedUrls = new Set();
  if (modesNeeded.includes("clip")) {
    const match = await matchTopicToEpisode(topics, transcripts, providerRouter, { now: today });
    if (match) {
      assignments.clip = { topic: match.topic, episode: match.episode };
      usedUrls.add(match.topic.source_url);
    }
  }
  for (const m of ["slideshow", "quotecard"]) {
    if (!modesNeeded.includes(m)) continue;
    const pick = topics.find(t => !usedUrls.has(t.source_url));
    if (pick) {
      assignments[m] = { topic: pick };
      usedUrls.add(pick.source_url);
    }
  }

  const results = [];
  for (const mode of ["clip", "slideshow", "quotecard"]) {
    if (!assignments[mode]) continue;
    const { topic, episode } = assignments[mode];
    try {
      const draft = await callSkill(mode, skills, topic, episode, transcripts);
      results.push({ mode, draft_id: draft.id, ok: true });
    } catch (err) {
      if (isTransient(err)) {
        try {
          await new Promise(r => setTimeout(r, 2000));
          const draft = await callSkill(mode, skills, topic, episode, transcripts);
          results.push({ mode, draft_id: draft.id, ok: true });
        } catch (retryErr) {
          results.push({ mode, ok: false, reason: retryErr.message });
          logger.errorjsonl(retryErr, { phase: "daily-loop", mode });
        }
      } else {
        results.push({ mode, ok: false, reason: err.message });
        logger.errorjsonl(err, { phase: "daily-loop", mode });
      }
    }
  }

  const inQuiet = isInQuietHours(today, telegramDoc.quiet_hours);
  for (const r of results.filter(r => r.ok)) {
    if (inQuiet) {
      quietQueue.append({
        draft_id: r.draft_id,
        created_at: today.toISOString(),
        mode: r.mode,
        topic: assignments[r.mode].topic.topic,
      });
    } else {
      await approval.sendForApproval(r.draft_id);
    }
  }

  const okCount = results.filter(r => r.ok).length;
  const skipped = [
    ...results.filter(r => !r.ok).map(r => ({ mode: r.mode, reason: r.reason })),
    ...modesNeeded.filter(m => !assignments[m]).map(m => ({ mode: m, reason: "not_selected" })),
  ];
  logger.jsonl({ event: "daily_loop_complete", produced: okCount, skipped });
  if (skipped.length > 0 && telegramClient && chatId) {
    const summary = `📋 Daily loop: ${okCount}/${modesNeeded.length} produced\n` +
      skipped.map(s => `• ${s.mode} skipped: ${s.reason}`).join("\n");
    await telegramClient.sendMessage(chatId, summary);
  }

  return { drafts: results, produced: okCount, skipped, durationMs: 0 };
}
