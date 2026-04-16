const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

const adapter = {
  name: "anthropic",

  async complete({
    taskClass,
    prompt,
    model,
    apiKeyEnv,
    maxTokens = 1024,
    temperature = 0.7,
  }) {
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      throw new Error(`${apiKeyEnv} is not set in environment`);
    }

    const started = Date.now();
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`anthropic HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = await res.json();
    const text = (json?.content ?? [])
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("");

    return {
      text,
      tokensIn: json?.usage?.input_tokens ?? 0,
      tokensOut: json?.usage?.output_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  },

  async health({ apiKeyEnv, probeModel = "claude-haiku-4-5" }) {
    const started = Date.now();
    try {
      await this.complete({
        taskClass: "bulk-classify",
        prompt: "ok",
        model: probeModel,
        apiKeyEnv,
        maxTokens: 1,
      });
      return { ok: true, latencyMs: Date.now() - started };
    } catch {
      return { ok: false, latencyMs: Date.now() - started };
    }
  },
};

export default adapter;
