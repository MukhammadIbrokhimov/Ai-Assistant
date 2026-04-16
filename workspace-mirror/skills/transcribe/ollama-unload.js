export function createOllamaUnloader({ baseUrl = "http://127.0.0.1:11434", fetch: f = fetch, models = ["qwen2.5:14b", "llama3.1:8b"] } = {}) {
  async function unload() {
    const results = await Promise.allSettled(models.map(async (m) => {
      const r = await f(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: m, prompt: "", keep_alive: 0 }),
      });
      return { model: m, ok: r.ok };
    }));
    return results.every(r => r.status === "fulfilled");
  }
  return { unload };
}
