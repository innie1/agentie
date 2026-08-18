import express from "express";
import { supabaseAdmin } from "../supabaseClient.js";
import { encodeGeneratedFile, FILE_MIME_TYPES, fileExtension } from "../lib/fileEncoding.js";

const router = express.Router();

function safeName(name = "file.txt") {
  return String(name).replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180) || "file.txt";
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
  let extension = fileExtension(filename);
  let buffer;
  let text;
  try {
    if (typeof content_base64 === "string") {
      buffer = Buffer.from(content_base64, "base64");
      text = typeof content === "string" ? content : null;
    } else {
      ({ extension, buffer, text } = await encodeGeneratedFile(filename, content));
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

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
    mime_type: mime_type || FILE_MIME_TYPES[extension] || "application/octet-stream",
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
  res.setHeader("Content-Disposition", `attachment; filename="${safeName(data.name).replace(/"/g, "")}"`);
  res.send(buffer);
});

// Safe in-chat preview. Binary bytes never enter the DOM; the retained source
// text is used for docx/xlsx/pdf and editable text formats alike.
router.get("/:id/preview", async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("agent_files")
    .select("id,name,mime_type,extension,size_bytes,version,content_text,updated_at")
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)
    .single();
  if (error || !data) return res.status(404).json({ error: error?.message || "File not found" });
  res.json({ file: { ...data, content_text: data.content_text || "Preview is unavailable for this file." } });
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

  const filename = safeName(name || current.name);
  let encoded;
  try {
    encoded = await encodeGeneratedFile(filename, content);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const { data, error } = await supabaseAdmin
    .from("agent_files")
    .update({
      name: filename,
      mime_type: FILE_MIME_TYPES[encoded.extension] || "application/octet-stream",
      extension: encoded.extension,
      content_text: encoded.text,
      content_base64: encoded.buffer.toString("base64"),
      size_bytes: encoded.buffer.length,
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
