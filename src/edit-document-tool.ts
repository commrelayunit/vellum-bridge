import { Type } from "typebox";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  PluginTrustedToolPolicyRegistration,
} from "openclaw/plugin-sdk/plugin-entry";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import {
  trustedSessionKeys,
  responseBySessionKey,
  writeToolCallDelta,
  endStreamAfterToolCall,
  bindRuntimeSessionKey,
  bridgeSessionKeyForRuntimeSession,
} from "./session-bridge.js";

function sessionFingerprint(sessionKey: string | undefined): string {
  if (!sessionKey) return "none";
  // Keep operational logs useful without emitting a caller-controlled session
  // identifier verbatim.
  let hash = 0;
  for (const char of sessionKey) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

/**
 * Tool calls awaiting the ordinary OpenAI `role: tool` follow-up from Vellum.
 * The originating bridge session is retained here so the follow-up can be
 * correlated without a Vellum-specific request header.
 */
const pendingToolResults = new Map<string, { resolve: (result: unknown) => void; sessionKey: string }>();

export function sessionKeyForPendingToolResult(toolCallId: string): string | undefined {
  return pendingToolResults.get(toolCallId)?.sessionKey;
}

export function resolvePendingToolResult(toolCallId: string, result: unknown): boolean {
  const pending = pendingToolResults.get(toolCallId);
  if (!pending) return false;
  pendingToolResults.delete(toolCallId);
  pending.resolve(result);
  return true;
}

const editDocumentParams = Type.Object(
  {
    replacement: Type.String({ description: "Full replacement text for the live document." }),
  },
  { additionalProperties: false },
);

function makeEditDocumentTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  const runtimeSessionKey = ctx.sessionKey;
  return {
    name: "edit_document",
    label: "Edit Document",
    description: "Edit the current live Vellum document.",
    parameters: editDocumentParams,
    async execute(toolCallId, params) {
      const sessionKey = bridgeSessionKeyForRuntimeSession(runtimeSessionKey) ?? runtimeSessionKey;
      if (!sessionKey) {
        return textResult(
          "edit_document is only callable from an active Vellum bridge request; no bridge session found.",
          undefined,
        );
      }

      const res = responseBySessionKey.get(sessionKey);
      if (!res) {
        // No live Vellum request waiting on this session — refuse rather than
        // silently no-op, per the "never fall back to a local edit" constraint.
        return textResult(
          "edit_document is only callable from an active Vellum bridge request; no live document connection found.",
          undefined,
        );
      }

      const pendingResult = new Promise<unknown>((resolve) => {
        pendingToolResults.set(toolCallId, { resolve, sessionKey });
      });

      writeToolCallDelta(res, { toolCallId, name: "edit_document", arguments: params });
      endStreamAfterToolCall(res);
      responseBySessionKey.delete(sessionKey);

      // Park this tool call until Vellum's ordinary OpenAI `role: tool` follow-up
      // arrives. The bridge correlates that follow-up via toolCallId; Vellum need
      // not propagate a bridge-specific session header.
      const result = await pendingResult;
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
      const bridgeSessionKey = bindRuntimeSessionKey(ctx.runId, ctx.sessionKey);
      api.logger.info(
        `[vellum-bridge] edit_document policy run=${ctx.runId ?? "none"} runtime=${sessionFingerprint(ctx.sessionKey)} bridge=${sessionFingerprint(bridgeSessionKey)}`,
      );
      if (!bridgeSessionKey && (!ctx.sessionKey || !trustedSessionKeys.has(ctx.sessionKey))) {
        return { block: true, blockReason: "edit_document is only allowed for Vellum-bridge sessions." };
      }
      return undefined;
    },
  };
  api.registerTrustedToolPolicy(policy);
}
