import { definePluginEntry, buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { registerVellumRoutes } from "./passthrough.js";
import { registerEditDocumentTool } from "./edit-document-tool.js";

// No plugin-specific config.* settings — model-override trust is granted via
// the separate plugins.entries.vellum-bridge.subagent.{allowModelOverride,allowedModels}
// config (see registerVellumRoutes doc comment), not this schema.
const configSchema = buildJsonPluginConfigSchema({ type: "object", additionalProperties: false, properties: {} });

const plugin: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: "vellum-bridge",
  name: "Vellum Bridge",
  description:
    "OpenAI-compatible bridge for the Vellum editor: byte-transparent tool passthrough for normal providers, plus an allowlisted edit_document bridge for Codex-backed agent turns.",
  configSchema,
  register(api) {
    registerVellumRoutes(api);
    registerEditDocumentTool(api);
  },
});

export default plugin;
