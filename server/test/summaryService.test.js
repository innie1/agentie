import test from "node:test";
import assert from "node:assert/strict";
import {
  SUMMARY_PROMPT_VERSION,
  createSummaryCacheKey,
  normalizeSummarySource,
  parseSummaryPayload,
} from "../src/lib/summaryService.js";

test("summary parser accepts fenced JSON and removes duplicate bullets", () => {
  const result = parseSummaryPayload(`\`\`\`json
  {"bullets":["- The task is complete.","The task is complete.","Keep the warning."],"takeaway":"Review the completed task."}
  \`\`\``);
  assert.deepEqual(result, {
    bullets: ["The task is complete.", "Keep the warning."],
    takeaway: "Review the completed task.",
  });
});

test("summary parser rejects prose instead of displaying it as a summary", () => {
  assert.throws(() => parseSummaryPayload("Here is your summary: everything looks good."), /did not return JSON/);
});

test("summary parser caps output and removes a repeated takeaway", () => {
  const result = parseSummaryPayload({
    bullets: ["One", "Two", "Three", "Four", "Five", "Six"],
    takeaway: "One",
  });
  assert.deepEqual(result.bullets, ["One", "Two", "Three", "Four", "Five"]);
  assert.equal(result.takeaway, "");
});

test("summary source normalization and versioned cache keys are stable", () => {
  const sourceA = normalizeSummarySource("First line.  \r\n\r\n\r\n\r\nSecond line.\u0000");
  const sourceB = "First line.\n\n\nSecond line.";
  assert.equal(sourceA, sourceB);
  assert.equal(createSummaryCacheKey(sourceA, "model-a"), createSummaryCacheKey(sourceB, "model-a"));
  assert.notEqual(createSummaryCacheKey(sourceA, "model-a"), createSummaryCacheKey(sourceB, "model-b"));
  assert.equal(SUMMARY_PROMPT_VERSION, "precision-summary-v2");
});
