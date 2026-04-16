import { readFileSync, writeFileSync, existsSync } from "node:fs";
import yaml from "js-yaml";

export function createSpendCommand(logPath, configPath) {
  return async function spendCommand(chatId, args, client) {
    const config = yaml.load(readFileSync(configPath, "utf8"));

    // Handle "cap N" subcommand
    const capMatch = args.match(/^cap\s+([\d.]+)$/i);
    if (capMatch) {
      const newCap = parseFloat(capMatch[1]);
      if (isNaN(newCap) || newCap <= 0) {
        await client.sendMessage(chatId, "Invalid cap. Use: /spend cap 2.00");
        return;
      }
      if (!config.spend) config.spend = {};
      config.spend.daily_cap_usd = newCap;
      writeFileSync(configPath, yaml.dump(config));
      await client.sendMessage(chatId, `Daily spend cap set to $${newCap.toFixed(2)}`);
      return;
    }

    const cap = config?.spend?.daily_cap_usd ?? 1.0;
    const costCfg = config?.spend?.cost_per_million_tokens ?? {};

    let todayTotal = 0;
    let mtdTotal = 0;
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);

    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.kind !== "call" || !entry.ok) continue;
        const pm = `${entry.providerName}:${entry.modelName}`;
        const provider = entry.providerName;
        const rate = costCfg[pm] || costCfg[`${provider}:*`];
        if (!rate) continue;
        const cost =
          ((entry.tokensIn || 0) / 1_000_000) * rate.in +
          ((entry.tokensOut || 0) / 1_000_000) * rate.out;
        if (entry.ts?.startsWith(today)) todayTotal += cost;
        if (entry.ts?.startsWith(month)) mtdTotal += cost;
      }
    }

    await client.sendMessage(
      chatId,
      `Today: $${todayTotal.toFixed(4)} / cap $${cap.toFixed(2)}\nMTD: $${mtdTotal.toFixed(4)}`
    );
  };
}
