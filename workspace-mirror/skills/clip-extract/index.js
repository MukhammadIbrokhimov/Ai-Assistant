import { buildClipSrt } from "./srt.js";

export function createClipExtract(deps) {
  const { router, runFfmpeg, writeDraft, writeFileSync, mkdirp, now, draftsRoot, idGenerator } = deps;

  function renderAttribution(template, episodeTitle, creator) {
    return template
      .replace("{episode_title}", episodeTitle || "")
      .replace("{creator}", creator || "")
      .replace(/\{episode_num\}/g, "");
  }

  async function run({ transcript, source, videoPath }) {
    const prompt = `You are scanning a podcast transcript for viral clippable moments. Given these transcript segments, return a JSON array of the top 3 candidates. Each candidate must be 40-60 seconds long.
Return format:
[{"start_s": <float>, "end_s": <float>, "reasoning": "<short>", "hook_quote": "<exact quote>"}]

Transcript (full segments):
${transcript.segments.map(s => `[${s.t_start.toFixed(1)}-${s.t_end.toFixed(1)}] ${s.text}`).join("\n")}

Return ONLY the JSON array.`;
    const pickResp = await router.complete({ taskClass: "reason", prompt, maxTokens: 1000 });
    let candidates;
    try { candidates = JSON.parse(pickResp.text); } catch { throw new Error(`clip-extract: LLM picker JSON invalid`); }
    if (!Array.isArray(candidates) || candidates.length === 0) throw new Error(`clip-extract: no candidates returned`);
    const pick = candidates[0];

    const id = idGenerator();
    const draftDir = `${draftsRoot}/pending/${id}`;
    mkdirp(`${draftDir}/media`);
    const srtPath = `${draftDir}/media/clip.srt`;
    writeFileSync(srtPath, buildClipSrt(transcript.segments, pick.start_s, pick.end_s));

    const outputPath = `${draftDir}/media/0.mp4`;
    await runFfmpeg({ startS: pick.start_s, endS: pick.end_s, inputPath: videoPath, outputPath, srtPath });

    const attribution = renderAttribution(source.attribution_template, transcript.title, source.creator || source.title);
    const capResp = await router.complete({
      taskClass: "write",
      prompt: `Write a 1-2 sentence Instagram caption (max 200 chars) for a clip. Tone: thoughtful. End with: "${attribution}". Do not include hashtags. Clip content:\n"${pick.hook_quote}"`,
      maxTokens: 200,
    });
    const hashResp = await router.complete({
      taskClass: "write",
      prompt: `Return 10 relevant hashtags (space-separated, each prefixed with #) for a clip from the "${source.id}" channel about: "${pick.hook_quote}". No explanation.`,
      maxTokens: 100,
    });
    const hashtags = hashResp.text.split(/\s+/).filter(t => t.startsWith("#")).slice(0, 12);

    const draft = {
      id,
      created_at: now().toISOString(),
      mode: "clip",
      topic: pick.hook_quote.slice(0, 80),
      niche: (source.niches && source.niches[0]) || "ai",
      caption: capResp.text.trim(),
      hashtags,
      media: [{ path: "media/0.mp4", type: "video", duration_s: Math.round(pick.end_s - pick.start_s) }],
      source: {
        url: source.url || null,
        title: transcript.title,
        creator: source.creator || source.title,
        license: source.license,
        attribution_required: true,
        attribution_template: source.attribution_template,
        attribution,
        clip_range: [pick.start_s, pick.end_s],
      },
      provider_used: pickResp.provider || null,
      tokens_in: (pickResp.tokens_in || 0) + (capResp.tokens_in || 0) + (hashResp.tokens_in || 0),
      tokens_out: (pickResp.tokens_out || 0) + (capResp.tokens_out || 0) + (hashResp.tokens_out || 0),
      status: "pending",
      parent_id: null,
    };
    writeDraft(id, draft);
    return { draft, dir: draftDir };
  }

  return { run };
}
