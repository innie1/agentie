import axios from "axios";
import { getModelForRole } from "./modelConfig.js";

const THEME_BY_FIELD = {
  business: ["Atlas", "Ledger", "Vantage", "Compass", "Ridgeline"],
  personal: ["Nova", "Wren", "Sable", "Juniper", "Halo"],
  finance: ["Ledger", "Vault", "Meridian", "Tally", "Anchor"],
  creative: ["Muse", "Ember", "Prism", "Indigo", "Sketch"],
  support: ["Haven", "Relay", "Beacon", "Steward", "Anchor"],
  sales: ["Forge", "Pulse", "Falcon", "Bridge", "Summit"],
  dev: ["Circuit", "Byte", "Forge", "Vector", "Cipher"],
  mixed: ["Nova", "Atlas", "Wren", "Ledger", "Beacon"],
};

function classifyField(text = "") {
  const t = text.toLowerCase();
  if (/business|client|invoice|sales|revenue|company/.test(t)) return "business";
  if (/personal|family|life|health|home/.test(t)) return "personal";
  if (/finance|money|budget|invest|expense/.test(t)) return "finance";
  if (/creative|design|music|write|content|art/.test(t)) return "creative";
  if (/support|ticket|customer|help desk/.test(t)) return "support";
  if (/sales|lead|outreach|pipeline/.test(t)) return "sales";
  if (/code|dev|engineer|repo|deploy|bug/.test(t)) return "dev";
  return "mixed";
}

export async function generateAgentName({ role, goal, taken }) {
  const field = classifyField(`${role || ""} ${goal || ""}`);
  const pool = THEME_BY_FIELD[field] || THEME_BY_FIELD.mixed;

  // Try the themed static pool first — fast, no API call needed for the common case
  for (const candidate of pool) {
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }

  // Pool exhausted (unlikely) — ask the fast-tier model to generate a fresh themed name
  try {
    const model = await getModelForRole("fast");
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model,
        max_tokens: 20,
        messages: [
          {
            role: "user",
            content: `Give me ONE short, professional one-word AI agent name in the theme of "${field}". Do not use any of these already-taken names: ${[...taken].join(", ")}. Respond with only the name, nothing else.`,
          },
        ],
      },
      { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } }
    );
    const name = res.data.choices[0].message.content.trim().split(/\s+/)[0];
    if (name && !taken.has(name.toLowerCase())) return name;
  } catch (err) {
    console.error("[naming] model fallback failed:", err.message);
  }

  // Last resort — never leave it unnamed, never silently collide
  let n = 2;
  let fallback = `${pool[0]} ${n}`;
  while (taken.has(fallback.toLowerCase())) {
    n += 1;
    fallback = `${pool[0]} ${n}`;
  }
  return fallback;
}
