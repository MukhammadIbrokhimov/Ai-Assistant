import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSrt, createWhisperRunner } from "../whisper.js";

describe("parseSrt", () => {
  it("handles comma and period decimal separators", () => {
    const srt = `1\n00:00:01,500 --> 00:00:04,000\nHello.\n`;
    const segs = parseSrt(srt);
    expect(segs).toEqual([{ t_start: 1.5, t_end: 4.0, text: "Hello." }]);
  });

  it("joins multi-line segment text with a space", () => {
    const srt = `1\n00:00:00,000 --> 00:00:02,000\nLine one.\nLine two.\n`;
    expect(parseSrt(srt)[0].text).toBe("Line one. Line two.");
  });

  it("ignores empty blocks", () => {
    expect(parseSrt("")).toEqual([]);
    expect(parseSrt("\n\n\n")).toEqual([]);
  });
});

function fakeSpawn(handlers) {
  const calls = [];
  const spawn = (binary, args) => {
    calls.push({ binary, args });
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout = new EventEmitter();
    const handler = handlers[binary];
    queueMicrotask(() => {
      try {
        handler?.({ binary, args, proc });
      } catch (e) {
        proc.emit("error", e);
        return;
      }
      proc.emit("close", 0);
    });
    return proc;
  };
  return { spawn, calls };
}

describe("createWhisperRunner", () => {
  it("runs whisper-cli directly when input is already wav", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "wt-"));
    const wavPath = join(tmp, "a.wav");
    writeFileSync(wavPath, "");
    const { spawn, calls } = fakeSpawn({
      "whisper-cli": ({ args }) => {
        const of = args[args.indexOf("-of") + 1];
        writeFileSync(`${of}.srt`, "1\n00:00:00,000 --> 00:00:01,000\nhi\n");
      },
    });
    const runner = createWhisperRunner({ modelPath: "/fake.bin", spawn });
    const srt = await runner.runWhisper(wavPath);
    expect(srt).toContain("hi");
    expect(calls.map(c => c.binary)).toEqual(["whisper-cli"]);
  });

  it("converts m4a to wav via ffmpeg before running whisper-cli", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "wt-"));
    const m4aPath = join(tmp, "a.m4a");
    writeFileSync(m4aPath, "");
    const { spawn, calls } = fakeSpawn({
      ffmpeg: ({ args }) => {
        const out = args[args.length - 1];
        writeFileSync(out, "");
      },
      "whisper-cli": ({ args }) => {
        const of = args[args.indexOf("-of") + 1];
        writeFileSync(`${of}.srt`, "1\n00:00:00,000 --> 00:00:01,000\nhi\n");
      },
    });
    const runner = createWhisperRunner({ modelPath: "/fake.bin", spawn });
    await runner.runWhisper(m4aPath);
    expect(calls.map(c => c.binary)).toEqual(["ffmpeg", "whisper-cli"]);
    const ffArgs = calls[0].args;
    expect(ffArgs).toContain("-i");
    expect(ffArgs[ffArgs.indexOf("-i") + 1]).toBe(m4aPath);
    expect(ffArgs).toContain("-ar");
    expect(ffArgs[ffArgs.indexOf("-ar") + 1]).toBe("16000");
    expect(ffArgs).toContain("-ac");
    expect(ffArgs[ffArgs.indexOf("-ac") + 1]).toBe("1");
    const whisperInput = calls[1].args[calls[1].args.length - 1];
    expect(whisperInput.endsWith(".wav")).toBe(true);
  });

  it("cleans up the temp wav and its srt after run", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "wt-"));
    const m4aPath = join(tmp, "a.m4a");
    writeFileSync(m4aPath, "");
    const { spawn } = fakeSpawn({
      ffmpeg: ({ args }) => writeFileSync(args[args.length - 1], ""),
      "whisper-cli": ({ args }) => {
        const of = args[args.indexOf("-of") + 1];
        writeFileSync(`${of}.srt`, "1\n00:00:00,000 --> 00:00:01,000\nhi\n");
      },
    });
    const runner = createWhisperRunner({ modelPath: "/fake.bin", spawn });
    await runner.runWhisper(m4aPath);
    expect(existsSync(`${m4aPath}.whisper.wav`)).toBe(false);
    expect(existsSync(`${m4aPath}.whisper.wav.srt`)).toBe(false);
    expect(existsSync(m4aPath)).toBe(true);
  });

  it("cleans up the srt but keeps user-supplied wav", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "wt-"));
    const wavPath = join(tmp, "a.wav");
    writeFileSync(wavPath, "keep me");
    const { spawn } = fakeSpawn({
      "whisper-cli": ({ args }) => {
        const of = args[args.indexOf("-of") + 1];
        writeFileSync(`${of}.srt`, "1\n00:00:00,000 --> 00:00:01,000\nhi\n");
      },
    });
    const runner = createWhisperRunner({ modelPath: "/fake.bin", spawn });
    await runner.runWhisper(wavPath);
    expect(existsSync(`${wavPath}.srt`)).toBe(false);
    expect(existsSync(wavPath)).toBe(true);
    expect(readFileSync(wavPath, "utf8")).toBe("keep me");
  });

  it("rejects when ffmpeg conversion fails", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "wt-"));
    const m4aPath = join(tmp, "a.m4a");
    writeFileSync(m4aPath, "");
    const spawn = (binary, args) => {
      const proc = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdout = new EventEmitter();
      queueMicrotask(() => {
        proc.stderr.emit("data", "ffmpeg boom");
        proc.emit("close", 1);
      });
      return proc;
    };
    const runner = createWhisperRunner({ modelPath: "/fake.bin", spawn });
    await expect(runner.runWhisper(m4aPath)).rejects.toThrow(/ffmpeg/);
  });
});
