import test from "node:test";
import assert from "node:assert/strict";
import { TOOL_MANIFEST_VERSION as serverVersion, TOOL_REGISTRY as serverRegistry } from "../src/connectors/manifest.js";
import { TOOL_MANIFEST_VERSION as workerVersion, TOOL_REGISTRY as workerRegistry } from "../../worker/src/lib/toolRegistry.js";

const contract = (registry) => Object.fromEntries(Object.entries(registry).map(([pluginId, plugin]) => [pluginId,
  Object.fromEntries(Object.entries(plugin.actions).map(([action, definition]) => [action, { risk: definition.risk, required: definition.required }]))
]));

test("server and worker share the same versioned tool contract", () => {
  assert.equal(serverVersion, workerVersion);
  assert.deepEqual(contract(serverRegistry), contract(workerRegistry));
});
