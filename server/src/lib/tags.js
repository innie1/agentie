import { deriveAgentIdentity } from "./agentIdentity.js";

// Keep one primary tag: the agent's responsibility, never a tool or synonym.
export async function generateAgentTags({ role = "", goal = "" } = {}) {
  return [deriveAgentIdentity({ role, goal }).tag];
}
