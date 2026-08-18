import express from "express";
import { supabaseAdmin } from "../supabaseClient.js";

const router = express.Router();
const SUPPORTED_EDIT_EXTENSIONS = new Set(["txt", "md", "json", "csv", "html"]);

function safeName(name = "file.txt") {
  return String(name).replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180) || "file.txt";
}

function extensionOf(name = "file.txt") {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || "txt";
}

router.get("/", async (req, res) => {
  let q = supabaseAdmin
    .from("agent_files")
    .select("id,name,mime_type,extension,size_bytes,version,agent_id,created_at,updated_at")
    .eq("user_id", req.user.id)
    .order("updated_at", { ascending: false });

  if (req.query.agent_id) q = q.eq("agent_id", req.query.agent_id);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ files: data || [] });
});

// Create a file from the app/chat layer. The worker's files tool uses the same
// table, so files created here are immediately available to agents.
router.post("/", async (req, res) => {
  const { name, content, content_base64, mime_type, agent_id } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required" });
  if (typeof content !== "string" && typeof content_base64 !== "string") {
    return res.status(400).json({ error: "content or content_base64 is required" });
  }

  const filename = safeName(name);
  const extension = extensionOf(filename);
  const buffer = typeof content_base64 === "string"
    ? Buffer.from(content_base64, "base64")
    : Buffer.from(content, "utf8");
  const text = typeof content === "string" ? content : null;

  if (agent_id) {
    const { data: agent } = await supabaseAdmin
      .from("agents")
      .select("id")
      .eq("id", agent_id)
      .eq("user_id", req.user.id)
      .single();
    if (!agent) return res.status(404).json({ error: "Agent not found" });
  }

  const { data, error } = await supabaseAdmin.from("agent_files").insert({
    user_id: req.user.id,
    agent_id: agent_id || null,
    name: filename,
    mime_type: mime_type || "application/octet-stream",
    extension,
    content_text: text,
    content_base64: buffer.toString("base64"),
    size_bytes: buffer.length,
    version: 1,
  }).select("id,name,mime_type,extension,size_bytes,version,agent_id,created_at,updated_at").single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ file: data });
});

router.get("/:id", async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("agent_files")
    .select("*")
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)
    .single();

  if (error || !data) return res.status(404).json({ error: error?.message || "File not found" });

  const buffer = Buffer.from(data.content_base64 || "", "base64");
  res.setHeader("Content-Type", data.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${safeName(data.name).replace(/"/g, "")}"`);
  res.send(buffer);
});

router.patch("/:id", async (req, res) => {
  const { content, name } = req.body || {};
  if (typeof content !== "string") return res.status(400).json({ error: "content is required" });

  const { data: current, error: readError } = await supabaseAdmin
    .from("agent_files")
    .select("*")
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)
    .single();

  if (readError || !current) return res.status(404).json({ error: readError?.message || "File not found" });

  if (!SUPPORTED_EDIT_EXTENSIONS.has(current.extension)) {
    return res.status(400).json({
      error: "Direct editing is currently supported for text, Markdown, JSON, CSV and HTML files. Ask the agent to regenerate an Office/PDF file instead.",
    });
  }

  const filename = safeName(name || current.name);
  const buffer = Buffer.from(content, "utf8");
  const { data, error } = await supabaseAdmin
    .from("agent_files")
    .update({
      name: filename,
      content_text: content,
      content_base64: buffer.toString("base64"),
      size_bytes: buffer.length,
      version: (current.version || 1) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", current.id)
    .eq("user_id", req.user.id)
    .select("id,name,mime_type,extension,size_bytes,version,agent_id,created_at,updated_at")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ file: data });
});

export default router;
