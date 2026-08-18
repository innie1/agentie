const operationalLead = /^(?:please\s+)?(?:send|schedule|book|publish|delete|remove|download|export|run|execute|delegate|assign|organize|deploy|upload)\b/i;
const artifactRequest = /\b(?:create|make|generate|write|build|edit|update)\b[\s\S]{0,100}\b(?:file|document|docx|pdf|spreadsheet|xlsx|csv|presentation|pptx|report|invoice|calendar event|email draft|codebase|application|app|website)\b/i;
const currentResearch = /^(?:please\s+)?(?:research|investigate|search|look up|browse)\b/i;
const explicitTask = /\b(?:create|add|make|turn (?:this|it) into)\s+(?:a\s+)?(?:task|routine|reminder|calendar event)|\b(?:send|publish|delete|pay|book|schedule)\s+(?:it|this|that|the)\b/i;
const durableGoal = /\b(?:i want to|i need to|my goal is|i plan to|help me become|i would like to)\b/i;
const recurringSignal = /\b(?:daily|weekly|every day|every week|every morning|every evening|every night|regularly|habit|routine|remind|consistently|each morning|each night)\b/i;

export function classifyMessageIntent(message = "") {
  const text = String(message || "").trim();
  if (!text) return { type: "conversation", confidence: 1, reason: "empty" };
  if (explicitTask.test(text) || operationalLead.test(text) || artifactRequest.test(text) || currentResearch.test(text)) return { type: "confirmed_task", confidence: 0.96, reason: "explicit_execution_language" };
  if (durableGoal.test(text)) {
    return {
      type: "suggested_action",
      confidence: recurringSignal.test(text) ? 0.9 : 0.78,
      reason: recurringSignal.test(text) ? "goal_with_recurring_signal" : "durable_goal_without_execution_confirmation",
      suggestions: recurringSignal.test(text) ? ["Create a plan", "Set up a routine", "Keep this as conversation"] : ["Create a plan", "Create a one-time task", "Keep this as conversation"],
    };
  }
  return { type: "conversation", confidence: 0.86, reason: "reply_is_sufficient" };
}
