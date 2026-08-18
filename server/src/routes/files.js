import express from "express";
import { supabaseAdmin } from "../supabaseClient.js";

const router = express.Router();

router.get("/", async (req, res) => {
  let q = supabaseAdmin.from("agent_files").select("id,name,mime_type,extension,size_bytes,version,agent_id,created_at,updated_at").eq("user_id", req.user.id).order("updated_at", { ascending: false });
  if (req.query.agent_id) q = q.eq("agent_id", req.query.agent_id);
  const { data, error } = await q; if (error) return res.status(500).json({ error: error.message }); res.json({ files: data || [] });
});

router.get("/:id", async (req, res) => {
  const { data, error } = await supabaseAdmin.from("agent_files").select("*").eq("id", req.params.id).eq("user_id", req.user.id).single();
  if (error || !data) return res.status(404).json({ error: error?.message || "File not found" });
  const buffer = Buffer.from(data.content_base64 || "", "base64");
  res.setHeader("Content-Type", data.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${data.name.replace(/"/g, "")}"`);
  res.send(buffer);
});

router.patch("/:id", async (req, res) => {
  const { content, name } = req.body || {};
  if (typeof content !== "string") return res.status(400).json({ error: "content is required" });
  const { data: current, error: readError } = await supabaseAdmin.from("agent_files").select("*").eq("id", req.params.id).eq("user_id", req.user.id).single();
  if (readError || !current) return res.status(404).json({ error: readError?.message || "File not found" });
  if (!["txt", "md", "json", "csv", "html"].includes(current.extension)) return res.status(400).json({ error: "Direct editing is currently supported for text, Markdown, JSON, CSV and HTML files. Ask the agent to regenerate an Office/PDF file instead." });
  const filename = String(name || current.name).replace(/[^a-zA-Z0-9._ -]/g, "_");
  const buffer = Buffer.from(content, "utf8");
  const { data, error } = await supabaseAdmin.from("agent_files").update({ name: filename, content_text: content, content_base64: buffer.toString("base64"), size_bytes: buffer.length, version: (current.version || 1) + 1, updated_at: new Date().toISOString() }).eq("id", current.id).eq("user_id", req.user.id).select("id,name,mime_type,extension,size_bytes,version,created_at,updated_at").single();
  if (error) return res.status(500).json({ error: error.message }); res.json({ file: data });
});

export default router;
