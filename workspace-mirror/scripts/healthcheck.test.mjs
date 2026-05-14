import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pingHealthcheck } from "./healthcheck-ping.mjs";
import {
  HEALTHCHECK_LABEL,
  renderHealthcheckPlist,
  buildArgv,
  plistPath,
  installHealthcheck,
} from "./install-healthcheck.mjs";

describe("pingHealthcheck", () => {
  it("no-ops with skipped=true when url is missing", async () => {
    const logs = [];
    const res = await pingHealthcheck({ url: "", fetchImpl: () => { throw new Error("must not call"); }, log: (m) => logs.push(m) });
    expect(res).toEqual({ skipped: true });
    expect(logs.join("\n")).toMatch(/not set/);
  });

  it("returns ok:true on 2xx response", async () => {
    const fetchImpl = async (u) => {
      expect(u).toBe("https://hc-ping.com/abc");
      return { ok: true, status: 200 };
    };
    const res = await pingHealthcheck({ url: "https://hc-ping.com/abc", fetchImpl, log: () => {} });
    expect(res).toEqual({ ok: true, status: 200 });
  });

  it("returns ok:false and swallows errors", async () => {
    const fetchImpl = async () => { throw new Error("ENETUNREACH"); };
    const res = await pingHealthcheck({ url: "https://hc-ping.com/x", fetchImpl, log: () => {} });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ENETUNREACH/);
  });

  it("aborts on timeout", async () => {
    const fetchImpl = (url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    const res = await pingHealthcheck({ url: "https://hc-ping.com/slow", fetchImpl, log: () => {}, timeoutMs: 5 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/aborted/);
  });
});

describe("renderHealthcheckPlist", () => {
  it("produces a well-formed plist with StartInterval=300", () => {
    const out = renderHealthcheckPlist({
      argv: ["/w/bin/run-job.sh", "/bin/node", "/w/scripts/healthcheck-ping.mjs"],
      intervalSec: 300,
      drafts: "/u/openclaw-drafts",
      homeDir: "/u",
    });
    expect(out).toContain(`<string>${HEALTHCHECK_LABEL}</string>`);
    expect(out).toContain("<key>StartInterval</key>");
    expect(out).toContain("<integer>300</integer>");
    expect(out).toContain("<key>RunAtLoad</key>");
    expect(out).toContain("<true/>");
    expect(out).toContain("/u/openclaw-drafts/logs/launchd-healthcheck-ping.log");
    expect(out).not.toContain("StartCalendarInterval");
  });

  it("xml-escapes special characters", () => {
    const out = renderHealthcheckPlist({
      argv: ["/w/bin/run-job.sh", "/bin/node", "/w/path & weird.mjs"],
      intervalSec: 60,
      drafts: "/d",
      homeDir: "/u",
    });
    expect(out).toContain("&amp;");
    expect(out).not.toMatch(/\/w\/path & weird/);
  });
});

describe("buildArgv", () => {
  it("invokes run-job.sh + node + the ping script", () => {
    const argv = buildArgv({ nodePath: "/opt/homebrew/bin/node", workspace: "/u/.openclaw/workspace" });
    expect(argv).toEqual([
      "/u/.openclaw/workspace/bin/run-job.sh",
      "/opt/homebrew/bin/node",
      "/u/.openclaw/workspace/scripts/healthcheck-ping.mjs",
    ]);
  });
});

describe("installHealthcheck", () => {
  let tmp;
  function setup() {
    tmp = mkdtempSync(join(tmpdir(), "hc-"));
    mkdirSync(`${tmp}/Library/LaunchAgents`, { recursive: true });
  }
  function teardown() { rmSync(tmp, { recursive: true, force: true }); }

  const baseOpts = (home) => ({
    homeDir: home,
    nodePath: "/n",
    workspace: "/w",
    drafts: "/d",
    fs: { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync },
  });

  it("plan: add when no plist exists yet", async () => {
    setup();
    try {
      let calls = 0;
      const runSub = async () => { calls++; };
      const res = await installHealthcheck({ ...baseOpts(tmp), runSub, dryRun: true });
      expect(res.plan[0].kind).toBe("add");
      expect(res.plan[0].path).toBe(plistPath(tmp));
      expect(calls).toBe(0);
    } finally { teardown(); }
  });

  it("plan: noop when on-disk plist already matches", async () => {
    setup();
    try {
      const content = renderHealthcheckPlist({
        argv: buildArgv({ nodePath: "/n", workspace: "/w" }),
        intervalSec: 300,
        drafts: "/d",
        homeDir: tmp,
      });
      writeFileSync(plistPath(tmp), content);
      const res = await installHealthcheck({ ...baseOpts(tmp), runSub: async () => {}, dryRun: true });
      expect(res.plan[0].kind).toBe("noop");
    } finally { teardown(); }
  });

  it("plan: edit when on-disk plist differs", async () => {
    setup();
    try {
      writeFileSync(plistPath(tmp), "<different/>");
      const res = await installHealthcheck({ ...baseOpts(tmp), runSub: async () => {}, dryRun: true });
      expect(res.plan[0].kind).toBe("edit");
    } finally { teardown(); }
  });

  it("apply: writes plist and bootstraps via launchctl", async () => {
    setup();
    try {
      const subCalls = [];
      const runSub = async (cmd, argv) => { subCalls.push([cmd, ...argv]); };
      const res = await installHealthcheck({ ...baseOpts(tmp), runSub, dryRun: false });
      expect(res.applied).toBe(1);
      expect(existsSync(plistPath(tmp))).toBe(true);
      const verbs = subCalls.map(c => c[1]);
      expect(verbs).toContain("bootstrap");
    } finally { teardown(); }
  });

  it("uninstall: removes plist when present", async () => {
    setup();
    try {
      writeFileSync(plistPath(tmp), "<x/>");
      const res = await installHealthcheck({ ...baseOpts(tmp), runSub: async () => {}, dryRun: false, uninstall: true });
      expect(res.plan[0].kind).toBe("remove");
      expect(existsSync(plistPath(tmp))).toBe(false);
    } finally { teardown(); }
  });

  it("uninstall: tolerant when plist is already missing", async () => {
    setup();
    try {
      const res = await installHealthcheck({ ...baseOpts(tmp), runSub: async () => {}, dryRun: false, uninstall: true });
      expect(res.applied).toBe(1);
    } finally { teardown(); }
  });
});
