import { readFileSync, writeFileSync, appendFileSync, existsSync, openSync, closeSync, unlinkSync, renameSync } from "node:fs";

function isPidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

export function createQuietQueue({ path }) {
  const lockPath = path + ".lock";
  const processingPath = path + ".processing";

  function withLock(fn) {
    let fd = null;
    const start = Date.now();
    while (Date.now() - start < 2000) {
      try {
        fd = openSync(lockPath, "wx");
        writeFileSync(fd, String(process.pid));
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        try {
          const holderPid = Number(readFileSync(lockPath, "utf8").trim());
          if (!isPidAlive(holderPid)) { unlinkSync(lockPath); continue; }
        } catch { try { unlinkSync(lockPath); } catch {} continue; }
        const end = Date.now() + 20;
        while (Date.now() < end) {}
      }
    }
    if (fd === null) throw new Error(`quiet-queue: lock timeout on ${lockPath}`);
    try { return fn(); }
    finally { closeSync(fd); try { unlinkSync(lockPath); } catch {} }
  }

  function readLines(p) {
    if (!existsSync(p)) return [];
    const raw = readFileSync(p, "utf8").trim();
    if (!raw) return [];
    return raw.split("\n").map(line => JSON.parse(line));
  }

  function append(entry) {
    if (!entry?.draft_id) throw new Error("quiet-queue.append: draft_id required");
    return withLock(() => {
      appendFileSync(path, JSON.stringify(entry) + "\n");
    });
  }

  function peek() {
    return readLines(path);
  }

  return { append, peek };
}
