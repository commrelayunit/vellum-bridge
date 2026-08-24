import type { ServerResponse } from "node:http";

/** sessionKeys that were opened through our trusted /vellum/v1/chat/completions route. */
export const trustedSessionKeys = new Set<string>();

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
