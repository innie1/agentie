import { deriveAgentIdentity, makeUniqueName } from "./agentIdentity.js";

// A job title is clearer and more trustworthy than a randomly themed persona
// name for an autonomous bot, so creation is deliberately deterministic.
export async function generateAgentName({ role = "", goal = "", taken = new Set() } = {}) {
  const { name } = deriveAgentIdentity({ role, goal });
  return makeUniqueName(name, taken);
}
