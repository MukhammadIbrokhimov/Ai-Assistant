import { describe, it, expect, vi } from "vitest";
import { createBraveSearch, withSearchLogging } from "../web-search.js";

function mockResp({ ok = true, status = 200, json = {} } = {}) {
  return { ok, status, json: async () => json };
}

describe("createBraveSearch", () => {
  it("throws if apiKey is missing", () => {
    expect(() => createBraveSearch({})).toThrow(/apiKey/);
  });

  it("calls Brave's API with query, count, and subscription header", async () => {
    const fetch = vi.fn(async () => mockResp({ json: { web: { results: [
      { title: "Hit one", url: "https://a.example/1" },
    ] } } }));
    const search = createBraveSearch({ apiKey: "secret", fetch, perQuery: 3 });
    const items = await search("AI agent today");

    expect(fetch).toHaveBeenCalledOnce();
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toContain("api.search.brave.com/res/v1/web/search");
    expect(url).toContain("q=AI%20agent%20today");
    expect(url).toContain("count=3");
    expect(opts.headers["X-Subscription-Token"]).toBe("secret");
    expect(opts.headers["Accept"]).toBe("application/json");
    expect(items).toEqual([{ title: "Hit one", url: "https://a.example/1" }]);
  });

  it("returns [] when Brave returns no results", async () => {
    const fetch = vi.fn(async () => mockResp({ json: { web: { results: [] } } }));
    const search = createBraveSearch({ apiKey: "k", fetch });
    expect(await search("q")).toEqual([]);
  });

  it("returns [] when body has no web.results field at all", async () => {
    const fetch = vi.fn(async () => mockResp({ json: {} }));
    const search = createBraveSearch({ apiKey: "k", fetch });
    expect(await search("q")).toEqual([]);
  });

  it("drops malformed results missing title or url", async () => {
    const fetch = vi.fn(async () => mockResp({ json: { web: { results: [
      { title: "ok", url: "https://a.example/ok" },
      { title: "no url" },
      { url: "https://a.example/no-title" },
      { title: "", url: "https://a.example/empty" },
    ] } } }));
    const search = createBraveSearch({ apiKey: "k", fetch });
    expect(await search("q")).toEqual([{ title: "ok", url: "https://a.example/ok" }]);
  });

  it("throws on non-2xx HTTP (so research's backoff fires)", async () => {
    const fetch = vi.fn(async () => mockResp({ ok: false, status: 429 }));
    const search = createBraveSearch({ apiKey: "k", fetch });
    await expect(search("q")).rejects.toThrow(/HTTP 429/);
  });
});

describe("withSearchLogging", () => {
  it("emits web_search jsonl on success and returns the items", async () => {
    const events = [];
    const inner = vi.fn(async () => [{ title: "t", url: "https://x" }]);
    const wrapped = withSearchLogging(inner, { logger: { jsonl: e => events.push(e) } });
    const items = await wrapped("query A");
    expect(items).toEqual([{ title: "t", url: "https://x" }]);
    expect(events[0].event).toBe("web_search");
    expect(events[0].source).toBe("brave");
    expect(events[0].query).toBe("query A");
    expect(events[0].count).toBe(1);
    expect(events[0].ms).toBeGreaterThanOrEqual(0);
  });

  it("emits web_search_fail and re-throws so research backoff fires", async () => {
    const events = [];
    const inner = vi.fn(async () => { throw new Error("boom"); });
    const wrapped = withSearchLogging(inner, { logger: { jsonl: e => events.push(e) } });
    await expect(wrapped("q")).rejects.toThrow(/boom/);
    expect(events[0].event).toBe("web_search_fail");
    expect(events[0].error).toMatch(/boom/);
  });

  it("works without a logger (jsonl optional)", async () => {
    const inner = vi.fn(async () => [{ title: "t", url: "https://x" }]);
    const wrapped = withSearchLogging(inner);
    await expect(wrapped("q")).resolves.toHaveLength(1);
  });
});
