import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import yaml from "js-yaml";
import { todaySpendUsd } from "./spend.js";

const TASK_CLASSES = new Set(["bulk-classify", "extract", "reason", "write"]);

export function createRouter({ configPath, adapters, logPath }) {
  let config = loadAndValidate(configPath);

  function loadAndValidate(path) {
    const c = yaml.load(readFileSync(path, "utf8"));
    if (!c?.modes?.[c.current_mode]) {
      throw new Error(`current_mode "${c?.current_mode}" not found in modes`);
    }
    return c;
  }

  function persist() {
    writeFileSync(configPath, yaml.dump(config));
  }

  function resolveTarget(taskClass) {
    if (!TASK_CLASSES.has(taskClass)) {
      throw new Error(`unknown taskClass: ${taskClass}`);
    }
    const target = config.modes[config.current_mode][taskClass];
    if (!target) {
      throw new Error(
        `no provider mapped for taskClass=${taskClass} in mode=${config.current_mode}`
      );
    }
    const [providerName, modelKey] = target.split(":");
    const providerCfg = config.providers[providerName];
    if (!providerCfg) throw new Error(`unknown provider: ${providerName}`);
    const modelName = providerCfg.models?.[modelKey];
    if (!modelName) {
      throw new Error(`unknown model key "${modelKey}" for provider ${providerName}`);
    }
    return { providerName, providerCfg, modelKey, modelName };
  }

  function isRetryable(err) {
    const m = String(err?.message ?? "");
    // 5xx, 429, network — yes. 4xx (esp 401/403/400) — no.
    if (/HTTP (5\d\d|429)/.test(m)) return true;
    if (/HTTP 4\d\d/.test(m)) return false;
    if (/ECONN|timeout|ETIMEDOUT|fetch failed/i.test(m)) return true;
    return false;
  }

  function fallbackTarget(taskClass) {
    // Fall back DOWN the tier: anthropic → ollama. Never the reverse.
    const { providerName } = resolveTarget(taskClass);
    if (providerName === "ollama") return null;             // already at floor
    if (providerName === "anthropic") {
      const ollamaModelKey = config.modes.local[taskClass].split(":")[1];
      return {
        providerName: "ollama",
        modelName: config.providers.ollama.models[ollamaModelKey],
      };
    }
    return null;
  }

  async function complete({ taskClass, prompt, maxTokens, temperature }) {
    // Cap enforcement: if today's spend already >= cap, force local mode for this call.
    const cap = config.spend?.daily_cap_usd ?? Infinity;
    const spent = todaySpendUsd(logPath, config.spend?.cost_per_million_tokens ?? {});
    if (spent >= cap && config.current_mode !== "local") {
      config.current_mode = "local";
      persist();
    }

    const { providerName, providerCfg, modelName } = resolveTarget(taskClass);
    const adapter = adapters[providerName];
    if (!adapter) throw new Error(`no adapter registered for ${providerName}`);

    const adapterArgs = {
      taskClass,
      prompt,
      model: modelName,
      maxTokens,
      temperature,
      ...(providerCfg.base_url ? { baseUrl: providerCfg.base_url } : {}),
      ...(providerCfg.api_key_env ? { apiKeyEnv: providerCfg.api_key_env } : {}),
    };

    const ts = new Date().toISOString();
    let result, lastErr;

    // Primary attempt + 1 retry on retryable errors.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await adapter.complete(adapterArgs);
        const providerUsed = `${providerName}:${modelName}`;
        logCall({ ts, providerName, modelName, taskClass, ok: true,
          tokensIn: result.tokensIn, tokensOut: result.tokensOut, latencyMs: result.latencyMs });
        return { ...result, providerUsed };
      } catch (e) {
        lastErr = e;
        logCall({ ts: new Date().toISOString(), providerName, modelName, taskClass, ok: false, errMsg: String(e?.message ?? e) });
        if (attempt === 0 && isRetryable(e)) continue;
        break;
      }
    }

    // Both attempts failed. Try fallback DOWN the tier.
    const fb = fallbackTarget(taskClass);
    if (fb) {
      const fbAdapter = adapters[fb.providerName];
      const fbProviderCfg = config.providers[fb.providerName];
      const fbArgs = {
        taskClass, prompt, model: fb.modelName, maxTokens, temperature,
        ...(fbProviderCfg.base_url ? { baseUrl: fbProviderCfg.base_url } : {}),
        ...(fbProviderCfg.api_key_env ? { apiKeyEnv: fbProviderCfg.api_key_env } : {}),
      };
      const fbTs = new Date().toISOString();
      try {
        const fbResult = await fbAdapter.complete(fbArgs);
        const providerUsed = `${fb.providerName}:${fb.modelName}`;
        logCall({ ts: fbTs, providerName: fb.providerName, modelName: fb.modelName,
          taskClass, ok: true, fallback: true,
          tokensIn: fbResult.tokensIn, tokensOut: fbResult.tokensOut, latencyMs: fbResult.latencyMs });
        return { ...fbResult, providerUsed };
      } catch (e) {
        logCall({ ts: new Date().toISOString(), providerName: fb.providerName, modelName: fb.modelName,
          taskClass, ok: false, fallback: true, errMsg: String(e?.message ?? e) });
        throw e;
      }
    }

    throw lastErr;
  }

  function logCall(entry) {
    if (!logPath) return;
    appendFileSync(logPath, JSON.stringify({ ...entry, kind: "call" }) + "\n");
  }

  return {
    complete,
    getMode: () => config.current_mode,
    async setMode(mode) {
      if (!config.modes[mode]) throw new Error(`unknown mode: ${mode}`);
      config.current_mode = mode;
      persist();
    },
    getConfig: () => structuredClone(config),
  };
}
