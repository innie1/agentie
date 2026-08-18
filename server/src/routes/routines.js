import express from "express";
import { supabaseAdmin } from "../supabaseClient.js";
import {
  parsePlainScheduleToCron,
  startRecordingSession,
  captureSessionStep,
  saveRecordingSession,
  recordRoutineRun,
} from "../services/routineService.js";

const router = express.Router();

// helper: confirm the agent belongs to the requesting user before touching its routines
async function assertOwnsAgent(userId, agentId) {
  const { data } = await supabaseAdmin.from("agents").select("id").eq("id", agentId).eq("user_id", userId).single();
  return !!data;
}

// GET /api/routines?agent_id=...  — list saved routines for an agent
router.get("/", async (req, res) => {
  const { agent_id } = req.query;
  if (!agent_id) return res.status(400).json({ error: "agent_id query param is required" });
  if (!(await assertOwnsAgent(req.user.id, agent_id))) return res.status(404).json({ error: "Agent not found" });

  const { data, error } = await supabaseAdmin
    .from("routines")
    .select("*")
    .eq("agent_id", agent_id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ routines: data });
});

// POST /api/routines/parse-schedule  { input: "every day at 1pm" }
router.post("/parse-schedule", (req, res) => {
  const { input } = req.body;
  res.json(parsePlainScheduleToCron(input || ""));
});

// ── Teach Mode recording flow ──

// POST /api/routines/record/start  { agent_id }
router.post("/record/start", async (req, res) => {
  const { agent_id } = req.body;
  if (!agent_id) return res.status(400).json({ error: "agent_id is required" });
  if (!(await assertOwnsAgent(req.user.id, agent_id))) return res.status(404).json({ error: "Agent not found" });

  const session = startRecordingSession(agent_id);
  res.status(201).json({ session });
});

// POST /api/routines/record/step  { session_id, plugin_id, action, params, screenshot? }
router.post("/record/step", (req, res) => {
  const { session_id, plugin_id, action, params, screenshot } = req.body;
  if (!session_id || !plugin_id || !action) {
    return res.status(400).json({ error: "session_id, plugin_id, and action are required" });
  }
  try {
    const step = captureSessionStep(session_id, { plugin_id, action, params, screenshot });
    res.status(201).json({ step });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/routines/record/save  { session_id, name, trigger_patterns?, schedule_input? }
router.post("/record/save", async (req, res) => {
  const { session_id, name, trigger_patterns, schedule_input } = req.body;
  if (!session_id || !name) return res.status(400).json({ error: "session_id and name are required" });

  try {
    const routine = await saveRecordingSession(session_id, { name, trigger_patterns, schedule_input });
    res.status(201).json({ routine });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Manage saved routines ──

// PATCH /api/routines/:id  { name?, trigger_pattern?, schedule?, status? }
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { data: existing } = await supabaseAdmin.from("routines").select("agent_id").eq("id", id).single();
  if (!existing || !(await assertOwnsAgent(req.user.id, existing.agent_id))) {
    return res.status(404).json({ error: "Routine not found" });
  }

  const allowedFields = ["name", "trigger_pattern", "schedule", "status", "steps", "dynamic_fields"];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowedFields.includes(k)));
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin.from("routines").update(updates).eq("id", id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ routine: data });
});

// DELETE /api/routines/:id
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const { data: existing } = await supabaseAdmin.from("routines").select("agent_id").eq("id", id).single();
  if (!existing || !(await assertOwnsAgent(req.user.id, existing.agent_id))) {
    return res.status(404).json({ error: "Routine not found" });
  }
  const { error } = await supabaseAdmin.from("routines").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// POST /api/routines/:id/run — manually trigger a routine right now (outside its schedule)
router.post("/:id/run", async (req, res) => {
  const { id } = req.params;
  const { data: routine } = await supabaseAdmin.from("routines").select("*").eq("id", id).single();
  if (!routine || !(await assertOwnsAgent(req.user.id, routine.agent_id))) {
    return res.status(404).json({ error: "Routine not found" });
  }

  const { data: task, error } = await supabaseAdmin
    .from("tasks")
    .insert({
      user_id: req.user.id,
      agent_id: routine.agent_id,
      instruction: routine.name,
      status: "pending",
      source: "scheduled",
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  try {
    const axios = (await import("axios")).default;
    await axios.post(`${process.env.WORKER_URL}/enqueue`, { taskId: task.id });
  } catch (err) {
    console.error("[routines] failed to notify worker on manual run:", err.message);
  }

  await recordRoutineRun(id, "triggered");
  res.status(201).json({ task });
});

export default router;
