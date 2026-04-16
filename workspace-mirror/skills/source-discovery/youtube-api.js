const API = "https://www.googleapis.com/youtube/v3";

export function createYouTubeClient({ apiKey, fetch: f = fetch }) {
  async function getChannelById(channelId) {
    const url = `${API}/channels?part=snippet,statistics&id=${channelId}&key=${apiKey}`;
    const r = await f(url);
    if (!r.ok) throw new Error(`YouTube HTTP ${r.status}`);
    const body = await r.json();
    const item = body.items?.[0];
    if (!item) return null;
    return {
      id: item.id,
      title: item.snippet?.title,
      handle: item.snippet?.customUrl || null,
      subs: Number(item.statistics?.subscriberCount || 0),
      description: item.snippet?.description || "",
    };
  }

  async function searchChannelsInNiche(niche, { publishedAfterDays = 30, maxResults = 25 } = {}) {
    const since = new Date(Date.now() - publishedAfterDays * 24 * 3600 * 1000).toISOString();
    const url = `${API}/search?part=snippet&type=channel&q=${encodeURIComponent(niche)}&publishedAfter=${since}&maxResults=${maxResults}&key=${apiKey}`;
    const r = await f(url);
    if (!r.ok) throw new Error(`YouTube search HTTP ${r.status}`);
    const body = await r.json();
    return (body.items || []).map(i => ({ id: i.id?.channelId, title: i.snippet?.title }));
  }

  async function getRecentVideoStats(channelId) {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const searchUrl = `${API}/search?part=id&channelId=${channelId}&publishedAfter=${since}&type=video&order=date&maxResults=10&key=${apiKey}`;
    const sr = await f(searchUrl);
    if (!sr.ok) return { recent_30d_views: 0 };
    const sb = await sr.json();
    const ids = (sb.items || []).map(i => i.id?.videoId).filter(Boolean);
    if (ids.length === 0) return { recent_30d_views: 0 };
    const videosUrl = `${API}/videos?part=statistics&id=${ids.join(",")}&key=${apiKey}`;
    const vr = await f(videosUrl);
    if (!vr.ok) return { recent_30d_views: 0 };
    const vb = await vr.json();
    const total = (vb.items || []).reduce((sum, v) => sum + Number(v.statistics?.viewCount || 0), 0);
    return { recent_30d_views: total };
  }

  return { getChannelById, searchChannelsInNiche, getRecentVideoStats };
}
