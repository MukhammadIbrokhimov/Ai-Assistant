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

  function drain() {
    return withLock(() => {
      const orphan = readLines(processingPath);
      const current = readLines(path);
      if (existsSync(path)) {
        if (orphan.length > 0) {
          const combined = [...orphan, ...current];
          const body = combined.map(e => JSON.stringify(e)).join("\n") + (combined.length > 0 ? "\n" : "");
          writeFileSync(processingPath, body);
          unlinkSync(path);
        } else {
          renameSync(path, processingPath);
        }
      }
      return [...orphan, ...current];
    });
  }

  function commitDrain() {
    return withLock(() => {
      if (existsSync(processingPath)) unlinkSync(processingPath);
    });
  }

  function putBack(entries) {
    return withLock(() => {
      const lateAppends = readLines(path);
      const combined = [...entries, ...lateAppends];
      if (combined.length === 0) {
        if (existsSync(path)) unlinkSync(path);
      } else {
        const tmpOut = path + ".tmp";
        writeFileSync(tmpOut, combined.map(e => JSON.stringify(e)).join("\n") + "\n");
        renameSync(tmpOut, path);
      }
      if (existsSync(processingPath)) unlinkSync(processingPath);
    });
  }

  return { append, peek, drain, commitDrain, putBack };
}
