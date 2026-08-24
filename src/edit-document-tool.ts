import { Type } from "typebox";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  PluginTrustedToolPolicyRegistration,
} from "openclaw/plugin-sdk/plugin-entry";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import { trustedSessionKeys, responseBySessionKey, writeToolCallDelta, endStreamAfterToolCall } from "./session-bridge.js";

/** toolCallId -> resolver for the eventual `role: tool` result from Vellum's follow-up request. */
const pendingToolResults = new Map<string, (result: unknown) => void>();

export function resolvePendingToolResult(toolCallId: string, result: unknown): boolean {
  const resolve = pendingToolResults.get(toolCallId);
  if (!resolve) return false;
  pendingToolResults.delete(toolCallId);
  resolve(result);
  return true;
}

const editDocumentParams = Type.Object(
  {
    replacement: Type.String({ description: "Full replacement text for the live document." }),
  },
  { additionalProperties: false },
);

function makeEditDocumentTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  const sessionKey = ctx.sessionKey;
  return {
    name: "edit_document",
    label: "Edit Document",
    description: "Edit the current live Vellum document.",
    parameters: editDocumentParams,
    async execute(toolCallId, params) {
      const res = sessionKey ? responseBySessionKey.get(sessionKey) : undefined;
      if (!res) {
        // No live Vellum request waiting on this session — refuse rather than
        // silently no-op, per the "never fall back to a local edit" constraint.
        return textResult(
          "edit_document is only callable from an active Vellum bridge request; no live document connection found.",
          undefined,
        );
      }

      writeToolCallDelta(res, { toolCallId, name: "edit_document", arguments: params });
      endStreamAfterToolCall(res);
      if (sessionKey) responseBySessionKey.delete(sessionKey);

      // Park this tool call until Vellum's next request delivers the `role: tool`
      // result. The underlying Codex turn simply stays open/paused here — no
      // separate session-resume mechanism needed.
      const result = await new Promise<unknown>((resolve) => {
        pendingToolResults.set(toolCallId, resolve);
      });
      return textResult(typeof result === "string" ? result : JSON.stringify(result), undefined);
    },
  };
}

export function registerEditDocumentTool(api: OpenClawPluginApi): void {
  api.registerTool(makeEditDocumentTool, { name: "edit_document" });

  const policy: PluginTrustedToolPolicyRegistration = {
    id: "vellum-bridge-edit-document-allowlist",
    description: "Only allow edit_document for sessions opened through the Vellum bridge route.",
    evaluate(event, ctx) {
      if (event.toolName !== "edit_document") return undefined;
      const sessionKey = ctx.sessionKey;
      if (!sessionKey || !trustedSessionKeys.has(sessionKey)) {
        return { block: true, blockReason: "edit_document is only allowed for Vellum-bridge sessions." };
      }
      return undefined;
    },
  };
  api.registerTrustedToolPolicy(policy);
}
