const STOPWORDS = new Set([
  "the","a","an","and","or","but","of","in","on","at","to","for","with","by",
  "is","are","was","were","be","been","being","has","have","had","do","does","did",
  "this","that","these","those","it","its","as","from","up","about","into","over",
  "then","than","so","if","not","no"
]);

function stem(word) {
  if (word.length <= 3) return word;
  if (word.endsWith("ing")) return word.slice(0, -3);
  if (word.endsWith("ed")) return word.slice(0, -2);
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

export function keywords(text) {
  const tokens = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => !STOPWORDS.has(w))
    .map(stem);
  return new Set(tokens);
}

export function jaccard(a, b) {
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

const RECENT_DAYS = 7;
const KEYWORD_FALLBACK_THRESHOLD = 0.15;
const LLM_CONFIDENCE_THRESHOLD = 0.5;

function daysSince(isoTs, now) {
  return (now.getTime() - new Date(isoTs).getTime()) / (1000 * 60 * 60 * 24);
}

function summarySnippet(ep) {
  return (ep.segments || []).slice(0, 20).map(s => s.text).join(" ");
}

function renderMatchPrompt(topic, candidates) {
  const list = candidates.map((c, i) =>
    `${i + 1}. episode_id=${c.ep.episode_id}\n   title: ${c.ep.title}\n   snippet: ${summarySnippet(c.ep).slice(0, 400)}`
  ).join("\n\n");
  return `Pick the best episode match for this topic. Return JSON {best_episode_id, confidence, reasoning}.\n\nTopic: ${topic.topic}\n\nCandidates:\n${list}`;
}

export async function matchTopicToEpisode(topics, transcripts, router, { now = new Date() } = {}) {
  const recent = (transcripts || []).filter(t => daysSince(t.transcribed_at, now) <= RECENT_DAYS);
  if (recent.length === 0) return null;

  for (const topic of topics) {
    const kwTopic = keywords(topic.topic);
    const scored = recent.map(ep => {
      const kwEp = keywords(ep.title + " " + summarySnippet(ep));
      return { ep, score: jaccard(kwTopic, kwEp) };
    }).sort((a, b) => b.score - a.score).slice(0, 3);

    if (scored.length === 0 || scored[0].score === 0) continue;

    try {
      const prompt = renderMatchPrompt(topic, scored);
      const resp = await router.complete({ taskClass: "reason", prompt });
      const parsed = typeof resp === "string"
        ? JSON.parse(resp)
        : (resp?.parsed ?? JSON.parse(resp?.text ?? "{}"));
      if (parsed?.confidence >= LLM_CONFIDENCE_THRESHOLD) {
        const pick = scored.find(c => c.ep.episode_id === parsed.best_episode_id);
        if (pick) return { topic, episode: pick.ep, confidence: parsed.confidence, via: "llm" };
      }
    } catch {
      // fall through to keyword
    }

    if (scored[0].score >= KEYWORD_FALLBACK_THRESHOLD) {
      return { topic, episode: scored[0].ep, confidence: scored[0].score, via: "keyword" };
    }
  }

  return null;
}
