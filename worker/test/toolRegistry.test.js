import test from "node:test";
import assert from "node:assert/strict";
import { TOOL_REGISTRY, validateToolCall } from "../src/lib/toolRegistry.js";

test("restricted actions cannot be confused with safe actions", () => {
  assert.equal(TOOL_REGISTRY.github.actions.merge_pull_request.risk, "restricted");
  assert.equal(TOOL_REGISTRY.stripe.actions.charge_customer.risk, "restricted");
  assert.equal(TOOL_REGISTRY.files.actions.create_file.risk, "safe");
});

test("tool validation enforces allowlists and required inputs", () => {
  assert.equal(validateToolCall({ plugin_id: "gmail", action: "send_email", params: {} }, ["gmail"]).ok, false);
  assert.equal(validateToolCall({ plugin_id: "gmail", action: "send_email", params: { to: "a@example.com", subject: "Hi", body: "Hello" } }, ["gmail"]).ok, true);
  assert.equal(validateToolCall({ plugin_id: "github", action: "merge_pull_request", params: { owner: "a", repo: "b", pull_number: 1 } }, ["gmail"]).ok, false);
});
