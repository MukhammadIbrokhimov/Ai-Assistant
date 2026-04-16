import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftStore } from "shared/draft-store";
import { createModeCommand } from "../commands/mode.js";
import { createStatusCommand } from "../commands/status.js";
import { createQueueCommand } from "../commands/queue.js";
import { createSpendCommand } from "../commands/spend.js";
import { createWhoamiCommand } from "../commands/whoami.js";
import { helpCommand } from "../commands/help.js";
import { createCancelCommand } from "../commands/cancel.js";

let tmp;
const CHAT_ID = 5349931800;

function mockClient() {
  return { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cmds-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("/mode", () => {
  test("no args returns current mode", async () => {
    const configPath = join(tmp, "providers.yaml");
    writeFileSync(
      configPath,
      "current_mode: local\nmodes:\n  local: {}\n  hybrid: {}\n  premium: {}\n"
    );
    const cmd = createModeCommand(configPath);
    const client = mockClient();
    await cmd(CHAT_ID, "", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).toContain("local");
  });

  test("with valid arg switches mode", async () => {
    const configPath = join(tmp, "providers.yaml");
    writeFileSync(
      configPath,
      "current_mode: local\nmodes:\n  local: {}\n  hybrid: {}\n  premium: {}\n"
    );
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const cmd = createModeCommand(configPath);
    const client = mockClient();
    await cmd(CHAT_ID, "hybrid", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).toContain("hybrid");
  });

  test("hybrid without API key refuses", async () => {
    const configPath = join(tmp, "providers.yaml");
    writeFileSync(
      configPath,
      "current_mode: local\nmodes:\n  local: {}\n  hybrid: {}\n  premium: {}\n"
    );
    delete process.env.ANTHROPIC_API_KEY;
    const cmd = createModeCommand(configPath);
    const client = mockClient();
    await cmd(CHAT_ID, "hybrid", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).toContain("ANTHROPIC_API_KEY");
  });
});

describe("/status", () => {
  test("reports pending count and service status", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    mkdirSync(join(tmp, "pending"), { recursive: true });
    mkdirSync(join(tmp, "pending", "d-001"));
    writeFileSync(join(tmp, "pending", "d-001", "state.json"), '{"status":"pending"}');
    mkdirSync(join(tmp, "approved"));
    mkdirSync(join(tmp, "rejected"));
    const store = createDraftStore(tmp);
    const cmd = createStatusCommand(store);
    const client = mockClient();
    await cmd(CHAT_ID, "", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).toContain("1");
    globalThis.fetch = originalFetch;
  });
});

describe("/queue", () => {
  test("lists pending drafts", async () => {
    mkdirSync(join(tmp, "pending"), { recursive: true });
    mkdirSync(join(tmp, "approved"));
    mkdirSync(join(tmp, "rejected"));
    mkdirSync(join(tmp, "pending", "d-001"));
    writeFileSync(
      join(tmp, "pending", "d-001", "draft.json"),
      '{"id":"d-001","mode":"clip","topic":"AI"}'
    );
    writeFileSync(join(tmp, "pending", "d-001", "state.json"), '{"status":"pending"}');
    const store = createDraftStore(tmp);
    const cmd = createQueueCommand(store);
    const client = mockClient();
    await cmd(CHAT_ID, "", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).toContain("d-001");
    expect(text).toContain("pending");
  });

  test("filters out superseded drafts", async () => {
    mkdirSync(join(tmp, "pending"), { recursive: true });
    mkdirSync(join(tmp, "approved"));
    mkdirSync(join(tmp, "rejected"));
    mkdirSync(join(tmp, "pending", "d-old"));
    writeFileSync(
      join(tmp, "pending", "d-old", "draft.json"),
      '{"id":"d-old","mode":"clip","topic":"old"}'
    );
    writeFileSync(join(tmp, "pending", "d-old", "state.json"), '{"status":"superseded"}');
    const store = createDraftStore(tmp);
    const cmd = createQueueCommand(store);
    const client = mockClient();
    await cmd(CHAT_ID, "", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).not.toContain("d-old");
    expect(text).toContain("No pending drafts");
  });
});

describe("/spend", () => {
  test("reports today spend and MTD", async () => {
    const logPath = join(tmp, "router.jsonl");
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(
      logPath,
      `{"kind":"call","ok":true,"ts":"${today}T09:00:00Z","providerName":"ollama","modelName":"qwen2.5:14b","tokensIn":100,"tokensOut":50}\n`
    );
    const configPath = join(tmp, "providers.yaml");
    writeFileSync(
      configPath,
      'spend:\n  daily_cap_usd: 1.00\n  cost_per_million_tokens:\n    "ollama:*": { in: 0.00, out: 0.00 }\n'
    );
    const cmd = createSpendCommand(logPath, configPath);
    const client = mockClient();
    await cmd(CHAT_ID, "", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).toContain("$");
    expect(text).toContain("cap");
  });
});

describe("/whoami", () => {
  test("reports user ID", async () => {
    const cmd = createWhoamiCommand(5349931800);
    const client = mockClient();
    await cmd(CHAT_ID, "", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).toContain("5349931800");
  });
});

describe("/help", () => {
  test("lists all commands", async () => {
    const client = mockClient();
    await helpCommand(CHAT_ID, "", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).toContain("/mode");
    expect(text).toContain("/status");
    expect(text).toContain("/queue");
    expect(text).toContain("/spend");
    expect(text).toContain("/whoami");
    expect(text).toContain("/help");
    expect(text).toContain("/cancel");
  });
});

describe("/cancel", () => {
  test("cancels modifying draft and restores to pending", async () => {
    mkdirSync(join(tmp, "pending"), { recursive: true });
    mkdirSync(join(tmp, "approved"));
    mkdirSync(join(tmp, "rejected"));
    mkdirSync(join(tmp, "pending", "d-mod"));
    writeFileSync(
      join(tmp, "pending", "d-mod", "draft.json"),
      '{"id":"d-mod","mode":"clip","topic":"test"}'
    );
    writeFileSync(
      join(tmp, "pending", "d-mod", "state.json"),
      '{"status":"modifying","telegram_message_id":42}'
    );
    const store = createDraftStore(tmp);
    const cmd = createCancelCommand(store);
    const client = mockClient();
    await cmd(CHAT_ID, "", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).toContain("cancelled");
    const state = JSON.parse(
      readFileSync(join(tmp, "pending", "d-mod", "state.json"), "utf8")
    );
    expect(state.status).toBe("pending");
  });

  test("reports nothing to cancel when no draft is modifying", async () => {
    mkdirSync(join(tmp, "pending"), { recursive: true });
    mkdirSync(join(tmp, "approved"));
    mkdirSync(join(tmp, "rejected"));
    const store = createDraftStore(tmp);
    const cmd = createCancelCommand(store);
    const client = mockClient();
    await cmd(CHAT_ID, "", client);
    const text = client.sendMessage.mock.calls[0][1];
    expect(text).toContain("Nothing to cancel");
  });
});
