import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  trustedSessionKeys,
  responseBySessionKey,
  writeAssistantRoleOpen,
  writeFinalAssistantMessage,
  writeStreamError,
} from "./session-bridge.js";
import { resolvePendingToolResult } from "./edit-document-tool.js";

const ROUTE_PATH = "/vellum/v1/chat/completions";

type ChatMessage = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  name?: string;
};

/** Requests carrying `tools` (or continuing a tool-call round) go through the
 * agent tool-bridge (Feature 2); everything else is a plain passthrough
 * (Feature 1), regardless of which model/provider was requested. */
function needsToolBridge(body: Record<string, unknown>, messages: ChatMessage[]): boolean {
  const tools = body.tools as unknown[] | undefined;
  if (Array.isArray(tools) && tools.length > 0) return true;
  return messages[messages.length - 1]?.role === "tool";
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function lastUserMessageText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

/** Known default base URLs (trailing slash required — joined with a relative
 * "chat/completions" path, never an absolute one, so provider-specific path
 * prefixes like Google's /v1beta/openai/ survive the join). */
const DEFAULT_PROVIDER_BASE_URL: Record<string, string> = {
  openai: "https://api.openai.com/v1/",
  google: "https://generativelanguage.googleapis.com/v1beta/openai/",
};

function baseUrlForProvider(api: OpenClawPluginApi, provider: string): string | undefined {
  const configured = (
    api.config as { models?: { providers?: Record<string, { baseUrl?: string }> } }
  ).models?.providers?.[provider]?.baseUrl;
  const raw = configured ?? DEFAULT_PROVIDER_BASE_URL[provider];
  return raw && !raw.endsWith("/") ? `${raw}/` : raw;
}

/** Byte-transparent proxy to a real upstream OpenAI-compatible provider (Feature 1). */
async function forwardToUpstream(
  api: OpenClawPluginApi,
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  const requestedModel = String(body.model ?? "");
  const slash = requestedModel.indexOf("/");
  const provider = slash === -1 ? requestedModel : requestedModel.slice(0, slash);
  const upstreamModelId = slash === -1 ? requestedModel : requestedModel.slice(slash + 1);

  const baseUrl = baseUrlForProvider(api, provider);
  api.logger.info(`[vellum-bridge] resolving auth for provider="${provider}" baseUrl="${baseUrl}"`);
  const auth = await Promise.race([
    api.runtime.modelAuth.resolveApiKeyForProvider({ provider, cfg: api.config }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("resolveApiKeyForProvider timed out after 10s")), 10_000)),
  ]);
  api.logger.info(`[vellum-bridge] auth resolved: mode=${auth.mode} hasKey=${Boolean(auth.apiKey)}`);
  if (!auth.apiKey || !baseUrl) {
    res.statusCode = 502;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error: { message: `No resolved auth/baseUrl for provider "${provider}" (model "${requestedModel}")` },
      }),
    );
    return;
  }

  const upstream = await fetch(new URL("chat/completions", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${auth.apiKey}`,
    },
    body: JSON.stringify({ ...body, model: upstreamModelId }),
    signal: AbortSignal.timeout(20_000),
  });
  api.logger.info(`[vellum-bridge] upstream responded status=${upstream.status}`);

  res.statusCode = upstream.status;
  res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
  if (!upstream.body) {
    res.end();
    return;
  }
  // Byte-transparent pipe — no JSON re-parse/re-chunk, so delta.tool_calls[].index
  // from the upstream provider passes through completely untouched.
  for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
    res.write(chunk);
  }
  res.end();
}

/** Drive an OpenClaw/Codex agent turn and bridge its tool calls back as OpenAI
 * streamed tool_calls chunks on this same connection (Feature 2). */
async function handleCodexBridge(
  api: OpenClawPluginApi,
  res: ServerResponse,
  sessionKey: string,
  messages: ChatMessage[],
  model: string,
): Promise<void> {
  const lastMessage = messages[messages.length - 1];

  if (lastMessage?.role === "tool" && lastMessage.tool_call_id) {
    // Follow-up round: register this connection as the one waiting for whatever
    // happens next, then unblock the parked edit_document call. We do NOT start
    // a new subagent run here — the original run from the first request is still
    // alive, paused inside edit_document's execute().
    responseBySessionKey.set(sessionKey, res);
    const content = typeof lastMessage.content === "string" ? lastMessage.content : JSON.stringify(lastMessage.content);
    const delivered = resolvePendingToolResult(lastMessage.tool_call_id, content);
    if (!delivered) {
      writeStreamError(res, `No pending tool call ${lastMessage.tool_call_id} for session ${sessionKey}`);
    }
    // Nothing further to do in this request's own handler — the original
    // request's handleCodexBridge call (still awaiting waitForRun below) is
    // responsible for writing the eventual reply onto whichever response is
    // currently registered for this sessionKey.
    return;
  }

  // First round for this sessionKey.
  trustedSessionKeys.add(sessionKey);
  responseBySessionKey.set(sessionKey, res);
  writeAssistantRoleOpen(res);

  const { runId } = await api.runtime.subagent.run({
    sessionKey,
    message: lastUserMessageText(messages),
    model: model || undefined,
  });

  const result = await api.runtime.subagent.waitForRun({ runId, timeoutMs: 10 * 60 * 1000 });

  const currentRes = responseBySessionKey.get(sessionKey);
  if (!currentRes || currentRes.writableEnded) {
    // Either edit_document already closed the last open connection cleanly
    // (tool_calls path) or there's nothing left to write to.
    return;
  }
  responseBySessionKey.delete(sessionKey);
  trustedSessionKeys.delete(sessionKey);

  if (result.status === "ok") {
    writeFinalAssistantMessage(currentRes, await lastAssistantMessageText(api, sessionKey));
  } else {
    writeStreamError(currentRes, `Vellum bridge run ${result.status}: ${result.error ?? "unknown error"}`);
  }
}

/** SubagentWaitResult carries no reply text (only status/error) — the actual
 * assistant reply has to be pulled from the session transcript afterward. */
async function lastAssistantMessageText(api: OpenClawPluginApi, sessionKey: string): Promise<string> {
  const { messages } = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 10 });
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    if (m?.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
        .join("");
      if (text) return text;
    }
  }
  return "";
}

export function registerVellumRoutes(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: ROUTE_PATH,
    // Model overrides on subagent.run are only authorized for gateway-authenticated
    // callers with trusted-operator scope (see plugin-route-runtime-scopes.ts) —
    // auth: "plugin" routes get a client with zero scopes and can never satisfy
    // that check, regardless of plugins.entries.<id>.subagent config. Vellum must
    // present the real gateway bearer token.
    auth: "gateway",
    gatewayRuntimeScopeSurface: "trusted-operator",
    match: "exact",
    async handler(req, res) {
      api.logger.info(`[vellum-bridge] inbound ${req.method} ${req.url}`);
      if (req.method !== "POST") return false;

      const body = await readJsonBody(req);
      const model = String(body.model ?? "");
      const messages = (body.messages as ChatMessage[] | undefined) ?? [];

      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("connection", "keep-alive");

      const sessionHeader = req.headers["x-vellum-session-id"];
      const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

      try {
        if (needsToolBridge(body, messages)) {
          if (!sessionId) {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: { message: "x-vellum-session-id header is required for tool-bridge requests" } }));
            return true;
          }
          await handleCodexBridge(api, res, `agent:main:vellum:${sessionId}`, messages, model);
        } else {
          await forwardToUpstream(api, req, res, body);
        }
      } catch (err) {
        api.logger.error(`[vellum-bridge] request failed: ${err instanceof Error ? err.stack : String(err)}`);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { message: "internal error" } }));
        } else if (!res.writableEnded) {
          writeStreamError(res, "internal error");
        }
      }
      return true;
    },
  });
}
