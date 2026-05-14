// Brave Search adapter for the research skill's `browserSearch` slot.
// Returns the shape research expects: [{title, url}, ...].
// 2k free/month, no card required. Set BRAVE_SEARCH_API_KEY in .env.

export function createBraveSearch({ apiKey, fetch: f = fetch, perQuery = 5 }) {
  if (!apiKey) throw new Error("createBraveSearch: apiKey required");
  async function search(query) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${perQuery}`;
    const resp = await f(url, {
      headers: {
        "Accept": "application/json",
        "X-Subscription-Token": apiKey,
      },
    });
    if (!resp.ok) throw new Error(`Brave Search HTTP ${resp.status}`);
    const body = await resp.json();
    const results = body?.web?.results ?? [];
    return results.map(r => ({ title: r.title, url: r.url })).filter(r => r.title && r.url);
  }
  return search;
}

// Optional logging wrapper so research.run can emit web_search events without
// changing its signature. Wrap createBraveSearch's return value if a logger
// is available; pass through errors so the existing 3-failure backoff in
// research/index.js still fires.
export function withSearchLogging(search, { logger, source = "brave" } = {}) {
  return async function loggedSearch(query) {
    const t0 = Date.now();
    try {
      const items = await search(query);
      logger?.jsonl?.({
        event: "web_search", source, query, count: items.length, ms: Date.now() - t0,
      });
      return items;
    } catch (err) {
      logger?.jsonl?.({
        event: "web_search_fail", source, query, ms: Date.now() - t0,
        error: String(err?.message ?? err),
      });
      throw err;
    }
  };
}
