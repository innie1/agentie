import { fastChat } from "./fastChat.js";

const ROLE_HINTS = {
  email: ["email", "inbox", "gmail", "outlook", "mail", "newsletter"],
  coding: ["code", "coding", "developer", "software", "bug", "debug", "program", "repository", "github"],
  research: ["research", "competitor", "investigate", "find information", "market research", "sources"],
  finance: ["finance", "financial", "budget", "expense", "revenue", "profit", "accounting", "invoice"],
  sales: ["sales", "lead", "prospect", "outreach", "pipeline", "customer acquisition"],
  marketing: ["marketing", "advert", "advertising", "campaign", "social media", "brand", "content"],
  scheduling: ["calendar", "schedule", "meeting", "appointment", "reminder", "book a time"],
  customer_support: ["support", "customer complaint", "ticket", "help desk", "customer service"],
  business: ["business idea", "business plan", "strategy", "growth", "operations", "business opportunity"],
};

function haystack(agent) {
  return [agent.name, agent.role, agent.goal, ...(Array.isArray(agent.tags) ? agent.tags : [])].filter(Boolean).join(" ").toLowerCase();
}

function scoreAgent(message, agent) {
  const text = String(message || "").toLowerCase();
  const profile = haystack(agent);
  let score = 0;
  for (const [capability, hints] of Object.entries(ROLE_HINTS)) {
    if (!hints.some((h) => text.includes(h))) continue;
    if (profile.includes(capability.replace("_", " "))) score += 5;
    if (hints.some((h) => profile.includes(h))) score += 3;
  }
  return score;
}

export async function routeToBestAgent({ message, currentAgent, roster }) {
  const active = (roster || []).filter((a) => a.status === "active" && a.id !== currentAgent?.id);
  if (!active.length) return { routed: false, reason: "no_other_agent" };

  const scored = active.map((agent) => ({ agent, score: scoreAgent(message, agent) })).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best?.score >= 4) {
    return { routed: true, agent: best.agent, confidence: Math.min(0.99, 0.55 + best.score * 0.06), method: "capability_match" };
  }

  try {
    const routingAgent = currentAgent || active[0];
    const prompt = [
      "You are an internal workforce router.",
      "Choose the existing AI employee best suited to the user's request based on their natural-language role, goal, tags and tools.",
      "Return ONLY JSON: {\"agent_id\":\"existing-id-or-NONE\",\"reason\":\"short reason\"}.",
      "Never invent an ID.",
      "USER REQUEST:", String(message || ""),
      "CURRENT AGENT:", JSON.stringify({ id: currentAgent?.id, name: currentAgent?.name, role: currentAgent?.role, goal: currentAgent?.goal }),
      "WORKFORCE:", JSON.stringify(active.map((a) => ({ id: a.id, name: a.name, role: a.role, goal: a.goal, tags: a.tags }))),
    ].join("\n");
    const { text } = await fastChat({ agent: routingAgent, message: prompt, history: [] });
    const match = String(text || "").match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : null;
    const target = active.find((a) => a.id === parsed?.agent_id);
    if (target) return { routed: true, agent: target, confidence: 0.8, method: "semantic_role_match", reason: parsed.reason || "Best role match" };
  } catch (err) {
    console.warn("[workforceRouter] semantic routing unavailable:", err.message);
  }
  return { routed: false, reason: "no_confident_match" };
}
