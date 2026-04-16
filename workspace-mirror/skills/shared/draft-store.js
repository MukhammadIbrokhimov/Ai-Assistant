import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";

export function createDraftStore(basePath) {
  const pendingDir = join(basePath, "pending");
  const approvedDir = join(basePath, "approved");
  const rejectedDir = join(basePath, "rejected");

  function draftDir(id) {
    return join(pendingDir, id);
  }

  function readDraft(id) {
    const dir = draftDir(id);
    const draft = JSON.parse(readFileSync(join(dir, "draft.json"), "utf8"));
    let state = null;
    const statePath = join(dir, "state.json");
    if (existsSync(statePath)) {
      state = JSON.parse(readFileSync(statePath, "utf8"));
    }
    return { draft, state };
  }

  function writeDraft(id, draftData) {
    const dir = join(pendingDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "draft.json"), JSON.stringify(draftData, null, 2));
  }

  function writeState(id, state) {
    const dir = draftDir(id);
    writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
  }

  function updateState(id, partial) {
    const { state } = readDraft(id);
    const merged = { ...state, ...partial };
    writeState(id, merged);
  }

  function updateDraftStatus(id, status) {
    const dir = draftDir(id);
    const draftPath = join(dir, "draft.json");
    const draft = JSON.parse(readFileSync(draftPath, "utf8"));
    draft.status = status;
    writeFileSync(draftPath, JSON.stringify(draft, null, 2));
  }

  function moveTo(targetBase, id, dateStr) {
    const src = draftDir(id);
    const dateDir = join(targetBase, dateStr);
    mkdirSync(dateDir, { recursive: true });
    const dest = join(dateDir, id);
    renameSync(src, dest);
    return dest;
  }

  function moveToApproved(id, dateStr) {
    return moveTo(approvedDir, id, dateStr);
  }

  function moveToRejected(id, dateStr) {
    return moveTo(rejectedDir, id, dateStr);
  }

  function listPending() {
    if (!existsSync(pendingDir)) return [];
    const entries = readdirSync(pendingDir, { withFileTypes: true });
    const ids = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const statePath = join(pendingDir, entry.name, "state.json");
      if (existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        if (state.status === "superseded") continue;
      }
      ids.push(entry.name);
    }
    return ids;
  }

  function findModifying() {
    if (!existsSync(pendingDir)) return null;
    const entries = readdirSync(pendingDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const statePath = join(pendingDir, entry.name, "state.json");
      if (!existsSync(statePath)) continue;
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      if (state.status === "modifying") return entry.name;
    }
    return null;
  }

  return {
    readDraft,
    writeDraft,
    writeState,
    updateState,
    updateDraftStatus,
    moveToApproved,
    moveToRejected,
    listPending,
    findModifying,
  };
}
