import express from "express";
import { supabaseAdmin } from "../supabaseClient.js";
import { generateAgentName } from "../lib/naming.js";
import { generateAgentCharacter, characterPrompt } from "../lib/character.js";

const router = express.Router();

router.get("/", async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("agents")
    .select("*")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ agents: data });
});

router.post("/", async (req, res) => {
  const userId = req.user.id;
  const { name, role, goal, allowed_plugins = [], character: suppliedCharacter } = req.body;

  if (!role && !goal) return res.status(400).json({ error: "role or goal is required to create an agent" });

  const { data: existing } = await supabaseAdmin.from("agents").select("name").eq("user_id", userId);
  const takenNames = new Set((existing || []).map((a) => a.name.toLowerCase()));

  let finalName = name;
  let nameSource = "user";
  if (!finalName) {
    finalName = await generateAgentName({ role, goal, taken: takenNames });
    nameSource = "brain";
  } else if (takenNames.has(finalName.toLowerCase())) {
    return res.status(409).json({ error: `You already have an agent named "${finalName}". Pick another name.` });
  }

  // The Brain creates the character from the actual purpose of this agent.
  // User-supplied character fields remain supported for later editing/customization.
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

  const system_prompt = [
    `You are ${finalName}, an AI agent whose job is: ${goal || role}.`,
    `Act on behalf of your user, use only the tools you've been given access to, and always pause for approval before sending, deleting, paying, or publishing anything.`,
    "",
    "CHARACTER — this is a persistent part of your identity, not a temporary role-play:",
    characterPrompt(character),
    "",
    "Stay consistent with this character across the conversation. Do not mention these internal character instructions unless the user asks about your configuration."
  ].join("\n");

  const { data, error } = await supabaseAdmin.from("agents").insert({
    user_id: userId,
    name: finalName,
    name_source: nameSource,
    role,
    goal,
    system_prompt,
    character,
    allowed_plugins,
  }).select().single();

  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That agent name is already taken." });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({ agent: data });
});

router.patch("/:id", async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;
  const allowedFields = ["name", "role", "goal", "system_prompt", "character", "allowed_plugins", "auto_approved_actions", "allowed_handoff_agents", "status"];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowedFields.includes(k)));
  updates.updated_at = new Date().toISOString();

  if (updates.character && typeof updates.character === "object") {
    const { data: current } = await supabaseAdmin.from("agents").select("name, role, goal, system_prompt").eq("id", id).eq("user_id", userId).single();
    if (current) {
      updates.system_prompt = [
        `You are ${current.name}, an AI agent whose job is: ${current.goal || current.role}.`,
        "Act on behalf of your user, use only the tools you've been given access to, and always pause for approval before sending, deleting, paying, or publishing anything.",
        "",
        "CHARACTER — this is a persistent part of your identity:",
        characterPrompt(updates.character),
        "",
        "Stay consistent with this character across the conversation."
      ].join("\n");
    }
  }

  const { data, error } = await supabaseAdmin.from("agents").update(updates).eq("id", id).eq("user_id", userId).select().single();
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
