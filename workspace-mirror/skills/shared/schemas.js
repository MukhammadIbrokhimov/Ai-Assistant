function topLevelGuard(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { valid: false, errors: ["input must be a non-null object"] };
  }
  return null;
}

function req(errors, obj, key, kind) {
  if (obj[key] === undefined || obj[key] === null) {
    errors.push(`${key} required`);
    return false;
  }
  if (kind && typeof obj[key] !== kind && !(kind === "array" && Array.isArray(obj[key]))) {
    errors.push(`${key} must be ${kind}`);
    return false;
  }
  return true;
}

export function validateTranscript(t) {
  const guard = topLevelGuard(t);
  if (guard) return guard;
  const errors = [];
  req(errors, t, "source_id", "string");
  req(errors, t, "episode_id", "string");
  req(errors, t, "title", "string");
  req(errors, t, "language", "string");
  req(errors, t, "duration_s", "number");
  req(errors, t, "transcribed_at", "string");
  req(errors, t, "model", "string");
  if (!Array.isArray(t?.segments)) {
    errors.push("segments must be array");
  } else {
    t.segments.forEach((s, i) => {
      if (typeof s?.t_start !== "number" || s.t_start < 0) errors.push(`segments[${i}].t_start invalid`);
      if (typeof s?.t_end !== "number" || s.t_end <= s.t_start) errors.push(`segments[${i}].t_end invalid`);
      if (typeof s?.text !== "string") errors.push(`segments[${i}].text must be string`);
    });
  }
  return { valid: errors.length === 0, errors };
}

export function validateStoryboard(s) {
  const guard = topLevelGuard(s);
  if (guard) return guard;
  const errors = [];
  req(errors, s, "script", "string");
  req(errors, s, "duration_s", "number");
  if (!Array.isArray(s?.beats) || s.beats.length === 0) {
    errors.push("beats must be non-empty array");
  } else {
    s.beats.forEach((b, i) => {
      if (typeof b?.text !== "string") errors.push(`beats[${i}].text required`);
      if (typeof b?.duration_s !== "number") errors.push(`beats[${i}].duration_s required`);
      if (typeof b?.image_url !== "string") errors.push(`beats[${i}].image_url required`);
    });
  }
  return { valid: errors.length === 0, errors };
}

const ATTRIBUTION_PLACEHOLDERS = ["{episode_title}", "{episode_num}", "{creator}"];
const VALID_DISCOVERY_MODES = new Set(["push", "pull"]);

export function validateCandidate(c) {
  const guard = topLevelGuard(c);
  if (guard) return guard;
  const errors = [];
  req(errors, c, "candidate_id", "string");
  req(errors, c, "discovered_at", "string");
  if (!VALID_DISCOVERY_MODES.has(c?.discovery_mode)) {
    errors.push("discovery_mode must be push|pull");
  }
  req(errors, c, "creator", "string");
  req(errors, c, "channel_id", "string");
  req(errors, c, "url", "string");
  req(errors, c, "niche", "string");
  if (typeof c?.niche_fit_confidence !== "number" || c.niche_fit_confidence < 0 || c.niche_fit_confidence > 1) {
    errors.push("niche_fit_confidence must be in [0,1]");
  }
  if (typeof c?.recommendation_confidence !== "number" || c.recommendation_confidence < 0 || c.recommendation_confidence > 1) {
    errors.push("recommendation_confidence must be in [0,1]");
  }
  req(errors, c, "license_type", "string");
  req(errors, c, "license_evidence_url", "string");
  req(errors, c, "license_evidence_snippet", "string");
  if (typeof c?.attribution_template !== "string" || c.attribution_template.length === 0) {
    errors.push("attribution_template required");
  } else if (!ATTRIBUTION_PLACEHOLDERS.some(p => c.attribution_template.includes(p))) {
    errors.push(`attribution_template must contain one of ${ATTRIBUTION_PLACEHOLDERS.join(", ")}`);
  }
  return { valid: errors.length === 0, errors };
}
