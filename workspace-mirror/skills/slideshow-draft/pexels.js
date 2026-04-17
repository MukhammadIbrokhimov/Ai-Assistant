export function createPexelsClient({ apiKey, fetch: f = fetch }) {
  async function searchOne(query) {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1`;
    const resp = await f(url, { headers: { Authorization: apiKey } });
    if (!resp.ok) throw new Error(`Pexels HTTP ${resp.status}`);
    const body = await resp.json();
    const photo = body.photos?.[0];
    if (!photo) throw new Error(`no Pexels result for "${query}"`);
    return {
      id: photo.id,
      url: photo.src?.large || photo.src?.medium,
      photographer: photo.photographer,
    };
  }
  return { searchOne };
}
