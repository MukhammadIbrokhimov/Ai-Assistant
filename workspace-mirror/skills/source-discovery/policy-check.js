// Match clip-permission language in either direction:
//   forward:  "clipping is allowed"      (clip-word → permission-word)
//   reverse:  "feel free to clip"        (permission-word → clip-word)
// Permission verbs use \w* tail to absorb suffixes ("allowed", "permitted", "welcoming").
const PERMISSION_FORWARD = /\b(clip|clipping|highlight|repost|excerpt|short)s?\b.{0,60}\b(allow|grant|permit|welcom|encourage|ok|fine)\w*\b/i;
const PERMISSION_REVERSE = /\b(allow|grant|permit|welcom|encourage|free|ok|fine|feel free)\w*\b.{0,60}\b(clip|clipping|highlight|repost|excerpt|short)s?\b/i;
const CC_OK = /creative commons\s*(attribution|BY)(?!\s*[-–—]?\s*(NC|ND|NonCommercial|NoDerivatives))/i;
const CC_RESTRICTED = /creative commons\s*[-–—]?\s*(NC|ND|NonCommercial|NoDerivatives)/i;

export function regexPrecheck(pageText) {
  if (CC_RESTRICTED.test(pageText)) return false;
  if (CC_OK.test(pageText)) return true;
  return PERMISSION_FORWARD.test(pageText) || PERMISSION_REVERSE.test(pageText);
}

export function validateEvidenceSnippet(snippet, pageText) {
  if (!snippet || !pageText) return false;
  const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(pageText).includes(norm(snippet));
}
