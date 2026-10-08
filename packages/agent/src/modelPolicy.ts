import type { Provider } from "@earendil-works/pi-ai";
import { AgentRegistryError } from "./agents.ts";
import type { AgentModelRef } from "./types.ts";

const BUILTINS: Record<string, string> = {
  "zai-coding-cn": "zaiCodingCnProvider", zai: "zaiProvider",
  "minimax-cn": "minimaxCnProvider", minimax: "minimaxProvider",
  deepseek: "deepseekProvider", openai: "openaiProvider", anthropic: "anthropicProvider",
};

// Deliberate general-purpose defaults; catalog ordering is not a recommendation.
const RECOMMENDED: Record<string, readonly string[]> = {
  "zai-coding-cn": ["glm-5.3-flash", "glm-5.3"],
  zai: ["glm-5.3-flash", "glm-5.3"],
  openai: ["gpt-5.4-mini", "gpt-5.4", "gpt-4.1-mini"],
  anthropic: ["claude-sonnet-4-6", "claude-sonnet-4-5"],
  deepseek: ["deepseek-flash", "deepseek-v4-pro"],
  minimax: ["MiniMax-M3", "MiniMax-M2.7"],
  "minimax-cn": ["MiniMax-M3", "MiniMax-M2.7"],
};

export function pickDefaultModel(providers: readonly Provider[]): AgentModelRef | undefined {
  for (const provider of providers) {
    let catalog;
    try { catalog = provider.getModels(); } catch { continue; }
    const preferences = Object.hasOwn(RECOMMENDED, provider.id) ? RECOMMENDED[provider.id] : undefined;
    const recommended = preferences?.find((id) => catalog.some((m) => m.id === id));
    const id = recommended ?? catalog[0]?.id;
    if (id) return { provider: provider.id, modelId: id };
  }
  return undefined;
}

export async function validateModel(model: unknown, providers: readonly Provider[]): Promise<AgentModelRef> {
  if (!model || typeof model !== "object" || !("provider" in model) || !("modelId" in model)
    || typeof model.provider !== "string" || typeof model.modelId !== "string" || !model.provider || !model.modelId) {
    throw new AgentRegistryError("model must contain non-empty provider and modelId strings", "invalid");
  }
  let provider = providers.find((p) => p.id === model.provider);
  // Explicit known models remain usable in provider-free/offline registries.
  // Installing their runtime is a separate, credential-dependent decision.
  if (!provider && providers.length === 0 && Object.hasOwn(BUILTINS, model.provider)) {
    const module = await import(`@earendil-works/pi-ai/providers/${model.provider}`) as Record<string, () => Provider>;
    provider = module[BUILTINS[model.provider]!]!();
  }
  if (!provider) throw new AgentRegistryError(`unknown or unconfigured model provider: ${model.provider}`, "invalid");
  if (!provider.getModels().some((m) => m.id === model.modelId)) {
    throw new AgentRegistryError(`unknown model: ${model.provider}/${model.modelId}`, "invalid");
  }
  return { provider: model.provider, modelId: model.modelId };
}

export function validateAgentName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.trim() !== name || !name || name.length > 128 || /[\x00-\x1f\x7f/\\]/.test(name)) {
    throw new AgentRegistryError("name must be a non-empty name of at most 128 characters without surrounding whitespace or path separators", "invalid");
  }
  if (name.toLowerCase() === "main" || /^agent-[0-9a-f]{8}$/i.test(name)) {
    throw new AgentRegistryError('"main" and agent IDs are reserved — pick another name', "invalid");
  }
}

export function validateAgentSettings(change: { instructions?: unknown; thinkingLevel?: unknown }): void {
  if (change.instructions !== undefined && change.instructions !== null && typeof change.instructions !== "string") {
    throw new AgentRegistryError("instructions must be a string or null", "invalid");
  }
  if (change.thinkingLevel !== undefined && change.thinkingLevel !== null
    && (typeof change.thinkingLevel !== "string" || !["minimal", "low", "medium", "high"].includes(change.thinkingLevel))) {
    throw new AgentRegistryError("thinkingLevel must be minimal, low, medium, high, or null", "invalid");
  }
}
