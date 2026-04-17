import yaml from "js-yaml";
import { parseRssFeed } from "./rss.js";

export function createResearch({ readFileSync, nichesPath, fetchRss, browserSearch, router }) {
  const rssFetcher = fetchRss || parseRssFeed;

  async function run(niche) {
    const doc = yaml.load(readFileSync(nichesPath, "utf8"));
    const cfg = doc?.niches?.[niche];
    if (!cfg) throw new Error(`unknown niche "${niche}"`);

    // 1. RSS
    const rssItems = [];
    for (const feedUrl of cfg.rss || []) {
      const items = await rssFetcher(feedUrl);
      rssItems.push(...items.map((i) => ({ title: i.title, source_url: i.link })));
    }

    // 2. Web search (with flake tolerance — abort to RSS-only after 3 consecutive failures)
    const today = new Date().toISOString().slice(0, 10);
    const webItems = [];
    let consecutiveFailures = 0;
    for (const qTemplate of cfg.web_search_queries || []) {
      if (consecutiveFailures >= 3) break;  // give up; RSS-only fallback
      const q = qTemplate.replaceAll("{today}", today);
      try {
        const hits = await browserSearch(q);
        webItems.push(...hits.map((h) => ({ title: h.title, source_url: h.url })));
        consecutiveFailures = 0;
      } catch {
        consecutiveFailures++;
      }
    }

    const allItems = [...rssItems, ...webItems];

    // 3. Keyword filter
    const inc = (cfg.keywords_must_include || []).map(s => s.toLowerCase());
    const exc = (cfg.keywords_must_exclude || []).map(s => s.toLowerCase());
    const filtered = allItems.filter((it) => {
      const t = it.title.toLowerCase();
      if (inc.length && !inc.some(k => t.includes(k))) return false;
      if (exc.some(k => t.includes(k))) return false;
      return true;
    });

    if (filtered.length === 0) return [];

    // 4. LLM dedupe → indices to keep
    const dedupePrompt = `You will receive an array of headlines. Identify which ones are near-duplicates of each other (same story, different sources). Return a JSON object: {"keep":[indices]} listing indices (0-based) of items to KEEP (one per unique story). Headlines:\n${filtered.map((it, i) => `[${i}] ${it.title}`).join("\n")}\n\nReturn ONLY the JSON.`;
    const dedupeResp = await router.complete({
      taskClass: "bulk-classify",
      prompt: dedupePrompt,
      maxTokens: 500,
    });
    let keepIndices;
    try {
      keepIndices = JSON.parse(dedupeResp.text).keep;
    } catch {
      keepIndices = filtered.map((_, i) => i);
    }
    const deduped = keepIndices.map(i => filtered[i]).filter(Boolean);

    // 5. LLM rank
    const rankPrompt = `You are ranking headlines for potential short-form social media engagement. Return a JSON array ordered by engagement potential (highest first), each item: {"topic":"<headline>","source_url":"<url>","score":<0.0-1.0>}. Return max 5 items.\n\nHeadlines:\n${deduped.map((it, i) => `[${i}] ${it.title} (${it.source_url})`).join("\n")}\n\nReturn ONLY the JSON array.`;
    const rankResp = await router.complete({
      taskClass: "reason",
      prompt: rankPrompt,
      maxTokens: 1000,
    });
    let ranked;
    try {
      ranked = JSON.parse(rankResp.text);
    } catch {
      ranked = deduped.slice(0, 5).map((it, i) => ({
        topic: it.title, source_url: it.source_url, score: 1 - i * 0.1,
      }));
    }
    return ranked.slice(0, 5).map(r => ({ ...r, niche }));
  }

  return { run };
}
