import { readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from "node:fs";
import yaml from "js-yaml";

export function createSourcesStore({ path }) {
  function readAll() {
    const doc = yaml.load(readFileSync(path, "utf8")) || { sources: [] };
    if (!Array.isArray(doc.sources)) doc.sources = [];
    return doc;
  }

  function writeAtomic(doc) {
    const tmpPath = path + ".tmp";
    writeFileSync(tmpPath, yaml.dump(doc));
    renameSync(tmpPath, path);
  }

  function withLock(fn) {
    const lockPath = path + ".lock";
    let fd = null;
    const start = Date.now();
    while (Date.now() - start < 2000) {
      try {
        fd = openSync(lockPath, "wx");
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        const end = Date.now() + 20;
        while (Date.now() < end) {}
      }
    }
    if (fd === null) throw new Error(`sources-store: lock timeout on ${lockPath}`);
    try {
      return fn();
    } finally {
      closeSync(fd);
      try { unlinkSync(lockPath); } catch {}
    }
  }

  function list() {
    return readAll().sources;
  }

  function get(id) {
    return readAll().sources.find((s) => s.id === id) || null;
  }

  function append(entry) {
    if (!entry?.id) throw new Error("sources-store.append: entry.id required");
    return withLock(() => {
      const doc = readAll();
      if (doc.sources.find((s) => s.id === entry.id)) {
        throw new Error(`sources-store.append: id "${entry.id}" already exists`);
      }
      doc.sources.push(entry);
      writeAtomic(doc);
    });
  }

  function remove(id) {
    return withLock(() => {
      const doc = readAll();
      const idx = doc.sources.findIndex((s) => s.id === id);
      if (idx < 0) throw new Error(`sources-store.remove: id "${id}" not found`);
      doc.sources.splice(idx, 1);
      writeAtomic(doc);
    });
  }

  function updateLastScanned(id, isoTimestamp) {
    return withLock(() => {
      const doc = readAll();
      const s = doc.sources.find((x) => x.id === id);
      if (!s) throw new Error(`sources-store.updateLastScanned: id "${id}" not found`);
      s.lastScanned = isoTimestamp;
      writeAtomic(doc);
    });
  }

  return { list, get, append, remove, updateLastScanned };
}
