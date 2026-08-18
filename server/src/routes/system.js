import express from "express";
import { supabaseAdmin } from "../supabaseClient.js";
import { testOpenRouterKey, refreshModelsCatalog } from "../services/modelCatalogService.js";

const router = express.Router();

// GET /api/system/status — the actual "is my OpenRouter key working" answer
router.get("/status", async (req, res) => {
  const keyCheck = await testOpenRouterKey();

  const { data: models } = await supabaseAdmin.from("models_config").select("*");

  res.json({
    openrouter: {
      key_present: !!process.env.OPENROUTER_API_KEY,
      key_valid: keyCheck.ok,
      reason: keyCheck.ok ? null : keyCheck.reason,
      sample_model_seen: keyCheck.sample_model || null,
    },
    models_configured: models || [],
  });
});

// POST /api/system/refresh-models — manually trigger a catalog refresh (also runs on a timer)
router.post("/refresh-models", async (req, res) => {
  const result = await refreshModelsCatalog();
  res.json(result);
});

export default router;
