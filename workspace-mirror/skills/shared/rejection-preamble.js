import { readRejectionsSince } from "./rejection-log.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;

export function buildRejectionPreamble({ draftsRoot, now = new Date(), days = DEFAULT_WINDOW_DAYS }) {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const entries = readRejectionsSince(draftsRoot, cutoff);
  if (entries.length === 0) return "";
  const lines = entries.map((e) => {
    const reason = e.reason ? ` — ${e.reason}` : "";
    return `- "${e.topic ?? "(no topic)"}"${reason}`;
  });
  return [
    "Recently rejected drafts to AVOID echoing in tone or topic:",
    ...lines,
    "",
  ].join("\n");
}

export function withRejectionPreamble({ router, draftsRoot, now = () => new Date() }) {
  return new Proxy(router, {
    get(target, prop, receiver) {
      if (prop !== "complete") return Reflect.get(target, prop, receiver);
      return async (args) => {
        if (args?.taskClass !== "write") return target.complete(args);
        const preamble = buildRejectionPreamble({ draftsRoot, now: now() });
        if (!preamble) return target.complete(args);
        return target.complete({ ...args, prompt: `${preamble}\n${args.prompt}` });
      };
    },
  });
}
