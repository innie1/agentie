import axios from "axios";
import { getModelForRole } from "./modelConfig.js";

function normalize(text = "") {
  return String(text).toLowerCase();
}

const FALLBACK_CHARACTER = {
  version: 1,
  personality: "capable, warm, curious, proactive, and grounded",
  tone: "clear, natural, confident, and conversational",
  communication_style: "concise by default; explains reasoning when useful; asks focused questions when information is missing",
  values: ["helpfulness", "accuracy", "honesty", "user control", "practical results"],
  behaviors: [
    "understand the user's intent before acting",
    "remember relevant conversation context",
    "never pretend to have completed an action that was not completed",
    "surface uncertainty instead of inventing facts",
    "proactively suggest useful next steps when appropriate"
  ],
  quirks: [],
  boundaries: [
    "do not expose secrets or credentials",
    "do not perform irreversible actions without the existing approval guardrail"
  ]
};

function sanitizeCharacter(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  return {
    version: 1,
    personality: String(c.personality || FALLBACK_CHARACTER.personality).slice(0, 500),
    tone: String(c.tone || FALLBACK_CHARACTER.tone).slice(0, 500),
    communication_style: String(c.communication_style || FALLBACK_CHARACTER.communication_style).slice(0, 700),
    values: Array.isArray(c.values) ? c.values.map(String).slice(0, 10) : FALLBACK_CHARACTER.values,
    behaviors: Array.isArray(c.behaviors) ? c.behaviors.map(String).slice(0, 12) : FALLBACK_CHARACTER.behaviors,
    quirks: Array.isArray(c.quirks) ? c.quirks.map(String).slice(0, 8) : [],
    boundaries: Array.isArray(c.boundaries) ? c.boundaries.map(String).slice(0, 10) : FALLBACK_CHARACTER.boundaries,
  };
}

/**
 * The Brain creates the character from the user's actual request.
 * This is intentionally AI-generated rather than selected from a fixed
 * personality table, so two agents with similar roles can still develop
 * distinct, useful identities.
 */
export async function generateAgentCharacter({ role = "", goal = "" } = {}) {
  const fallback = buildAgentCharacter({ role, goal });

  try {
    const model = await getModelForRole("fast");
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model,
        temperature: 0.8,
        max_tokens: 700,
        messages: [
          {
            role: "system",
            content: `You are Agentie's Brain. Design a useful, distinctive character for a newly created AI agent.
Return ONLY valid JSON. Do not use markdown.
The character must fit the user's requested purpose, not a generic personality.
Keep it professional and helpful. Never include secrets, credentials, or unsafe instructions.
JSON shape:
{
  "personality": "...",
  "tone": "...",
  "communication_style": "...",
  "values": ["..."],
  "behaviors": ["..."],
  "quirks": ["..."],
  "boundaries": ["..."]
}`
          },
          {
            role: "user",
            content: `Agent role: ${role || "not specified"}\nAgent goal: ${goal || "not specified"}`
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );

    const text = response?.data?.choices?.[0]?.message?.content?.trim();
    if (!text) return fallback;

    const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    return sanitizeCharacter(JSON.parse(cleaned));
  } catch (err) {
    console.error("[character] Brain generation failed, using safe fallback:", err.message);
    return fallback;
  }
}

export function buildAgentCharacter({ role = "", goal = "" } = {}) {
  const text = normalize(`${role} ${goal}`);
  const character = structuredClone(FALLBACK_CHARACTER);

  if (/manager|manage|operations|business|entrepreneur|owner/.test(text)) {
    character.personality = "strategic, practical, organized, proactive, and commercially minded";
    character.tone = "friendly, direct, businesslike, and encouraging";
    character.communication_style = "turns vague goals into concrete next steps; highlights priorities, tradeoffs, costs, and measurable outcomes";
    character.behaviors.push("look for bottlenecks, opportunities, and practical improvements");
  } else if (/finance|account|money|budget|bookkeep|investment/.test(text)) {
    character.personality = "careful, analytical, disciplined, and reassuring";
    character.tone = "calm, precise, and easy to understand";
    character.communication_style = "shows important numbers clearly and distinguishes facts, assumptions, and recommendations";
  } else if (/marketing|sales|brand|advertis|social/.test(text)) {
    character.personality = "creative, energetic, observant, and results-focused";
    character.tone = "engaging, confident, and practical";
    character.communication_style = "offers concrete ideas, examples, hooks, and tests rather than generic advice";
  } else if (/developer|engineer|code|software|technical|program/.test(text)) {
    character.personality = "methodical, curious, pragmatic, and technically rigorous";
    character.tone = "clear, calm, and precise";
    character.communication_style = "explains the smallest reliable change first and separates diagnosis from implementation";
  } else if (/research|analyst|researcher/.test(text)) {
    character.personality = "curious, skeptical, evidence-focused, and thorough";
    character.tone = "neutral, clear, and intellectually honest";
    character.communication_style = "separates known facts from assumptions and identifies what still needs verification";
  }

  if (/christian|church|faith|pastor|ministry/.test(text)) {
    character.values.push("service", "compassion", "integrity");
    character.tone = "warm, respectful, encouraging, and grounded";
  }

  return character;
}

export function characterPrompt(character = {}) {
  if (!character || typeof character !== "object") return "";
  const lines = [
    `Personality: ${character.personality || "capable and helpful"}`,
    `Tone: ${character.tone || "clear and natural"}`,
    `Communication style: ${character.communication_style || "conversational and concise"}`,
    Array.isArray(character.values) ? `Values: ${character.values.join(", ")}` : "",
    Array.isArray(character.behaviors) ? `Behaviors: ${character.behaviors.map(v => `- ${v}`).join(" ")}` : "",
    Array.isArray(character.quirks) && character.quirks.length ? `Quirks: ${character.quirks.join(", ")}` : "",
    Array.isArray(character.boundaries) ? `Boundaries: ${character.boundaries.map(v => `- ${v}`).join(" ")}` : ""
  ];
  return lines.filter(Boolean).join("\n");
}
