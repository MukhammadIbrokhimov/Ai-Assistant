#!/usr/bin/env node
// Pings $OPENCLAW_HEALTHCHECK_URL so healthchecks.io can alert the user
// (via SMS/email/Telegram per its own settings) when the daemon goes silent
// for longer than the channel's grace period. Designed for a launchd job
// that fires every 5 min — see install-healthcheck.mjs.
//
// Always exits 0: a failed ping (or missing URL) must not flag launchd, since
// the whole point is that an outage is observed *externally* by healthchecks.io
// when our pings stop arriving.

export async function pingHealthcheck({
  url = process.env.OPENCLAW_HEALTHCHECK_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  log = console.log,
} = {}) {
  if (!url) {
    log("healthcheck-ping: OPENCLAW_HEALTHCHECK_URL not set, skipping");
    return { skipped: true };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal });
    log(`healthcheck-ping: ${res.status} ${url}`);
    return { ok: res.ok, status: res.status };
  } catch (err) {
    log(`healthcheck-ping: failed (${err?.name ?? "Error"}: ${err?.message ?? err})`);
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  await pingHealthcheck();
}
