import axios from "axios";
import { supabaseAdmin } from "../supabaseClient.js";

const MODELS_URL = "https://openrouter.ai/api/v1/models";

const HARD_FALLBACK = {
  fast: "google/gemini-2.5-flash",
  reasoning: "google/gemini-2.5-pro",
};

/**
 * Pull the current OpenRouter catalog and persist it using the actual
 * models_config schema: id + tier + model_id. The previous implementation
 * wrote a nonexistent `role` column, which made every catalog refresh fail.
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
    const fastModel = pickFastModel(fastCandidates) || { id: HARD_FALLBACK.fast };
    const reasoningModel = pickReasoningModel(reasoningCandidates) || { id: HARD_FALLBACK.reasoning };
    const updatedAt = new Date().toISOString();

    const updates = [
      { id: "fast", tier: "fast", model_id: fastModel.id, updated_at: updatedAt },
      { id: "reasoning", tier: "reasoning", model_id: reasoningModel.id, updated_at: updatedAt },
    ];

    const { error } = await supabaseAdmin
      .from("models_config")
      .upsert(updates, { onConflict: "id" });
    if (error) throw error;

    console.log(`[modelCatalog] refreshed — fast: ${fastModel.id}, reasoning: ${reasoningModel.id}`);
    return { ok: true, fast: fastModel.id, reasoning: reasoningModel.id };
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) {
      console.error("[modelCatalog] OpenRouter rejected the API key (401). Check OPENROUTER_API_KEY.");
      return { ok: false, reason: "invalid_api_key" };
    }
    console.error("[modelCatalog] catalog refresh failed, keeping existing models_config:", err.message);
    return { ok: false, reason: "fetch_failed", detail: err.message };
  }
}

function pickFastModel(candidates) {
  const usable = candidates.filter((m) => m.context_length >= 8000 && !m.id.includes(":free"));
  return usable[0] || candidates[0] || null;
}

function pickReasoningModel(candidates) {
  const usable = candidates
    .filter((m) => m.context_length >= 32000 && !m.id.includes(":free"))
    .sort((a, b) => (b.context_length || 0) - (a.context_length || 0));
  return usable[0] || candidates[0] || null;
}

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
