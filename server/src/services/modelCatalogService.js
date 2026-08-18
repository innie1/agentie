import axios from "axios";
import { supabaseAdmin } from "../supabaseClient.js";

const MODELS_URL = "https://openrouter.ai/api/v1/models";

// Fallbacks used ONLY if the live catalog fetch fails entirely (network issue,
// OpenRouter outage) — not treated as permanently correct, just a safety net.
const HARD_FALLBACK = {
  fast: "openai/gpt-4o-mini",
  reasoning: "meta-llama/llama-3.3-70b-instruct",
};

/**
 * Pulls OpenRouter's live catalog, filtered to models that support tool calling
 * (required — Agentie's agent loop depends on structured tool/action output),
 * then picks:
 *   - "fast": highest-throughput tool-capable model, for greetings/simple replies
 *             and intent classification
 *   - "reasoning": a strong, current tool-capable model with a large context
 *             window, for actual task planning
 * Writes the result to models_config so the worker picks it up on its next
 * cache refresh (worker/src/lib/modelConfig.js polls this table).
 */
export async function refreshModelsCatalog() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn("[modelCatalog] OPENROUTER_API_KEY not set — skipping catalog refresh, using existing models_config values.");
    return { ok: false, reason: "no_api_key" };
  }

  try {
    const [fastRes, reasoningRes] = await Promise.all([
      axios.get(MODELS_URL, {
        params: { supported_parameters: "tools", sort: "throughput-high-to-low" },
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      }),
      axios.get(MODELS_URL, {
        params: { supported_parameters: "tools", sort: "newest" },
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      }),
    ]);

    const fastCandidates = fastRes.data?.data || [];
    const reasoningCandidates = reasoningRes.data?.data || [];

    const fastModel = pickFastModel(fastCandidates);
    const reasoningModel = pickReasoningModel(reasoningCandidates);

    if (!fastModel && !reasoningModel) {
      console.warn("[modelCatalog] Live catalog returned no usable tool-calling models, keeping current models_config as-is.");
      return { ok: false, reason: "no_candidates" };
    }

    const updates = [];
    if (fastModel) updates.push({ role: "fast", model_id: fastModel.id, updated_at: new Date().toISOString() });
    if (reasoningModel) updates.push({ role: "reasoning", model_id: reasoningModel.id, updated_at: new Date().toISOString() });

    const { error } = await supabaseAdmin.from("models_config").upsert(updates, { onConflict: "role" });
    if (error) throw error;

    console.log(`[modelCatalog] refreshed — fast: ${fastModel?.id || "(unchanged)"}, reasoning: ${reasoningModel?.id || "(unchanged)"}`);
    return { ok: true, fast: fastModel?.id, reasoning: reasoningModel?.id };
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) {
      console.error("[modelCatalog] OpenRouter rejected the API key (401). Check OPENROUTER_API_KEY in both server and worker env vars.");
      return { ok: false, reason: "invalid_api_key" };
    }
    console.error("[modelCatalog] catalog refresh failed, keeping existing models_config:", err.message);
    return { ok: false, reason: "fetch_failed", detail: err.message };
  }
}

function pickFastModel(candidates) {
  // Prefer models with cheap+fast pricing signals, actual context, and no known
  // "beta"/"free" instability flags for something meant to run constantly.
  const usable = candidates.filter((m) => m.context_length >= 8000 && !m.id.includes(":free"));
  return usable[0] || candidates[0] || null;
}

function pickReasoningModel(candidates) {
  // Prefer larger context window among recently-listed tool-capable models —
  // "newest" sort already biases toward current models over stale ones.
  const usable = candidates
    .filter((m) => m.context_length >= 32000 && !m.id.includes(":free"))
    .sort((a, b) => (b.context_length || 0) - (a.context_length || 0));
  return usable[0] || candidates[0] || null;
}

/** Does a live, cheap ping to confirm the key actually works right now. */
export async function testOpenRouterKey() {
  if (!process.env.OPENROUTER_API_KEY) return { ok: false, reason: "no_api_key" };
  try {
    const res = await axios.get(MODELS_URL, {
      params: { limit: 1 },
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    });
    return { ok: true, sample_model: res.data?.data?.[0]?.id || null };
  } catch (err) {
    if (err.response?.status === 401) return { ok: false, reason: "invalid_api_key" };
    return { ok: false, reason: "network_error", detail: err.message };
  }
}

export { HARD_FALLBACK };
