// Test-only preload: replace env providers with deterministic loopback SSE.
// Use run-scripted-e2e.mjs; this does not evaluate a real model/provider.
import { DurableDaemon } from "../src/daemon.ts";

const lib = new URL("../node_modules/@earendil-works/pi-ai/dist/", import.meta.url);
const { createProvider } = await import(new URL("models.js", lib).href);
const { zaiCodingCnProvider } = await import(new URL("providers/zai-coding-cn.js", lib).href);
const { openAICompletionsApi } = await import(new URL("api/openai-completions.lazy.js", lib).href);
const baseUrl = process.env.RAFTD_TEST_MODEL_URL;
if (!baseUrl) throw new Error("scripted provider requires the local run-scripted-e2e.mjs driver");
const endpoint = new URL(baseUrl);
if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
  throw new Error("scripted provider only accepts a loopback HTTP fixture URL");
}
const nativeOpen = DurableDaemon.open.bind(DurableDaemon);
DurableDaemon.open = async function (options) {
  if (options.providers === undefined || options.providers === "env") {
    const provider = createProvider({
      id: "zai-coding-cn", name: "LOCAL SCRIPTED TEST SERVER (not real GLM)", baseUrl,
      models: zaiCodingCnProvider().getModels().map((model) => ({ ...model, baseUrl })),
      auth: { apiKey: { name: "local test", resolve: async () => ({ auth: { apiKey: "local-test-placeholder" }, source: "local fixture" }) } },
      api: openAICompletionsApi(),
    });
    options = { ...options, providers: [provider] };
  }
  return nativeOpen(options);
};
