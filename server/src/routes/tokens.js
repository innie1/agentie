import express from "express";
import { supabaseAdmin } from "../supabaseClient.js";

const router = express.Router();

// GET /api/tokens/usage?agent_id=...(optional)&days=30(optional)
// Returns both raw recent rows and a rolled-up summary, since the UI may want either.
router.get("/usage", async (req, res) => {
  const userId = req.user.id;
  const { agent_id, days = 30 } = req.query;

  const since = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000).toISOString();

  let query = supabaseAdmin
    .from("token_usage")
    .select("*")
    .eq("user_id", userId)
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  if (agent_id) query = query.eq("agent_id", agent_id);

  const { data: rows, error } = await query;
  if (error) {
    // If table doesn't exist or is empty, return zeroed summary gracefully
    return res.json({
      summary: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0, calls: 0 },
      rows: []
    });
  }

  const summary = (rows || []).reduce(
    (acc, r) => {
      acc.prompt_tokens += r.prompt_tokens || 0;
      acc.completion_tokens += r.completion_tokens || 0;
      acc.total_tokens += r.total_tokens || 0;
      acc.cost_usd += Number(r.cost_usd || 0);
      acc.calls += 1;
      return acc;
    },
    { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0, calls: 0 }
  );

  res.json({ summary, rows: rows || [] });
});

// GET /api/tokens/usage/by-agent — summary grouped per agent, for a dashboard-style view
router.get("/usage/by-agent", async (req, res) => {
  const userId = req.user.id;
  const { data: rows, error } = await supabaseAdmin
    .from("token_usage")
    .select("agent_id, prompt_tokens, completion_tokens, total_tokens, cost_usd")
    .eq("user_id", userId);
  if (error) return res.json({ agents: [] });

  const byAgent = {};
  for (const r of rows || []) {
    const key = r.agent_id || "unassigned";
    if (!byAgent[key]) byAgent[key] = { agent_id: key, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 };
    byAgent[key].prompt_tokens += r.prompt_tokens || 0;
    byAgent[key].completion_tokens += r.completion_tokens || 0;
    byAgent[key].total_tokens += r.total_tokens || 0;
    byAgent[key].cost_usd += Number(r.cost_usd || 0);
  }

  res.json({ agents: Object.values(byAgent) });
});

export default router;
