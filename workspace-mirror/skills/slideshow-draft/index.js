export function createSlideshowDraft(deps) {
  const { router, pexelsSearch, writeDraft, writeMedia, mkdirp, now, draftsRoot, idGenerator } = deps;

  async function run({ topic, niche, sourceContext = null }) {
    const id = idGenerator();
    const draftDir = `${draftsRoot}/pending/${id}`;
    mkdirp(`${draftDir}/media`);

    // Step 1: script
    const scriptResp = await router.complete({
      taskClass: "write",
      prompt: `Write a 60-second spoken-word script (target ~150-180 words) for a short-form social video about: "${topic}". Niche: ${niche}. Tone: direct, curious, non-clickbait. Return just the script, no stage directions.`,
      maxTokens: 500,
    });
    const script = scriptResp.text.trim();

    // Step 2: split into 6 beats
    const splitResp = await router.complete({
      taskClass: "write",
      prompt: `Split this 60-second script into exactly 6 beats of ~10 seconds each. Return a JSON array [{"text":"..."}]. Script:\n\n${script}`,
      maxTokens: 800,
    });
    let beatTexts;
    try {
      beatTexts = JSON.parse(splitResp.text);
    } catch {
      throw new Error(`slideshow-draft: beat split JSON parse failed`);
    }
    if (!Array.isArray(beatTexts) || beatTexts.length !== 6) {
      throw new Error(`slideshow-draft: expected 6 beats, got ${beatTexts?.length}`);
    }

    // Step 3: caption (do this BEFORE keyword extracts to keep mock-call ordering simple)
    const capResp = await router.complete({
      taskClass: "write",
      prompt: `Write a punchy single-paragraph caption (max 220 chars) for a short video about: "${topic}". Niche: ${niche}. No hashtags. No emojis unless they genuinely land.`,
      maxTokens: 200,
    });

    // Step 4: hashtags
    const hashResp = await router.complete({
      taskClass: "write",
      prompt: `Return 10 relevant hashtags (space-separated, each prefixed with #) for a post in niche "${niche}" about: "${topic}". No explanation.`,
      maxTokens: 100,
    });
    const caption = capResp.text.trim();
    const hashtags = hashResp.text.split(/\s+/).filter(t => t.startsWith("#")).slice(0, 12);

    // Step 5: per-beat keywords + Pexels
    const beats = [];
    for (const b of beatTexts) {
      const kwResp = await router.complete({
        taskClass: "extract",
        prompt: `Return a JSON array of 2-3 concrete visual search keywords (nouns, not adjectives) that match this sentence. Sentence: "${b.text}"`,
        maxTokens: 100,
      });
      let keywords;
      try { keywords = JSON.parse(kwResp.text); } catch { keywords = [b.text.split(" ").slice(0, 3).join(" ")]; }
      const photo = await pexelsSearch(keywords.join(" "));
      beats.push({
        text: b.text,
        duration_s: 10,
        keywords,
        pexels_photo_id: photo.id,
        image_url: photo.url,
        pexels_attribution: `Photo by ${photo.photographer} on Pexels`,
      });
    }

    const storyboard = { script, duration_s: 60, beats };

    const draft = {
      id,
      created_at: now().toISOString(),
      mode: "slideshow",
      topic,
      niche,
      caption,
      hashtags,
      media: [{ path: "media/storyboard.json", type: "storyboard", duration_s: 60 }],
      source: null,
      provider_used: scriptResp.provider || null,
      tokens_in: (scriptResp.tokens_in || 0) + (splitResp.tokens_in || 0) + (capResp.tokens_in || 0) + (hashResp.tokens_in || 0),
      tokens_out: (scriptResp.tokens_out || 0) + (splitResp.tokens_out || 0) + (capResp.tokens_out || 0) + (hashResp.tokens_out || 0),
      status: "pending",
      parent_id: null,
    };

    writeDraft(id, draft);
    writeMedia(`${draftDir}/media/storyboard.json`, JSON.stringify(storyboard, null, 2));
    return { draft, storyboard, dir: draftDir };
  }

  return { run };
}
