import assert from "node:assert/strict";
import test from "node:test";

import { registerEditDocumentTool, resolvePendingToolResult } from "../dist/edit-document-tool.js";
import { responseBySessionKey, trustedSessionKeys } from "../dist/session-bridge.js";

function mockResponse() {
  const writes = [];
  return {
    writableEnded: false,
    writes,
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
