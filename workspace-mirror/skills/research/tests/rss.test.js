import { describe, it, expect, vi } from "vitest";
import { parseRssFeed } from "../rss.js";

describe("parseRssFeed", () => {
  it("extracts title + link + pubDate from parsed feed", async () => {
    const fakeParse = vi.fn(async () => ({
      items: [
        { title: "One", link: "https://x/1", pubDate: "2026-04-16T10:00:00Z", contentSnippet: "..." },
        { title: "Two", link: "https://x/2", pubDate: "2026-04-15T10:00:00Z" },
      ],
    }));
    const items = await parseRssFeed("https://feed.example.com", { parseUrl: fakeParse });
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ title: "One", link: "https://x/1", pubDate: "2026-04-16T10:00:00Z" });
  });

  it("returns empty array on parser failure", async () => {
    const fakeParse = vi.fn(async () => { throw new Error("bad feed"); });
    const items = await parseRssFeed("https://bad.example.com", { parseUrl: fakeParse });
    expect(items).toEqual([]);
  });
});
