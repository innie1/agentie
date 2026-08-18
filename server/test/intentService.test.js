import test from "node:test";
import assert from "node:assert/strict";
import { classifyMessageIntent } from "../src/services/intentService.js";

test("ordinary conversation never becomes a task", () => {
  for (const message of ["hello", "what do you think about remote work?", "write me a short poem", "explain photosynthesis", "I want to lose 10 kg"]) {
    assert.notEqual(classifyMessageIntent(message).type, "confirmed_task", message);
  }
});

test("durable goals produce suggestions without executing", () => {
  const result = classifyMessageIntent("I want to study every morning");
  assert.equal(result.type, "suggested_action");
  assert.ok(result.suggestions.includes("Set up a routine"));
});

test("explicit external work and artifacts become tasks", () => {
  for (const message of ["create a PDF report about our sales", "send this email", "schedule a meeting tomorrow", "research current CRM prices", "build a website for my shop"]) {
    assert.equal(classifyMessageIntent(message).type, "confirmed_task", message);
  }
});
