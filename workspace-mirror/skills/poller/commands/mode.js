import { readFileSync, writeFileSync } from "node:fs";
import yaml from "js-yaml";

const VALID_MODES = ["local", "hybrid", "premium"];

export function createModeCommand(configPath) {
  return async function modeCommand(chatId, args, client) {
    const config = yaml.load(readFileSync(configPath, "utf8"));

    if (!args) {
      await client.sendMessage(chatId, `Current mode: ${config.current_mode}`);
      return;
    }

    const mode = args.toLowerCase().trim();
    if (!VALID_MODES.includes(mode)) {
      await client.sendMessage(chatId, `Invalid mode. Choose: ${VALID_MODES.join(", ")}`);
      return;
    }

    if ((mode === "hybrid" || mode === "premium") && !process.env.ANTHROPIC_API_KEY) {
      await client.sendMessage(
        chatId,
        `Cannot switch to ${mode}: ANTHROPIC_API_KEY not set.\nAdd it to ~/.openclaw/workspace/.env and restart.`
      );
      return;
    }

    config.current_mode = mode;
    writeFileSync(configPath, yaml.dump(config));
    await client.sendMessage(chatId, `Mode switched to: ${mode}`);
  };
}
