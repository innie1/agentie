import assert from "node:assert/strict";
import test from "node:test";

import {
  configuredCorsOrigins,
  isAllowedCorsOrigin,
} from "../src/lib/corsPolicy.js";

test("Agentie localhost web and installed-app origins are allowed", () => {
  const configured = configuredCorsOrigins({
    NODE_ENV: "production",
    APP_URL: "https://agentie.example",
  });

  assert.equal(isAllowedCorsOrigin("http://127.0.0.1:3000", configured), true);
  assert.equal(isAllowedCorsOrigin("http://localhost:8080", configured), true);
  assert.equal(isAllowedCorsOrigin("https://agentie.example", configured), true);
});

test("unconfigured remote origins remain blocked", () => {
  const configured = configuredCorsOrigins({ APP_URL: "https://agentie.example" });

  assert.equal(isAllowedCorsOrigin("https://untrusted.example", configured), false);
});
