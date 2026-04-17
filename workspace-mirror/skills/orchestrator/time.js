function hhmm(date) {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

export function isInQuietHours(now, quietHours) {
  const t = hhmm(now);
  const { start, end } = quietHours;
  if (start > end) {
    return t >= start || t < end;
  }
  return t >= start && t < end;
}
