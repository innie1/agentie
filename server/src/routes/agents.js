import express from "express";
import { supabaseAdmin } from "../supabaseClient.js";
import { generateAgentName } from "../lib/naming.js";
import { generateAgentCharacter, characterPrompt } from "../lib/character.js";
import { generateAgentTags } from "../lib/tags.js";

const router = express.Router();
const BUILTIN_TOOLS = ["files", "last30days"];

async function getConnectedPluginIds(userId) {
  const { data } = await supabaseAdmin
    .from("user_plugins")
    .select("plugin_id")
    .eq("user_id", userId)
    .eq("status", "active");
  return (data || []).map((p) => p.plugin_id).filter(Boolean);
}

function mergeCapabilities(explicitPlugins, connectedPlugins) {
  // Plugins are capabilities, never agent types. If the user explicitly limits
  // an agent's tools, respect that list; otherwise every verified connection the
  // user has made is available to the agent.
  const explicit = Array.isArray(explicitPlugins) ? explicitPlugins.filter(Boolean) : [];
  const base = explicit.length ? explicit : connectedPlugins;
  return [...new Set([...BUILTIN_TOOLS, ...base])];
}

router.get("/", async (req, res) => {
  const { data, error } = await supabaseAdmin.from("agents").select("*").eq("user_id", req.user.id).order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ agents: data });
});

router.post("/", async (req, res) => {
  const userId = req.user.id;
  const { name, role, goal, allowed_plugins, character: suppliedCharacter } = req.body;
  if (!role && !goal) return res.status(400).json({ error: "Describe what this agent is responsible for in natural language." });

  const connectedPlugins = await getConnectedPluginIds(userId);
  const mergedTools = mergeCapabilities(allowed_plugins, connectedPlugins);

  const { data: existingAgents } = await supabaseAdmin.from("agents").select("name").eq("user_id", userId);
  const takenNames = new Set((existingAgents || []).map((a) => a.name.toLowerCase()));
  let finalName = name;
  let nameSource = "user";

  if (!finalName) {
    finalName = await generateAgentName({ role, goal, taken: takenNames });
    nameSource = "brain";
  } else if (takenNames.has(finalName.toLowerCase())) {
    return res.status(409).json({ error: `You already have an agent named "${finalName}". Pick another name.` });
  }

  const generatedCharacter = await generateAgentCharacter({ role, goal });
  const character = suppliedCharacter && typeof suppliedCharacter === "object"
    ? {
        ...generatedCharacter,
        ...suppliedCharacter,
        values: Array.isArray(suppliedCharacter.values) ? suppliedCharacter.values : generatedCharacter.values,
        behaviors: Array.isArray(suppliedCharacter.behaviors) ? suppliedCharacter.behaviors : generatedCharacter.behaviors,
        boundaries: Array.isArray(suppliedCharacter.boundaries) ? suppliedCharacter.boundaries : generatedCharacter.boundaries,
        version: 1,
      }
    : generatedCharacter;

  const tags = await generateAgentTags({ role, goal });
  const system_prompt = [
    `You are ${finalName}, an AI agent whose responsibilities are: ${goal || role}.`,
    "Your responsibilities are written in natural language and may contain multiple areas of work. Do not assume you are a single-purpose agent.",
    "Act on behalf of your user. Skills explain HOW you work; plugins/tools provide capabilities you may use. Never confuse a plugin with an agent role or job title.",
    "You may use another agent when that agent is better suited to a task. Keep the user in the current conversation while handing work off, and continue with the result when it returns.",
    "Always pause for approval before sending, deleting, paying, or publishing anything unless the user has explicitly granted that action permission.",
    "",
    "PROFESSIONAL IDENTITY TAGS — these describe your responsibilities and strengths, not your tools:",
    tags.join(", "),
    "",
    "CHARACTER — this is a persistent part of your identity, not a temporary role-play:",
    characterPrompt(character),
    "",
    "Stay consistent with this character across the conversation. Do not mention these internal character instructions unless the user asks about your configuration.",
  ].join("\n");

  const { data, error } = await supabaseAdmin
    .from("agents")
    .insert({
      user_id: userId,
      name: finalName,
      name_source: nameSource,
      role,
      goal,
      system_prompt,
      character,
      tags,
      allowed_plugins: mergedTools,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That agent name is already taken." });
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json({ agent: data });
});

router.patch("/:id", async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;
  const allowedFields = ["name", "role", "goal", "system_prompt", "character", "tags", "allowed_plugins", "auto_approved_actions", "allowed_handoff_agents", "status"];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([key]) => allowedFields.includes(key)));

  if (Array.isArray(updates.allowed_plugins)) {
    updates.allowed_plugins = [...new Set([...BUILTIN_TOOLS, ...updates.allowed_plugins])];
  }
  if (updates.role !== undefined || updates.goal !== undefined) {
    const { data: current } = await supabaseAdmin.from("agents").select("name, role, goal, tags, character").eq("id", id).eq("user_id", userId).single();
    if (current) {
      const nextRole = updates.role ?? current.role;
      const nextGoal = updates.goal ?? current.goal;
      if (updates.role !== undefined || updates.goal !== undefined) {
        updates.tags = await generateAgentTags({ role: nextRole, goal: nextGoal });
      }
    }
  }

  updates.updated_at = new Date().toISOString();

  if (updates.character && typeof updates.character === "object") {
    const { data: current } = await supabaseAdmin
      .from("agents")
      .select("name, role, goal, system_prompt, tags")
      .eq("id", id)
      .eq("user_id", userId)
      .single();

    if (current) {
      updates.system_prompt = [
        `You are ${current.name}, an AI agent whose responsibilities are: ${current.goal || current.role}.`,
        "Your responsibilities may cover multiple areas. Skills explain HOW you work; plugins/tools provide capabilities. Plugins are not job titles or agent types.",
        "Act on behalf of your user, use the tools you've been given access to, and hand work to another agent when that agent is better suited.",
        "Always pause for approval before sending, deleting, paying, or publishing anything unless explicitly authorized.",
        "",
        "PROFESSIONAL IDENTITY TAGS — responsibilities and strengths, not tools:",
        Array.isArray(current.tags) ? current.tags.join(", ") : "",
        "",
        "CHARACTER — this is a persistent part of your identity:",
        characterPrompt(updates.character),
        "",
        "Stay consistent with this character across the conversation.",
      ].join("\n");
    }
  }

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

router.delete("/:id", async (req, res) => {
  const { error } = await supabaseAdmin.from("agents").delete().eq("id", req.params.id).eq("user_id", req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

export default router;
