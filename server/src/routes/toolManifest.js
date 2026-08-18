import express from "express";
import { supabaseAdmin } from "../supabaseClient.js";
import { TOOL_MANIFEST_VERSION, toolsForAgent } from "../connectors/manifest.js";

const router = express.Router();
router.get("/", async (req, res) => {
  const agentId = req.query.agent_id;
  if (!agentId) return res.status(400).json({ error: "agent_id is required" });
  const { data: agent } = await supabaseAdmin.from("agents").select("allowed_plugins").eq("id", agentId).eq("user_id", req.user.id).maybeSingle();
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  res.json({ version: TOOL_MANIFEST_VERSION, tools: toolsForAgent([...(agent.allowed_plugins || []), "files", "last30days"]) });
});
export default router;
