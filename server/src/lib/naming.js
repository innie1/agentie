import axios from "axios";
import { getModelForRole } from "./modelConfig.js";

const THEME_BY_FIELD = {
  business: ["Atlas", "Vantage", "Compass", "Ridgeline", "Harbor"],
  personal: ["Nova", "Wren", "Sable", "Juniper", "Halo"],
  finance: ["Ledger", "Vault", "Meridian", "Tally", "Anchor"],
  creative: ["Muse", "Ember", "Prism", "Indigo", "Sketch"],
  support: ["Haven", "Relay", "Beacon", "Steward", "Anchor"],
  sales: ["Forge", "Pulse", "Falcon", "Bridge", "Summit"],
  dev: ["Circuit", "Byte", "Vector", "Cipher", "Kernel"],
  mixed: ["Nova", "Atlas", "Wren", "Beacon", "Harbor"],
};

function classifyField(text = "") {
  const t = text.toLowerCase();
  if (/business|client|invoice|sales|revenue|company|laundry|shop|store/.test(t)) return "business";
  if (/personal|family|life|home/.test(t)) return "personal";
  if (/finance|money|budget|invest|expense/.test(t)) return "finance";
  if (/creative|design|music|write|content|art/.test(t)) return "creative";
  if (/support|ticket|customer|help desk/.test(t)) return "support";
  if (/sales|lead|outreach|pipeline/.test(t)) return "sales";
  if (/code|dev|engineer|repo|deploy|bug/.test(t)) return "dev";
  return "mixed";
}

function cleanName(value) {
  return String(value || "")
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/[^A-Za-z0-9 ._-]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 40)
    .trim();
}

export async function generateAgentName({ role, goal, taken }) {
  const field = classifyField(`${role || ""} ${goal || ""}`);
  const pool = THEME_BY_FIELD[field] || THEME_BY_FIELD.mixed;

  // Brain chooses the name first. The static pool is only a safe fallback
  // when the model/API is unavailable; it is never the normal creation path.
  try {
    const model = await getModelForRole("fast");
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model,
        temperature: 0.9,
        max_tokens: 40,
        messages: [
          {
            role: "system",
            content: `You are Agentie's Brain. Create ONE distinctive name for a newly created AI agent. The name must fit the agent's actual purpose, be easy to remember, and not sound like a generic model name. It may be one or two words. Do not copy an existing name. Return ONLY the name.`,
          },
          {
            role: "user",
            content: `Role: ${role || "not specified"}\nGoal: ${goal || "not specified"}\nField: ${field}\nAlready taken: ${[...taken].join(", ") || "none"}`,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );

    const name = cleanName(res.data?.choices?.[0]?.message?.content);
    if (name && !taken.has(name.toLowerCase())) return name;
  } catch (err) {
    console.error("[naming] Brain generation failed, using fallback:", err.message);
  }

  for (const candidate of pool) {
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }

  let n = 2;
  let fallback = `${pool[0]} ${n}`;
  while (taken.has(fallback.toLowerCase())) {
    n += 1;
    fallback = `${pool[0]} ${n}`;
  }
  return fallback;
}
