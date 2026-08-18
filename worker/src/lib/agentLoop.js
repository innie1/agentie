import { supabaseAdmin } from "../supabaseClient.js";
import { classifyIntent, fastReply, reasoningCall } from "./openrouter.js";
import { runPluginAction, IRREVERSIBLE_ACTIONS } from "./pluginRunner.js";

const MAX_STEPS = 8;
const BUILT_IN_TOOLS = ["files", "last30days"];

async function matchRoutineTrigger(agentId, instruction) {
  if (!instruction || !agentId) return null;
  const cleanInst = instruction.toLowerCase().trim();
  const { data: routines } = await supabaseAdmin.from("routines").select("*").eq("agent_id", agentId).eq("status", "active");
  for (const routine of routines || []) {
    if (cleanInst === routine.name.toLowerCase() || cleanInst.includes(routine.name.toLowerCase())) return routine;
    if (Array.isArray(routine.trigger_pattern)) {
      for (const pattern of routine.trigger_pattern) {
        const cleanPattern = pattern.toLowerCase().trim();
        if (cleanInst.includes(cleanPattern) || cleanPattern.includes(cleanInst)) return routine;
      }
    }
  }
  return null;
}

function adaptStepParams(step, context = {}) {
  const params = { ...step.params };
  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];
  for (const key of Object.keys(params)) {
    if (typeof params[key] === "string") {
      params[key] = params[key].replace(/\{\{today_date\}\}/g, todayStr).replace(/\{\{current_time\}\}/g, now.toLocaleTimeString()).replace(/\{\{today_summary\}\}/g, context.summary || `Summary for ${todayStr}`);
    }
  }
  return params;
}

async function recordRoutineRun(routineId, status) {
  const updates = { last_run_at: new Date().toISOString(), last_run_status: status, updated_at: new Date().toISOString() };
  const { data: routine } = await supabaseAdmin.from("routines").update(updates).eq("id", routineId).select().single();
  if (status === "success" && routine) await supabaseAdmin.from("routines").update({ success_count: (routine.success_count || 0) + 1 }).eq("id", routineId);
}

async function replayRoutine({ routine, agent, task }) {
  const steps = routine.steps || [];
  if (!steps.length) return false;
  for (const step of steps) {
    const isIrreversible = IRREVERSIBLE_ACTIONS.has(step.action) && !agent.auto_approved_actions.includes(step.action);
    const params = adaptStepParams(step);
    if (isIrreversible) {
      await supabaseAdmin.from("tasks").update({ status: "needs_approval", result_type: "irreversible_pending", result_payload: { action: step.action, plugin_id: step.plugin_id, params, description: `${agent.name} wants to run \"${routine.name}\" step: ${step.action} on ${step.plugin_id}`, routine_id: routine.id }, updated_at: new Date().toISOString() }).eq("id", task.id);
      return true;
    }
    const result = await runPluginAction({ userId: task.user_id, agentId: agent.id, taskId: task.id, pluginId: step.plugin_id, action: step.action, params });
    if (!result.ok) {
      await supabaseAdmin.from("tasks").update({ status: "failed", result_type: "failure", result_payload: { error: result.error, action: step.action, routine_id: routine.id }, updated_at: new Date().toISOString() }).eq("id", task.id);
      await recordRoutineRun(routine.id, "failed");
      return true;
    }
  }
  await supabaseAdmin.from("tasks").update({ status: "done", result_type: "task_complete", result_payload: { text: `Completed routine \"${routine.name}\" (${steps.length} step${steps.length > 1 ? "s" : ""}).`, routine_id: routine.id }, updated_at: new Date().toISOString() }).eq("id", task.id);
  await recordRoutineRun(routine.id, "success");
  return true;
}

export async function runTask(taskId) {
  const { data: task, error: taskErr } = await supabaseAdmin.from("tasks").select("*").eq("id", taskId).single();
  if (taskErr || !task) { console.error(`[agentLoop] task ${taskId} not found`, taskErr?.message); return; }
  const { data: agent, error: agentErr } = await supabaseAdmin.from("agents").select("*").eq("id", task.agent_id).single();
  if (agentErr || !agent) { await failTask(taskId, "Agent not found"); return; }
  if (!["pending"].includes(task.status)) { console.log(`[agentLoop] skipping ${taskId}, status is already '${task.status}'`); return; }
  await supabaseAdmin.from("tasks").update({ status: "in_progress", updated_at: new Date().toISOString() }).eq("id", taskId);

  const isResume = !!(task.result_payload && task.result_payload.paused_state);
  if (!isResume) {
    const routine = await matchRoutineTrigger(agent.id, task.instruction);
    if (routine) { const handled = await replayRoutine({ routine, agent, task }); if (handled) return; }
  }

  if (!isResume) {
    const cleanInst = (task.instruction || "").toLowerCase().trim();
    const timeKeywords = ["what time is it", "what is the time", "what time", "tell me the time", "current time", "time now", "what's the time", "what is the date", "what's the date", "what's today's date", "today's date", "current date", "what day is it", "what date is it", "show time", "live time", "date and time", "time and date", "clock"];
    const isExactClock = cleanInst === "time" || cleanInst === "date" || cleanInst === "clock" || cleanInst.startsWith("time?") || cleanInst.startsWith("date?");
    if (isExactClock || timeKeywords.some(k => cleanInst.includes(k))) {
      const now = new Date();
      await completeTask(taskId, { result_type: "live_time_card", result_payload: { title: "Live Local Time & Date", time: now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }), date: now.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" }), timezone: "Local Time", iso: now.toISOString() } });
      return;
    }
    const weatherKeywords = ["weather", "forecast", "temperature", "is it raining", "how hot is it", "rain today", "weather today", "what is the weather", "what's the weather", "climate", "temp today", "show weather"];
    if (weatherKeywords.some(k => cleanInst.includes(k))) {
      let loc = "Local Area"; const matchIn = cleanInst.match(/(?:in|for|at)\s+([A-Za-z\s]+)(?:\?|$)/i); if (matchIn && matchIn[1]) loc = matchIn[1].trim();
      await completeTask(taskId, { result_type: "weather_card", result_payload: { location: loc } }); return;
    }
    const gameKeywords = ["play a game", "play game", "games", "game", "tic tac toe", "tictactoe", "trivia", "quiz", "rock paper scissors", "rps", "mini game", "arcade", "play with me", "let's play", "play something"];
    if (gameKeywords.some(k => cleanInst.includes(k)) || cleanInst === "play") {
      let gameType = "hub"; if (cleanInst.includes("tic tac toe") || cleanInst.includes("tictactoe")) gameType = "tictactoe"; else if (cleanInst.includes("trivia") || cleanInst.includes("quiz")) gameType = "trivia"; else if (cleanInst.includes("rps") || cleanInst.includes("rock paper") || cleanInst.includes("scissors")) gameType = "rps";
      await completeTask(taskId, { result_type: "game_card", result_payload: { game_type: gameType, game_id: "game_" + Math.random().toString(36).substr(2, 8) } }); return;
    }
  }

  if (!isResume) {
    const intent = await classifyIntent({ instruction: task.instruction, userId: task.user_id, agentId: agent.id, taskId });
    if (intent === "SIMPLE") { const reply = await fastReply({ instruction: task.instruction, agentName: agent.name, userId: task.user_id, agentId: agent.id, taskId }); await completeTask(taskId, { result_type: "fact", result_payload: { text: reply } }); return; }
  }

  const { data: memories } = await supabaseAdmin.from("agent_memory").select("key, value").eq("agent_id", agent.id);
  const memoryBlock = (memories || []).map((m) => `- ${m.key}: ${m.value}`).join("\n") || "(no saved facts yet)";
  const skillsBlock = await buildSkillsBlock(agent.id);
  const systemPrompt = buildSystemPrompt(agent, memoryBlock, skillsBlock);

  const persistedConversation = Array.isArray(task.context?.conversation) ? task.context.conversation : [];
  let conversation = task.result_payload?.paused_state?.conversation || [...persistedConversation, { role: "user", content: task.instruction }];
  let stepCount = task.result_payload?.paused_state?.step_count || 0;

  while (stepCount < MAX_STEPS) {
    stepCount += 1;
    let modelOutput;
    try { modelOutput = await reasoningCall({ systemPrompt, conversation, userId: task.user_id, agentId: agent.id, taskId }); }
    catch (err) { await failTask(taskId, `Model call failed: ${err.response?.data?.error?.message || err.message}`); return; }
    const step = parseStep(modelOutput);
    if (!step) { await completeTask(taskId, { result_type: "task_complete", result_payload: { text: modelOutput } }); return; }
    conversation.push({ role: "assistant", content: modelOutput });

    if (step.type === "final_answer") { await completeTask(taskId, { result_type: step.result_type || "task_complete", result_payload: { text: step.text, ...step.extra } }); await extractMemory({ agent, task, conversation }); return; }
    if (step.type === "question") {
      await supabaseAdmin.from("tasks").update({ status: "needs_approval", result_type: "missing_info", result_payload: { question: step.question, options: step.options || null, paused_state: { conversation, step_count: stepCount } }, updated_at: new Date().toISOString() }).eq("id", taskId); return;
    }
    if (step.type === "handoff") { await handleHandoff({ fromAgent: agent, task, step }); return; }
    if (step.type === "action") {
      const isIrreversible = IRREVERSIBLE_ACTIONS.has(step.action) && !agent.auto_approved_actions.includes(step.action);
      if (isIrreversible) {
        await supabaseAdmin.from("tasks").update({ status: "needs_approval", result_type: "irreversible_pending", result_payload: { action: step.action, plugin_id: step.plugin_id, params: step.params, description: step.description || `${agent.name} wants to run ${step.action} on ${step.plugin_id}`, paused_state: { conversation, step_count: stepCount } }, updated_at: new Date().toISOString() }).eq("id", taskId); return;
      }
      const result = await runPluginAction({ userId: task.user_id, agentId: agent.id, taskId, pluginId: step.plugin_id, action: step.action, params: step.params });
      conversation.push({ role: "user", content: `[Tool result for ${step.plugin_id}.${step.action}]: ${JSON.stringify(result).slice(0, 2000)}` });
      if (!result.ok) { await supabaseAdmin.from("tasks").update({ status: "failed", result_type: "failure", result_payload: { error: result.error, action: step.action }, updated_at: new Date().toISOString() }).eq("id", taskId); return; }
      continue;
    }
    await failTask(taskId, `Model returned an unrecognized step type: ${step.type}`); return;
  }
  await failTask(taskId, `Task exceeded ${MAX_STEPS} steps without reaching a final answer.`);
}

async function buildSkillsBlock(agentId) {
  const { data: coreSkills } = await supabaseAdmin.from("skills").select("name, instructions").eq("tier", "core").eq("status", "active");
  const { data: enabledRows } = await supabaseAdmin.from("agent_skills").select("skill_id").eq("agent_id", agentId);
  const enabledIds = (enabledRows || []).map((r) => r.skill_id);
  let librarySkills = [];
  if (enabledIds.length) { const { data } = await supabaseAdmin.from("skills").select("name, instructions").in("id", enabledIds).eq("status", "active"); librarySkills = data || []; }
  const format = (list) => list.map((s) => `• ${s.name}: ${s.instructions}`).join("\n");
  return ["CORE SKILLS (always active):", format(coreSkills || []), librarySkills.length ? "\nINSTALLED SKILLS (enabled for this agent):" : "", librarySkills.length ? format(librarySkills) : ""].filter(Boolean).join("\n");
}

function buildSystemPrompt(agent, memoryBlock, skillsBlock) {
  const connectedPlugins = [...new Set([...(Array.isArray(agent.allowed_plugins) ? agent.allowed_plugins : []), ...BUILT_IN_TOOLS])];
  return `${agent.system_prompt}\n\n${skillsBlock}\n\nYou can use these plugins/tools: ${connectedPlugins.join(", ") || "(none connected)"}\n\nBUILT-IN FILE TOOL: You have a real built-in \"files\" tool. Use it whenever the user asks you to create, read, list, view, or edit files. Actions are: create_file, read_file, list_files, edit_file. For create_file/edit_file use params {name, content}; read_file uses {fileId} or {name}; list_files needs no params. Supported generated formats include txt, md, json, csv, html, docx, xlsx, and pdf. The file tool actually writes to Agentie's file store; never claim a file was created unless the tool result is successful. After a successful file action, use a concise final answer that tells the user what happened and includes the returned file metadata when useful.\n\nLAST30DAYS TOOL: You also have a real built-in \"last30days\" research tool. Use action \"research\" with params {topic} when current last-30-days research is needed.\n\nSkills determine HOW you approach a task (how you plan, review, communicate). Plugins/tools determine WHAT capabilities you have. Apply skill guidance regardless of which tool is used.\n\nKnown facts about how this user works:\n${memoryBlock}\n\nRespond with ONLY a single JSON object, no other text, matching one of these shapes:\n{\"type\":\"action\",\"plugin_id\":\"files\",\"action\":\"create_file\",\"params\":{\"name\":\"example.pdf\",\"content\":\"...\"},\"description\":\"Create the requested file\"}\n{\"type\":\"action\",\"plugin_id\":\"gmail\",\"action\":\"send_email\",\"params\":{...},\"description\":\"short human description of what this does\"}\n{\"type\":\"question\",\"question\":\"...\", \"options\":[\"A\",\"B\"]}\n{\"type\":\"handoff\",\"to_agent_name\":\"...\", \"note\":\"context summary for the receiving agent\"}\n{\"type\":\"final_answer\",\"text\":\"...\", \"result_type\":\"task_complete\"}\n\nRules:\n- Never invent an external plugin action outside the connected plugins. Built-in files and last30days are always available.\n- Any send/delete/pay/publish action must go through action; the system will pause for approval automatically.\n- File creation/editing is a real action. Do not merely describe how to create the file.\n- If you are missing information needed to proceed, use question instead of guessing.\n- Once the task is genuinely done, respond with final_answer.`;
}

function parseStep(text) { try { const jsonMatch = text.match(/\{[\s\S]*\}/); if (!jsonMatch) return null; return JSON.parse(jsonMatch[0]); } catch { return null; } }
async function completeTask(taskId, { result_type, result_payload }) { await supabaseAdmin.from("tasks").update({ status: "done", result_type, result_payload, updated_at: new Date().toISOString() }).eq("id", taskId); }
async function failTask(taskId, message) { await supabaseAdmin.from("tasks").update({ status: "failed", result_type: "failure", result_payload: { error: message }, updated_at: new Date().toISOString() }).eq("id", taskId); }

async function handleHandoff({ fromAgent, task, step }) {
  const { data: toAgent } = await supabaseAdmin.from("agents").select("*").eq("user_id", task.user_id).ilike("name", step.to_agent_name).single();
  if (!toAgent) { await failTask(task.id, `Tried to hand off to \"${step.to_agent_name}\" but no such agent exists.`); return; }
  const { data: newTask } = await supabaseAdmin.from("tasks").insert({ user_id: task.user_id, agent_id: toAgent.id, instruction: step.note || task.instruction, status: "pending", source: "handoff", context: { conversation: task.context?.conversation || [] } }).select().single();
  if (!newTask) { await failTask(task.id, "Failed to create handoff task."); return; }
  await supabaseAdmin.from("task_handoffs").insert({ from_agent_id: fromAgent.id, to_agent_id: toAgent.id, task_id: newTask.id, note: step.note, context_summary: step.note || task.instruction });
  await supabaseAdmin.from("tasks").update({ status: "done", result_type: "delegated", result_payload: { handed_off_to: toAgent.name, note: step.note }, updated_at: new Date().toISOString() }).eq("id", task.id);
}

async function extractMemory({ agent, task, conversation }) {
  try {
    const { fastReply: extract } = await import("./openrouter.js");
    const transcript = conversation.map((m) => `${m.role}: ${m.content}`).join("\n").slice(0, 3000);
    const raw = await extract({ instruction: `From this finished task, extract ONE short fact worth remembering for next time, in the form \"key: value\". If nothing is worth remembering, respond with exactly \"NONE\".\n\n${transcript}`, agentName: agent.name, userId: task.user_id, agentId: agent.id, taskId: task.id });
    if (raw && !raw.trim().toUpperCase().startsWith("NONE") && raw.includes(":")) {
      const [key, ...rest] = raw.split(":");
      await supabaseAdmin.from("agent_memory").upsert({ agent_id: agent.id, key: key.trim().slice(0, 100), value: rest.join(":").trim().slice(0, 500) }, { onConflict: "agent_id,key" });
    }
  } catch (err) { console.error("[agentLoop] memory extraction failed (non-fatal):", err.message); }
}
