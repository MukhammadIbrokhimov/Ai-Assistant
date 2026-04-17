import { validateCandidate } from "shared/schemas";
import { regexPrecheck, validateEvidenceSnippet } from "./policy-check.js";

const CONFIDENCE_THRESHOLD = 0.7;

function extractChannelIdFromUrl(url) {
  const handleMatch = url.match(/\/@([^/?]+)/);
  if (handleMatch) return { handle: handleMatch[1] };
  const idMatch = url.match(/\/channel\/([^/?]+)/);
  if (idMatch) return { id: idMatch[1] };
  return null;
}

function extractFirstUrl(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s<>"']+/);
  return m ? m[0] : null;
}

export function createSourceDiscovery(deps) {
  const { youtube, browser, router, telegramSendCandidate, pendingSourceStore, now, idGenerator } = deps;

  async function evaluateCandidate({ channel, discovery_mode, niche }) {
    let pageResult;
    try {
      if (channel.policy_url) {
        pageResult = await browser.fetchPage(channel.policy_url);
      } else {
        const url = extractFirstUrl(channel.description || "");
        pageResult = url
          ? await browser.fetchPage(url)
          : { text: channel.description || "", url: channel.url || "" };
      }
    } catch {
      return null;
    }
    if (!pageResult?.text) return null;

    if (!regexPrecheck(pageResult.text)) return null;

    const llmResp = await router.complete({
      taskClass: "bulk-classify",
      prompt: `From the page text below, return a JSON object:
{
  "license_type": "permission-granted" | "restricted" | "unclear",
  "confidence": 0.0-1.0,
  "evidence_snippet_verbatim": "EXACT substring copied from page text — no paraphrasing, must be findable via Ctrl-F",
  "attribution_template": "template using {episode_title} or {episode_num} or {creator}",
  "niche_fit": "ai" | "finance" | "make-money-with-ai" | "other",
  "niche_fit_confidence": 0.0-1.0
}

Page URL: ${pageResult.url}
Page text (first 4000 chars):
${pageResult.text.slice(0, 4000)}

Return ONLY the JSON object.`,
      maxTokens: 400,
    });
    let parsed;
    try { parsed = JSON.parse(llmResp.text); } catch { return null; }

    if (!validateEvidenceSnippet(parsed.evidence_snippet_verbatim, pageResult.text)) return null;

    if (parsed.license_type !== "permission-granted") return null;
    const recommendation_confidence = Math.min(parsed.confidence || 0, parsed.niche_fit_confidence || 0);
    if (recommendation_confidence < CONFIDENCE_THRESHOLD) return null;

    const { recent_30d_views } = await youtube.getRecentVideoStats(channel.id);
    const velocity_score = channel.subs > 0 ? recent_30d_views / channel.subs : 0;

    const candidate = {
      candidate_id: idGenerator(),
      discovered_at: now().toISOString(),
      discovery_mode,
      creator: channel.title,
      channel_id: channel.id,
      channel_handle: channel.handle || null,
      url: `https://www.youtube.com/channel/${channel.id}`,
      subs: channel.subs,
      recent_30d_views,
      velocity_score,
      niche,
      niche_fit_confidence: parsed.niche_fit_confidence,
      license_type: parsed.license_type,
      license_evidence_url: pageResult.url,
      license_evidence_snippet: parsed.evidence_snippet_verbatim,
      attribution_template: parsed.attribution_template,
      recommendation_confidence,
    };

    const v = validateCandidate(candidate);
    if (!v.valid) return null;

    return candidate;
  }

  async function runPush(url, niche = "ai") {
    const locate = extractChannelIdFromUrl(url);
    if (!locate) return { candidate: null, reason: "unparseable url" };
    const channel = locate.id
      ? await youtube.getChannelById(locate.id)
      : await youtube.getChannelById(`@${locate.handle}`);
    if (!channel) return { candidate: null, reason: "channel not found" };

    const candidate = await evaluateCandidate({ channel, discovery_mode: "push", niche });
    if (!candidate) return { candidate: null, reason: "filtered" };

    pendingSourceStore.create(candidate);
    await telegramSendCandidate(candidate);
    return { candidate };
  }

  async function runPull(niche = "ai", { maxCandidates = 3 } = {}) {
    const channels = await youtube.searchChannelsInNiche(niche);
    const candidates = [];
    for (const { id } of channels) {
      if (candidates.length >= maxCandidates) break;
      const ch = await youtube.getChannelById(id);
      if (!ch) continue;
      const candidate = await evaluateCandidate({ channel: ch, discovery_mode: "pull", niche });
      if (candidate) {
        pendingSourceStore.create(candidate);
        await telegramSendCandidate(candidate);
        candidates.push(candidate);
      }
    }
    return { candidates };
  }

  return { runPush, runPull, evaluateCandidate };
}
