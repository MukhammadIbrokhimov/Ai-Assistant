const adapter = {
  name: "ollama",

  async complete({
    taskClass,
    prompt,
    model,
    baseUrl,
    maxTokens = 1024,
    temperature = 0.7,
  }) {
    const started = Date.now();
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        options: { temperature, num_predict: maxTokens },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ollama HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = await res.json();
    return {
      text: json?.message?.content ?? "",
      tokensIn: json?.prompt_eval_count ?? 0,
      tokensOut: json?.eval_count ?? 0,
      latencyMs: Date.now() - started,
    };
  },

  async health({ baseUrl }) {
    const started = Date.now();
    try {
      const res = await fetch(`${baseUrl}/api/tags`);
      return { ok: res.ok, latencyMs: Date.now() - started };
    } catch {
      return { ok: false, latencyMs: Date.now() - started };
    }
  },
};

export default adapter;
