import axios from "axios";
import { getModelForRole } from "./modelConfig.js";

function fallbackTags(role = "", goal = "") {
  const text = `${role} ${goal}`.toLowerCase();
  if (/social|content creator|social media/.test(text)) return ["Social Media Manager", "Content Creator", "Social Media", "Content"];
  if (/software|developer|engineer|coding|programmer/.test(text)) return ["Software Engineer", "Coding", "Software Development"];
  if (/laundry|dry clean|cleaning service/.test(text)) return ["Laundry", "Business Manager", "Operations"];
  if (/finance|accountant|accounting|bookkeep|budget|investment/.test(text)) return ["Finance", "Accounting", "Budgeting"];
  if (/marketing|advertis|brand|sales/.test(text)) return ["Marketing", "Advertising", "Sales"];
  if (/customer support|customer service|support/.test(text)) return ["Customer Support", "Customer Service", "Communication"];
  if (/research|researcher|analyst|analysis/.test(text)) return ["Researcher", "Research", "Analysis"];
  if (/church|pastor|ministry|christian|faith/.test(text)) return ["Ministry", "Church", "Community"];
  if (/manager|management|operations|business|entrepreneur|owner/.test(text)) return ["Business Manager", "Management", "Operations"];
  return [String(role || "AI Assistant").trim(), "Professional Assistant"].filter(Boolean).slice(0, 3);
}

function cleanTags(tags, fallback) {
  if (!Array.isArray(tags)) return fallback;
  const out = tags.map(v => String(v).trim()).filter(Boolean)
    .filter((v, i, a) => a.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i)
    .slice(0, 6);
  return out.length ? out : fallback;
}

export async function generateAgentTags({ role = "", goal = "" } = {}) {
  const fallback = fallbackTags(role, goal);
  try {
    const model = await getModelForRole("fast");
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model,
        temperature: 0.5,
        max_tokens: 220,
        messages: [
          {
            role: "system",
            content: `You are Agentie's Brain. Generate 2-6 concise professional identity tags for an AI agent. Tags must describe the agent's JOB, ROLE, INDUSTRY, SPECIALIZATION, or SERVICE — what the agent is and does. Do NOT generate tags for tools, integrations, APIs, apps, models, plugins, Gmail, GitHub, browser, web search, or other technology connections. Do not use a fixed taxonomy if a more precise tag fits. Return ONLY valid JSON in this exact shape: {"tags":["..."]}.`
          },
          { role: "user", content: `Role: ${role || "not specified"}\nGoal: ${goal || "not specified"}` }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 12000
      }
    );
    const text = response?.data?.choices?.[0]?.message?.content?.trim();
    if (!text) return fallback;
    const parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
    return cleanTags(parsed.tags, fallback);
  } catch (err) {
    console.error("[tags] Brain tag generation failed, using fallback:", err.message);
    return fallback;
  }
}
