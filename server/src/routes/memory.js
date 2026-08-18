import express from "express";
import { supabaseAdmin } from "../supabaseClient.js";

const router = express.Router();

async function ownsAgent(userId, agentId) {
  const { data } = await supabaseAdmin.from("agents").select("id").eq("id", agentId).eq("user_id", userId).maybeSingle();
  return Boolean(data);
}

router.get("/", async (req, res) => {
  const agentId = String(req.query.agent_id || "").trim();
  if (!agentId) return res.status(400).json({ error: "agent_id is required" });
  if (!(await ownsAgent(req.user.id, agentId))) return res.status(404).json({ error: "Agent not found" });

  const { data, error } = await supabaseAdmin.from("agent_memory")
    .select("id,key,value,content,kind,confidence,pinned,sensitive,source_task_id,updated_at")
    .eq("agent_id", agentId)
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ memories: data || [] });
});

router.patch("/:id", async (req, res) => {
  const { data: memory } = await supabaseAdmin.from("agent_memory").select("id,agent_id,key").eq("id", req.params.id).maybeSingle();
  if (!memory || !(await ownsAgent(req.user.id, memory.agent_id))) return res.status(404).json({ error: "Memory not found" });
  const updates = {};
  if (typeof req.body?.pinned === "boolean") updates.pinned = req.body.pinned;
  if (typeof req.body?.sensitive === "boolean") updates.sensitive = req.body.sensitive;
  if (typeof req.body?.value === "string") {
    updates.value = req.body.value.trim().slice(0, 1000);
    updates.content = `${memory.key}: ${updates.value}`;
  }
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabaseAdmin.from("agent_memory").update(updates).eq("id", memory.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ memory: data });
});

router.delete("/:id", async (req, res) => {
  const { data: memory } = await supabaseAdmin.from("agent_memory").select("id,agent_id").eq("id", req.params.id).maybeSingle();
  if (!memory || !(await ownsAgent(req.user.id, memory.agent_id))) return res.status(404).json({ error: "Memory not found" });
  const { error } = await supabaseAdmin.from("agent_memory").delete().eq("id", memory.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

export default router;
