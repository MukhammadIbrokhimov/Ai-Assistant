import Parser from "rss-parser";

const defaultParser = new Parser({ timeout: 10000 });

export async function parseRssFeed(url, { parseUrl, logger } = {}) {
  const fn = parseUrl || ((u) => defaultParser.parseURL(u));
  try {
    const feed = await fn(url);
    return (feed.items || []).map((i) => ({
      title: i.title,
      link: i.link,
      pubDate: i.pubDate || i.isoDate || null,
    }));
  } catch (err) {
    logger?.jsonl?.({ event: "rss_fetch_fail", url, error: String(err?.message ?? err) });
    return [];
  }
}
