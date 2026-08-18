import { supabaseAdmin } from "../supabaseClient.js";
import { Document, Packer, Paragraph } from "docx";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const MIME = {
  txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv", html: "text/html",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

function extOf(name = "file.txt") { const m = name.toLowerCase().match(/\.([a-z0-9]+)$/); return m?.[1] || "txt"; }
function safeName(name) { return String(name || "file.txt").replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180); }

async function encodeFile(name, content) {
  const ext = extOf(name);
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  if (["txt", "md", "json", "csv", "html"].includes(ext)) return { buffer: Buffer.from(text, "utf8"), text };
  if (ext === "docx") {
    const doc = new Document({ sections: [{ children: text.split(/\r?\n/).map((line) => new Paragraph(line)) }] });
    return { buffer: Buffer.from(await Packer.toBuffer(doc)), text };
  }
  if (ext === "xlsx") {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Sheet 1");
    for (const row of text.split(/\r?\n/)) ws.addRow(row.split(","));
    return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), text };
  }
  if (ext === "pdf") {
    const pdf = await PDFDocument.create(); const page = pdf.addPage(); const font = await pdf.embedFont(StandardFonts.Helvetica);
    const lines = text.split(/\r?\n/); let y = page.getHeight() - 48;
    for (const line of lines) { if (y < 48) { y = page.getHeight() - 48; pdf.addPage(); } const p = pdf.getPages()[pdf.getPageCount() - 1]; p.drawText(line.slice(0, 110), { x: 40, y, size: 11, font, color: rgb(0, 0, 0) }); y -= 16; }
    return { buffer: Buffer.from(await pdf.save()), text };
  }
  throw new Error(`Unsupported file type .${ext}`);
}

export async function createFile({ userId, agentId, name, content }) {
  const filename = safeName(name); const { buffer, text } = await encodeFile(filename, content); const ext = extOf(filename);
  const { data, error } = await supabaseAdmin.from("agent_files").insert({
    user_id: userId, agent_id: agentId, name: filename, mime_type: MIME[ext] || "application/octet-stream", extension: ext,
    content_text: text, content_base64: buffer.toString("base64"), size_bytes: buffer.length,
  }).select("id,name,mime_type,extension,size_bytes,version,created_at,updated_at").single();
  if (error) throw error; return data;
}

export async function readFile({ userId, fileId, name }) {
  let q = supabaseAdmin.from("agent_files").select("*").eq("user_id", userId);
  q = fileId ? q.eq("id", fileId) : q.eq("name", safeName(name));
  const { data, error } = await q.single(); if (error || !data) throw new Error(error?.message || "File not found");
  return { ...data, content: data.content_text, download_base64: data.content_base64 };
}

export async function listFiles({ userId, agentId }) {
  let q = supabaseAdmin.from("agent_files").select("id,name,mime_type,extension,size_bytes,version,created_at,updated_at").eq("user_id", userId).order("updated_at", { ascending: false });
  if (agentId) q = q.eq("agent_id", agentId); const { data, error } = await q; if (error) throw error; return data || [];
}

export async function editFile({ userId, fileId, name, content }) {
  const current = await readFile({ userId, fileId, name });
  const filename = safeName(name || current.name); const { buffer, text } = await encodeFile(filename, content); const ext = extOf(filename);
  const { data, error } = await supabaseAdmin.from("agent_files").update({
    name: filename, mime_type: MIME[ext] || "application/octet-stream", extension: ext, content_text: text,
    content_base64: buffer.toString("base64"), size_bytes: buffer.length, version: (current.version || 1) + 1, updated_at: new Date().toISOString(),
  }).eq("id", current.id).eq("user_id", userId).select("id,name,mime_type,extension,size_bytes,version,created_at,updated_at").single();
  if (error) throw error; return data;
}

export async function runFileTool({ userId, agentId, action, params = {} }) {
  if (action === "create_file") return { ok: true, data: await createFile({ userId, agentId, ...params }) };
  if (action === "read_file") return { ok: true, data: await readFile({ userId, ...params }) };
  if (action === "list_files") return { ok: true, data: await listFiles({ userId, agentId }) };
  if (action === "edit_file") return { ok: true, data: await editFile({ userId, ...params }) };
  return { ok: false, error: `Unknown file action: ${action}` };
}
