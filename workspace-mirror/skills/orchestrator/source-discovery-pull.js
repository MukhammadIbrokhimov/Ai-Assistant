import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

export async function runSourceDiscoveryPull({ sourceDiscovery, logger, paths }) {
  const nichesDoc = yaml.load(readFileSync(join(paths.workspace, "config/niches.yaml"), "utf8"));
  const niches = Object.keys(nichesDoc?.niches ?? {});
  let nichesRun = 0;
  let nichesFailed = 0;
  for (const niche of niches) {
    try {
      await sourceDiscovery.runPull(niche);
      logger.jsonl({ event: "source_discovery_pull_ok", niche });
    } catch (err) {
      nichesFailed++;
      logger.errorjsonl(err, { phase: "source_discovery_pull", niche });
    }
    nichesRun++;
  }
  return { nichesRun, nichesFailed };
}
