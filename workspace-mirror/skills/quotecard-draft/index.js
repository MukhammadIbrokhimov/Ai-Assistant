import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export function createRenderCard({ pythonBin = "python3", scriptPath }) {
  if (pythonBin.startsWith("/") && !existsSync(pythonBin)) {
    throw new Error(
      `createRenderCard: Python interpreter not found at "${pythonBin}". ` +
      `Run Phase 1 install: python3 -m venv ~/.openclaw/workspace/.venv && ` +
      `~/.openclaw/workspace/.venv/bin/pip install Pillow`
    );
  }
  if (!existsSync(scriptPath)) {
    throw new Error(`createRenderCard: render.py not found at "${scriptPath}"`);
  }
  return async function renderCard(spec, outPath) {
    return new Promise((resolve, reject) => {
      const proc = spawn(pythonBin, [scriptPath]);
      let stdout = "", stderr = "";
      proc.stdout.on("data", (d) => { stdout += d; });
      proc.stderr.on("data", (d) => { stderr += d; });
      proc.on("close", (code) => {
        if (code !== 0) return reject(new Error(`render.py exit ${code}: ${stderr}`));
        resolve(stdout.trim() || outPath);
      });
      proc.on("error", reject);
      proc.stdin.write(JSON.stringify({ ...spec, out_path: outPath }));
      proc.stdin.end();
    });
  };
}

export function createQuotecardDraft(deps) {
  const { router, renderCard, writeDraft, mkdirp, now, draftsRoot, idGenerator } = deps;

  async function run({ topic, niche, sourceContext = null }) {
    const id = idGenerator();
    const draftDir = `${draftsRoot}/pending/${id}`;
    mkdirp(`${draftDir}/media`);

    let quoteResp;
    if (sourceContext) {
      quoteResp = await router.complete({
        taskClass: "extract",
        prompt: `From the passage below, extract a single punchy quote (1-2 sentences) that stands alone and would work as a quote card. Return only the quote text, no quotation marks.\n\nPassage:\n${sourceContext}`,
        maxTokens: 200,
      });
    } else {
      quoteResp = await router.complete({
        taskClass: "write",
        prompt: `Write a single punchy quote (1-2 sentences) about: "${topic}". It should feel like something a thoughtful practitioner would say — not a marketing tagline. Niche: ${niche}. Return only the quote.`,
        maxTokens: 200,
      });
    }
    const quote = quoteResp.text.trim().replace(/^["'"]+|["'"]+$/g, "");

    const spec = {
      quote,
      attribution: sourceContext ? "source" : "",
      niche,
      template: "default",
    };
    const cardPath = `${draftDir}/media/card.png`;
    await renderCard(spec, cardPath);

    const capResp = await router.complete({
      taskClass: "write",
      prompt: `Write a 1-2 sentence caption (max 200 chars) for an Instagram post of a quote card about: "${topic}". Tone: thoughtful. No hashtags.`,
      maxTokens: 150,
    });
    const hashResp = await router.complete({
      taskClass: "write",
      prompt: `Return 10 relevant hashtags (space-separated, each prefixed with #) for the niche "${niche}" about "${topic}". No explanation.`,
      maxTokens: 100,
    });
    const hashtags = hashResp.text.split(/\s+/).filter(t => t.startsWith("#")).slice(0, 12);

    const draft = {
      id,
      created_at: now().toISOString(),
      mode: "quotecard",
      topic,
      niche,
      caption: capResp.text.trim(),
      hashtags,
      media: [{ path: "media/card.png", type: "image" }],
      source: null,
      provider_used: quoteResp.provider || null,
      tokens_in: (quoteResp.tokens_in || 0) + (capResp.tokens_in || 0) + (hashResp.tokens_in || 0),
      tokens_out: (quoteResp.tokens_out || 0) + (capResp.tokens_out || 0) + (hashResp.tokens_out || 0),
      status: "pending",
      parent_id: null,
    };
    writeDraft(id, draft);
    return { draft, cardPath, dir: draftDir };
  }

  return { run };
}
