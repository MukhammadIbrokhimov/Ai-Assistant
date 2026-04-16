export function formatSrtTime(s) {
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)},${pad(ms, 3)}`;
}

export function buildClipSrt(segments, startS, endS) {
  const inRange = segments.filter(s => s.t_end > startS && s.t_start < endS);
  const shifted = inRange.map((s, idx) => {
    const localStart = Math.max(0, s.t_start - startS);
    const localEnd = Math.min(endS - startS, s.t_end - startS);
    return { idx: idx + 1, localStart, localEnd, text: s.text };
  });
  return shifted.map(s =>
    `${s.idx}\n${formatSrtTime(s.localStart)} --> ${formatSrtTime(s.localEnd)}\n${s.text}\n`
  ).join("\n");
}
