import express from "express";
import { supabaseAdmin } from "../supabaseClient.js";
import { generateAgentName } from "../lib/naming.js";

const router = express.Router();

// GET /api/agents
router.get("/", async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("agents")
    .select("*")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ agents: data });
});

// POST /api/agents  { name?, role, goal, allowed_plugins? }
router.post("/", async (req, res) => {
  const userId = req.user.id;
  const { name, role, goal, allowed_plugins = [] } = req.body;

  if (!role && !goal) {
    return res.status(400).json({ error: "role or goal is required to create an agent" });
  }

  const { data: existing } = await supabaseAdmin
    .from("agents")
    .select("name")
    .eq("user_id", userId);
  const takenNames = new Set((existing || []).map((a) => a.name.toLowerCase()));

  let finalName = name;
  let nameSource = "user";

  if (!finalName) {
    finalName = await generateAgentName({ role, goal, taken: takenNames });
    nameSource = "auto";
  } else if (takenNames.has(finalName.toLowerCase())) {
    return res.status(409).json({ error: `You already have an agent named "${finalName}". Pick another name.` });
  }

  const system_prompt = `You are ${finalName}, an AI agent whose job is: ${goal || role}. Act on behalf of your user, use only the tools you've been given access to, and always pause for approval before sending, deleting, paying, or publishing anything.`;

  const { data, error } = await supabaseAdmin
    .from("agents")
    .insert({
      user_id: userId,
      name: finalName,
      name_source: nameSource,
      role,
      goal,
      system_prompt,
      allowed_plugins,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "That agent name is already taken." });
    }
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json({ agent: data });
});

// PATCH /api/agents/:id
router.patch("/:id", async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;
  const allowedFields = [
    "name", "role", "goal", "system_prompt", "allowed_plugins",
    "auto_approved_actions", "allowed_handoff_agents", "status",
  ];
  const updates = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowedFields.includes(k))
  );
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from("agents")
    .update(updates)
    .eq("id", id)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That agent name is already taken." });
    return res.status(500).json({ error: error.message });
  }
  res.json({ agent: data });
});

// DELETE /api/agents/:id
router.delete("/:id", async (req, res) => {
  const { error } = await supabaseAdmin
    .from("agents")
    .delete()
    .eq("id", req.params.id)
    .eq("user_id", req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

export default router;
