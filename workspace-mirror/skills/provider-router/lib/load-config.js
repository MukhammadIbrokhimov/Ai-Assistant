import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

export const CONFIG_PATH = join(
  homedir(),
  ".openclaw",
  "workspace",
  "config",
  "providers.yaml"
);

export function loadConfig(path = CONFIG_PATH) {
  return yaml.load(readFileSync(path, "utf8"));
}
