import assert from "node:assert/strict";
import test from "node:test";

import {
  registerEditDocumentTool,
  resolvePendingToolResult,
  sessionKeyForPendingToolResult,
} from "../dist/edit-document-tool.js";
import { registerVellumRoutes } from "../dist/passthrough.js";
import { responseBySessionKey, trustedSessionKeys } from "../dist/session-bridge.js";

function mockResponse() {
  const writes = [];
  return {
    headersSent: false,
    writableEnded: false,
    writes,
    setHeader() {},
    write(value) {
      writes.push(value);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    flushHeaders() {},
  };
}

function request(body, sessionId) {
  return {
    method: "POST",
    url: "/vellum/v1/chat/completions",
    headers: sessionId ? { "x-vellum-session-id": sessionId } : {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  };
}

function toolCall(response) {
  const event = response.writes
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)))
    .find((payload) => payload.choices?.[0]?.delta?.tool_calls);
  return event.choices[0].delta.tool_calls[0];
}

test("edit_document emits Vellum replacements and resumes two sequential tool follow-ups", async () => {
  let factory;
  const api = {
    logger: { info() {} },
    registerTool(candidate) {
      factory = candidate;
    },
    registerTrustedToolPolicy() {},
  };
  registerEditDocumentTool(api);

  const sessionKey = "agent:main:vellum:test";
  trustedSessionKeys.add(sessionKey);
  const tool = factory({ sessionKey });
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["new_string", "old_string"]);

  const firstResponse = mockResponse();
  responseBySessionKey.set(sessionKey, firstResponse);
  const first = tool.execute("call-first", { old_string: "one", new_string: "two" });
  assert.deepEqual(JSON.parse(toolCall(firstResponse).function.arguments), { old_string: "one", new_string: "two" });
  assert.equal(firstResponse.writableEnded, true);
  assert.equal(resolvePendingToolResult("call-first", "applied"), true);
  assert.equal((await first).content[0].text, "applied");

  const secondResponse = mockResponse();
  responseBySessionKey.set(sessionKey, secondResponse);
  const second = tool.execute("call-second", { old_string: "two", new_string: "three" });
  assert.deepEqual(JSON.parse(toolCall(secondResponse).function.arguments), { old_string: "two", new_string: "three" });
  assert.equal(resolvePendingToolResult("call-second", "applied"), true);
  assert.equal((await second).content[0].text, "applied");

  responseBySessionKey.delete(sessionKey);
  trustedSessionKeys.delete(sessionKey);
});

test("a resumed tool_choice none request releases the parked run into final assistant text", async () => {
  let factory;
  let route;
  let finishRun;
  let signalRunStarted;
  const waitForRun = new Promise((resolve) => {
    finishRun = resolve;
  });
  const runStarted = new Promise((resolve) => {
    signalRunStarted = resolve;
  });
  const api = {
    logger: { info() {}, error() {} },
    registerTool(candidate) {
      factory = candidate;
    },
    registerTrustedToolPolicy() {},
    registerHttpRoute(candidate) {
      route = candidate;
    },
    runtime: {
      subagent: {
        async run() {
          signalRunStarted();
          return { runId: "run-final-turn" };
        },
        async waitForRun() {
          return waitForRun;
        },
        async getSessionMessages() {
          return { messages: [{ role: "assistant", content: "All requested edits are complete." }] };
        },
      },
    },
  };
  registerEditDocumentTool(api);
  registerVellumRoutes(api);

  const sessionId = "resumed-final";
  const sessionKey = `agent:main:vellum:${sessionId}`;
  const firstResponse = mockResponse();
  const firstRequest = route.handler(
    request({ model: "openclaw/default", tools: [{ type: "function" }], messages: [{ role: "user", content: "edit" }] }, sessionId),
    firstResponse,
  );
  await runStarted;

  const tool = factory({ sessionKey });
  let currentResponse = firstResponse;
  for (let round = 1; round <= 6; round += 1) {
    const callId = `call-${round}`;
    const pending = tool.execute(callId, { old_string: `before-${round}`, new_string: `after-${round}` });
    assert.equal(toolCall(currentResponse).id, callId);

    const nextResponse = mockResponse();
    await route.handler(
      request(
        {
          model: "openclaw/default",
          ...(round === 6 ? { tool_choice: "none" } : {}),
          messages: [{ role: "tool", tool_call_id: callId, content: "applied" }],
        },
        sessionId,
      ),
      nextResponse,
    );
    assert.equal((await pending).content[0].text, "applied");
    currentResponse = nextResponse;
  }

  const lateEdit = await tool.execute("call-seven", { old_string: "after", new_string: "never" });
  assert.match(lateEdit.content[0].text, /tool_choice: none/);
  assert.equal(sessionKeyForPendingToolResult("call-seven"), undefined);
  assert.equal(currentResponse.writes.filter((line) => line.includes("tool_calls")).length, 0);

  finishRun({ status: "ok" });
  await firstRequest;
  assert.equal(currentResponse.writableEnded, true);
  assert.match(currentResponse.writes.join(""), /All requested edits are complete/);
  assert.equal(responseBySessionKey.has(sessionKey), false);
  assert.equal(trustedSessionKeys.has(sessionKey), false);
});
