import express from "express";
import { supabaseAdmin } from "../supabaseClient.js";
import { getOrCreateConversation } from "../services/conversationService.js";

const router = express.Router();

router.get("/", async (req, res) => {
  const { data, error } = await supabaseAdmin.from("conversations").select("*")
    .eq("user_id", String(req.user.id)).order("updated_at", { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ conversations: data || [] });
});

router.post("/", async (req, res) => {
  const agentId = req.body?.agent_id;
  if (!agentId) return res.status(400).json({ error: "agent_id is required" });
  const { data: agent } = await supabaseAdmin.from("agents").select("id,name").eq("id", agentId).eq("user_id", req.user.id).maybeSingle();
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  try {
    const conversation = await getOrCreateConversation({ userId: req.user.id, agentId, title: req.body?.title || agent.name });
    res.status(201).json({ conversation });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get("/:id/messages", async (req, res) => {
  const { data: conversation } = await supabaseAdmin.from("conversations").select("id").eq("id", req.params.id).eq("user_id", String(req.user.id)).maybeSingle();
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });
  const { data, error } = await supabaseAdmin.from("messages").select("*").eq("conversation_id", conversation.id).order("created_at", { ascending: true }).limit(500);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ messages: data || [] });
});

export default router;
