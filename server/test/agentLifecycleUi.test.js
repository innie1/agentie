import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const interfacePath = new URL("../../index.html", import.meta.url);

test("agents are created only through the explicit add control", async () => {
  const html = await readFile(interfacePath, "utf8");

  assert.match(
    html,
    /addAgentBtnTop\.addEventListener\('click', \(\) => createNewAgent\(\)\)/,
  );
  assert.doesNotMatch(
    html,
    /if \(!state\.activeAgentId\)\s*\{\s*createNewAgent\(\);?\s*\}/,
  );
  assert.match(html, /Create an agent to start/);
  assert.match(html, /No agent selected/);
});

test("agent deletion uses one permanent deletion handler", async () => {
  const html = await readFile(interfacePath, "utf8");
  const handlers = html.match(/(?:async\s+)?function\s+confirmDeleteAgent\s*\(/g) || [];

  assert.equal(handlers.length, 1);
  assert.match(html, /controlPlaneJson\(`api\/agents\/\$\{backendId\}`,[\s\S]*?method: 'DELETE'/);
  assert.match(
    html,
    /confirmDeleteBtn\.addEventListener\('click', confirmDeleteAgent\)/,
  );
});
