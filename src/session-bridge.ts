import type { ServerResponse } from "node:http";

/** sessionKeys that were opened through our trusted /vellum/v1/chat/completions route. */
export const trustedSessionKeys = new Set<string>();

/**
 * OpenClaw's embedded runtime may normalize the session key supplied to
 * `subagent.run`. Keep the bridge-owned run ID as the authority, then bind the
 * runtime's actual session key when the trusted tool policy sees it.
 */
const bridgeSessionKeyByRunId = new Map<string, string>();
const bridgeSessionKeyByRuntimeSessionKey = new Map<string, string>();

export function beginBridgeRun(runId: string, bridgeSessionKey: string): void {
  bridgeSessionKeyByRunId.set(runId, bridgeSessionKey);
}

export function finishBridgeRun(runId: string): void {
  const bridgeSessionKey = bridgeSessionKeyByRunId.get(runId);
  bridgeSessionKeyByRunId.delete(runId);
  if (!bridgeSessionKey) return;
  for (const [runtimeSessionKey, mappedBridgeSessionKey] of bridgeSessionKeyByRuntimeSessionKey) {
    if (mappedBridgeSessionKey === bridgeSessionKey) {
      bridgeSessionKeyByRuntimeSessionKey.delete(runtimeSessionKey);
    }
  }
}

export function bindRuntimeSessionKey(runId: string | undefined, runtimeSessionKey: string | undefined): string | undefined {
  if (!runId || !runtimeSessionKey) return undefined;
  const bridgeSessionKey = bridgeSessionKeyByRunId.get(runId);
  if (!bridgeSessionKey) return undefined;
  bridgeSessionKeyByRuntimeSessionKey.set(runtimeSessionKey, bridgeSessionKey);
  return bridgeSessionKey;
}

export function bridgeSessionKeyForRuntimeSession(runtimeSessionKey: string | undefined): string | undefined {
  return runtimeSessionKey ? bridgeSessionKeyByRuntimeSessionKey.get(runtimeSessionKey) : undefined;
}

/** The open SSE response currently waiting on a turn for a given sessionKey. */
export const responseBySessionKey = new Map<string, ServerResponse>();

function sseWrite(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

let chunkCounter = 0;
function chatCompletionChunkId(): string {
  chunkCounter += 1;
  return `chatcmpl_vellum_${Date.now().toString(36)}_${chunkCounter}`;
}

export function writeAssistantRoleOpen(res: ServerResponse): void {
  sseWrite(res, {
    id: chatCompletionChunkId(),
    object: "chat.completion.chunk",
    model: "openclaw",
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });
}

export function writeToolCallDelta(
  res: ServerResponse,
  toolCall: { toolCallId: string; name: string; arguments: unknown },
): void {
  sseWrite(res, {
    id: chatCompletionChunkId(),
    object: "chat.completion.chunk",
    model: "openclaw",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: toolCall.toolCallId,
              type: "function",
              function: {
                name: toolCall.name,
                arguments: JSON.stringify(toolCall.arguments),
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  });
}

export function endStreamAfterToolCall(res: ServerResponse): void {
  sseWrite(res, {
    id: chatCompletionChunkId(),
    object: "chat.completion.chunk",
    model: "openclaw",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

export function writeFinalAssistantMessage(res: ServerResponse, text: string): void {
  sseWrite(res, {
    id: chatCompletionChunkId(),
    object: "chat.completion.chunk",
    model: "openclaw",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  });
  sseWrite(res, {
    id: chatCompletionChunkId(),
    object: "chat.completion.chunk",
    model: "openclaw",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

export function writeStreamError(res: ServerResponse, message: string): void {
  sseWrite(res, { error: { message, type: "api_error" } });
  res.write("data: [DONE]\n\n");
  res.end();
}
