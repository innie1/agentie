import { supabaseAdmin } from "../supabaseClient.js";
import { classifyIntent, conversationReply, reasoningCall } from "./openrouter.js";
import { runPluginAction } from "./pluginRunner.js";
import { recordActivity } from "./activity.js";
import { BASELINE_EXECUTION_SKILLS, getRoleSkills } from "./roleSkills.js";
import { normalizePluginId, toolsForAgent, validateToolCall } from "./toolRegistry.js";
import { actionHash, appendRunStep, createApproval, finishRun, startRun } from "./runStore.js";
import crypto from "node:crypto";
import { extractAndSaveMemories, retrieveMemories } from "./memoryService.js";

const BUILT_IN_TOOLS = ["files", "last30days"];
const activeRuns = new Map();

function isAutoApproved(agent, step, risk) {
  if (risk !== "sensitive") return false;
  const configured = Array.isArray(agent?.auto_approved_actions) ? agent.auto_approved_actions : [];
  return configured.includes(step.action) || configured.includes(`${normalizePluginId(step.plugin_id)}.${step.action}`);
}

function canHandoffTo(agent, targetId) {
  const allowed = Array.isArray(agent?.allowed_handoff_agents) ? agent.allowed_handoff_agents : [];
  return allowed.length === 0 || allowed.includes(targetId);
}

function isExplicitExecutionRequest(instruction) {
  const text = String(instruction || "").trim();
  return /^(create|make|generate|write|build|edit|update|send|schedule|book|publish|delete|research|download|export)\b/i.test(text)
    || /\b(create|make|generate|write|export)\b[\s\S]{0,80}\b(file|document|docx|pdf|spreadsheet|xlsx|csv|presentation|report)\b/i.test(text);
}

function validateActionStep(step, allowedPlugins) {
  const validation = validateToolCall(step, allowedPlugins);
  return validation.ok ? null : validation.error;
}

function normalizePlan(step) {
  if (!step || step.type !== "plan" || !Array.isArray(step.steps)) return null;
  const steps = step.steps
    .map((item, index) => ({ order: index + 1, title: String(item?.title || item || "").trim().slice(0, 140), status: "pending" }))
    .filter((item) => item.title)
    .slice(0, 6);
  return steps.length ? { goal: String(step.goal || "").trim().slice(0, 240), steps } : null;
}

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

async function recordRoutineRun(routineId, status, taskId = null) {
  const updates = { last_run_at: new Date().toISOString(), last_run_status: status, updated_at: new Date().toISOString() };
  const { data: routine } = await supabaseAdmin.from("routines").update(updates).eq("id", routineId).select().single();
  if (status === "success" && routine) await supabaseAdmin.from("routines").update({ success_count: (routine.success_count || 0) + 1 }).eq("id", routineId);
  if (taskId) {
    await supabaseAdmin.from("routine_runs").update({
      status: status === "success" ? "succeeded" : "failed",
      result: { status },
      finished_at: new Date().toISOString(),
    }).eq("routine_id", routineId).eq("task_id", taskId);
  }
}

async function replayRoutine({ routine, agent, task, resumeState = null }) {
  const steps = routine.steps || [];
  const fallbackInstruction = `Execute routine "${routine.name}": ${routine.parameters?.instruction || routine.description || routine.name}`;
  if (!steps.length) { task.instruction = fallbackInstruction; return false; }
  const allowedPlugins = [...new Set([...(agent.allowed_plugins || []).map(normalizePluginId), ...BUILT_IN_TOOLS])];
  let startIndex = Math.max(0, Number(resumeState?.routine_step_index || 0));

  if (resumeState?.denied_action) {
    await recordRoutineRun(routine.id, "failed", task.id);
    await completeTask(task.id, { result_type: "task_complete", result_payload: { text: `Stopped routine "${routine.name}" because its requested action was declined.`, routine_id: routine.id } });
    return true;
  }

  if (resumeState?.approved_action) {
    const approved = resumeState.approved_action;
    const validation = validateToolCall(approved, allowedPlugins);
    if (!validation.ok) { await failTask(task.id, `Approved routine action failed policy validation: ${validation.error}`); return true; }
    if (resumeState.approved_action_hash && resumeState.approved_action_hash !== actionHash(approved)) { await failTask(task.id, "Approved routine action changed after approval and was blocked."); return true; }
    const result = await runPluginAction({ userId: task.user_id, agentId: agent.id, taskId: task.id, pluginId: approved.plugin_id, action: approved.action, params: approved.params });
    if (!result.ok) { await recordRoutineRun(routine.id, "failed", task.id); await failTask(task.id, result.error); return true; }
    startIndex += 1;
  }

  for (let index = startIndex; index < steps.length; index += 1) {
    const step = { ...steps[index] };
    step.plugin_id = normalizePluginId(step.plugin_id);
    const validation = validateToolCall({ ...step, params: step.params || {} }, allowedPlugins);
    if (!validation.ok) {
      task.instruction = fallbackInstruction;
      await recordActivity({ agentId: agent.id, taskId: task.id, type: "routine_adapted", summary: `Routine "${routine.name}" needs brain-guided execution`, detail: { validation_error: validation.error }, severity: "warning" });
      return false;
    }
    const risk = validation.action.risk;
    const isIrreversible = risk !== "safe" && !isAutoApproved(agent, step, risk);
    const params = adaptStepParams(step);
    if (isIrreversible) {
      const requestedAction = { plugin_id: step.plugin_id, action: step.action, params, description: `Run \"${routine.name}\" step` };
      const approval = await createApproval({ userId: task.user_id, taskId: task.id, runId: activeRuns.get(task.id), stepId: null, action: requestedAction, risk, reason: requestedAction.description });
      await finishRun(activeRuns.get(task.id), "waiting_approval"); activeRuns.delete(task.id);
      await supabaseAdmin.from("tasks").update({ status: "needs_approval", result_type: "irreversible_pending", result_payload: { action: step.action, plugin_id: step.plugin_id, params, description: `${agent.name} wants to run \"${routine.name}\" step: ${step.action} on ${step.plugin_id}`, routine_id: routine.id, approval_id: approval?.id || null, action_hash: actionHash(requestedAction), risk_level: risk, paused_state: { routine_id: routine.id, routine_step_index: index } }, lease_token: null, lease_expires_at: null, updated_at: new Date().toISOString() }).eq("id", task.id);
      await supabaseAdmin.from("routine_runs").update({ status: "waiting_approval", started_at: new Date().toISOString() }).eq("routine_id", routine.id).eq("task_id", task.id);
      await recordActivity({ agentId: agent.id, taskId: task.id, type: "approval_requested", summary: "Approval required for a routine step", detail: { plugin_id: step.plugin_id, action: step.action, routine_id: routine.id }, severity: "warning" });
      return true;
    }
    const result = await runPluginAction({ userId: task.user_id, agentId: agent.id, taskId: task.id, pluginId: step.plugin_id, action: step.action, params });
    if (!result.ok) {
      await recordRoutineRun(routine.id, "failed", task.id);
      await failTask(task.id, result.error);
      return true;
    }
  }
  await recordRoutineRun(routine.id, "success", task.id);
  await completeTask(task.id, { result_type: "task_complete", result_payload: { text: `Completed routine \"${routine.name}\" (${steps.length} step${steps.length > 1 ? "s" : ""}).`, routine_id: routine.id } });
  return true;
}

export async function runTask(taskId) {
  const { data: task, error: taskErr } = await supabaseAdmin.from("tasks").select("*").eq("id", taskId).single();
  if (taskErr || !task) { console.error(`[agentLoop] task ${taskId} not found`, taskErr?.message); return; }
  const { data: agent, error: agentErr } = await supabaseAdmin.from("agents").select("*").eq("id", task.agent_id).single();
  if (agentErr || !agent) { await failTask(taskId, "Agent not found"); return; }
  if (task.status !== "pending") { console.log(`[agentLoop] skipping ${taskId}, status is already '${task.status}'`); return; }
  // Claim the task atomically. Queue retries, webhook duplicates, and restart
  // recovery may all attempt to run the same task; only one worker may win.
  const leaseToken = crypto.randomUUID();
  const { data: claimed } = await supabaseAdmin.from("tasks")
    .update({ status: "in_progress", lease_token: leaseToken, lease_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(), attempt_count: Number(task.attempt_count || 0) + 1, updated_at: new Date().toISOString() })
    .eq("id", taskId).eq("status", "pending").select("id").maybeSingle();
  if (!claimed) { console.log(`[agentLoop] task ${taskId} was claimed by another worker`); return; }
  const run = await startRun(task, leaseToken);
  activeRuns.set(taskId, run?.id || null);
  await recordActivity({ agentId: agent.id, taskId, type: "task_started", summary: "Agent started work", detail: { instruction: String(task.instruction || "").slice(0, 280) } });

  const isResume = !!(task.result_payload && task.result_payload.paused_state);
  const pausedRoutineId = task.result_payload?.paused_state?.routine_id || task.result_payload?.routine_id;
  if (isResume && pausedRoutineId) {
    const { data: routine } = await supabaseAdmin.from("routines").select("*").eq("id", pausedRoutineId).eq("agent_id", agent.id).maybeSingle();
    if (routine) {
      const handled = await replayRoutine({ routine, agent, task, resumeState: task.result_payload.paused_state });
      if (handled) return;
    }
  } else if (!isResume) {
    const routine = await matchRoutineTrigger(agent.id, task.instruction);
    if (routine) { const handled = await replayRoutine({ routine, agent, task }); if (handled) return; }
  }

  // Route normal dialogue before any task-only shortcuts. A question about the
  // time or weather is still a conversation unless the user explicitly asks
  // the agent to carry out work.
  let initialIntent = null;
  if (!isResume) {
    initialIntent = isExplicitExecutionRequest(task.instruction) ? "TASK" : await classifyIntent({ instruction: task.instruction, userId: task.user_id, agentId: agent.id, taskId });
    if (initialIntent === "CONVERSATION") {
      const history = Array.isArray(task.context?.conversation) ? task.context.conversation : [];
      const reply = await conversationReply({ instruction: task.instruction, agent, history, userId: task.user_id, agentId: agent.id, taskId });
      await completeTask(taskId, { result_type: "conversation", result_payload: { text: reply } });
      await extractMemory({ agent, task, conversation: [...history, { role: "user", content: task.instruction }, { role: "assistant", content: reply }] });
      return;
    }
  }

  if (!isResume) {
    const cleanInst = (task.instruction || "").toLowerCase().trim();
    const timeKeywords = ["what time is it", "what is the time", "what time", "tell me time", "tell me the time", "show me the time", "give me the time", "current time", "time now", "what's the time", "what is the date", "what's the date", "what's today's date", "today's date", "current date", "what day is it", "what date is it", "show time", "live time", "date and time", "time and date", "clock"];
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

  const memories = await retrieveMemories(agent.id, task.instruction);
  const memoryBlock = memories.map((m) => `- ${m.key}: ${m.value}`).join("\n") || "(no relevant saved facts yet)";
  const skillsBlock = await buildSkillsBlock(agent.id);
  const { data: rosterRows } = await supabaseAdmin.from("agents").select("id,name,role,goal,status").eq("user_id", task.user_id).neq("id", agent.id).eq("status", "active");
  const roster = (rosterRows || []).filter(member => canHandoffTo(agent, member.id));
  const systemPrompt = buildSystemPrompt(agent, memoryBlock, skillsBlock, roster);

  const persistedConversation = Array.isArray(task.context?.conversation) ? task.context.conversation : [];
  let conversation = task.result_payload?.paused_state?.conversation || [...persistedConversation, { role: "user", content: task.instruction }];
  let stepCount = task.result_payload?.paused_state?.step_count || 0;
  let artifacts = Array.isArray(task.result_payload?.paused_state?.artifacts) ? task.result_payload.paused_state.artifacts : [];
  let planCreated = Array.isArray(task.steps) && task.steps.length > 0;
  const allowedPlugins = [...new Set([...(Array.isArray(agent.allowed_plugins) ? agent.allowed_plugins.map(normalizePluginId) : []), ...BUILT_IN_TOOLS])];
  const approvedAction = task.result_payload?.paused_state?.approved_action;
  const deniedAction = task.result_payload?.paused_state?.denied_action;

  if (deniedAction) {
    conversation.push({ role: "user", content: `[The user declined ${deniedAction.plugin_id}.${deniedAction.action}. Do not retry it. Choose a safe alternative or explain the limitation.]` });
  }

  if (approvedAction) {
    const validationError = validateActionStep(approvedAction, allowedPlugins);
    if (validationError) { await failTask(taskId, `Approved action rejected by policy: ${validationError}`); return; }
    const expectedHash = task.result_payload?.paused_state?.approved_action_hash;
    if (expectedHash && expectedHash !== actionHash(approvedAction)) { await failTask(taskId, "Approved action changed after approval and was blocked."); return; }
    await supabaseAdmin.from("tasks").update({ result_payload: { ...(task.result_payload || {}), paused_state: { ...(task.result_payload?.paused_state || {}), approved_action: null, approved_action_hash: null } }, updated_at: new Date().toISOString() }).eq("id", taskId);
    const result = await runPluginAction({ userId: task.user_id, agentId: agent.id, taskId, pluginId: approvedAction.plugin_id, action: approvedAction.action, params: approvedAction.params });
    conversation.push({ role: "user", content: `[Approved tool result for ${approvedAction.plugin_id}.${approvedAction.action}]: ${JSON.stringify(result).slice(0, 2000)}` });
    if (!result.ok) { await failTask(taskId, result.error); return; }
    if (approvedAction.plugin_id === "files" && ["create_file", "edit_file"].includes(approvedAction.action) && result.data?.id) artifacts = [...artifacts.filter((file) => file.id !== result.data.id), result.data];
    await recordActivity({ agentId: agent.id, taskId, type: "approved_action_completed", summary: `Completed approved ${approvedAction.plugin_id}.${approvedAction.action}`, detail: { plugin_id: approvedAction.plugin_id, action: approvedAction.action } });
  }

  const maxSteps = Math.max(1, Math.min(Number(task.max_steps || 12), 30));
  while (stepCount < maxSteps) {
    stepCount += 1;
    let modelOutput;
    try { modelOutput = await reasoningCall({ systemPrompt, conversation, userId: task.user_id, agentId: agent.id, taskId }); }
    catch (err) { await failTask(taskId, `Model call failed: ${err.response?.data?.error?.message || err.message}`); return; }
    const step = parseStep(modelOutput);
    await appendRunStep({ taskId, runId: activeRuns.get(taskId), index: stepCount, type: "model", status: step ? "succeeded" : "failed", input: { conversation_size: conversation.length }, output: { response: String(modelOutput).slice(0, 8000) }, error: step ? null : "Invalid control response" });
    if (!step) {
      if (/"type"\s*:\s*"(action|plan|question|handoff|parallel|final_answer)"|"plugin_id"\s*:|"action"\s*:/i.test(modelOutput)) {
        conversation.push({ role: "user", content: "Your previous response resembled an internal control object but was invalid JSON. Return exactly one valid JSON object and do not wrap it in Markdown." });
        continue;
      }
      await completeTask(taskId, { result_type: "task_complete", result_payload: { text: modelOutput, files: artifacts } }); return;
    }
    conversation.push({ role: "assistant", content: modelOutput });

    const plan = normalizePlan(step);
    if (plan) {
      if (planCreated) {
        conversation.push({ role: "user", content: "A plan is already saved. Execute the next safe step now." });
        continue;
      }
      await supabaseAdmin.from("tasks").update({ steps: plan.steps, current_step: 1, updated_at: new Date().toISOString() }).eq("id", taskId);
      planCreated = true;
      await recordActivity({ agentId: agent.id, taskId, type: "plan_created", summary: `Created a ${plan.steps.length}-step plan`, detail: { goal: plan.goal, steps: plan.steps } });
      conversation.push({ role: "user", content: "Plan saved. Execute the first safe step now; do not restate the plan." });
      continue;
    }
    if (step.type === "final_answer") { await completeTask(taskId, { result_type: step.result_type || "task_complete", result_payload: { text: step.text, ...step.extra, files: artifacts } }); await extractMemory({ agent, task, conversation }); return; }
    if (step.type === "question") {
      await finishRun(activeRuns.get(taskId), "waiting_input"); activeRuns.delete(taskId);
      await supabaseAdmin.from("tasks").update({ status: "needs_approval", result_type: "missing_info", result_payload: { question: step.question, options: step.options || null, paused_state: { conversation, step_count: stepCount, artifacts } }, lease_token: null, lease_expires_at: null, updated_at: new Date().toISOString() }).eq("id", taskId);
      await recordActivity({ agentId: agent.id, taskId, type: "input_requested", summary: "Agent needs more information", detail: { question: step.question }, severity: "warning" });
      return;
    }
    if (step.type === "handoff") { await handleHandoff({ fromAgent: agent, task, step, conversation, stepCount, artifacts }); return; }
    if (step.type === "parallel") { await handleParallel({ fromAgent: agent, task, step, conversation, stepCount, artifacts }); return; }
    if (step.type === "action") {
      step.plugin_id = normalizePluginId(step.plugin_id);
      const validation = validateToolCall(step, allowedPlugins);
      const validationError = validation.ok ? null : validation.error;
      if (validationError) {
        conversation.push({ role: "user", content: `[Policy validation failed: ${validationError}] Choose a valid next step or ask one focused question.` });
        continue;
      }
      const risk = validation.action.risk;
      if (risk !== "safe" && !isAutoApproved(agent, step, risk)) {
        const requestedAction = { plugin_id: step.plugin_id, action: step.action, params: step.params, description: step.description || null };
        const stepRow = await appendRunStep({ taskId, runId: activeRuns.get(taskId), index: stepCount + 1000, type: "approval", status: "waiting", toolName: `${step.plugin_id}.${step.action}`, risk, input: { action: requestedAction } });
        const approval = await createApproval({ userId: task.user_id, taskId, runId: activeRuns.get(taskId), stepId: stepRow?.id || null, action: requestedAction, risk, reason: step.description || `${agent.name} requests this action` });
        await finishRun(activeRuns.get(taskId), "waiting_approval");
        activeRuns.delete(taskId);
        await supabaseAdmin.from("tasks").update({ status: "needs_approval", result_type: "irreversible_pending", result_payload: { action: step.action, plugin_id: step.plugin_id, params: step.params, description: step.description || `${agent.name} wants to run ${step.action} on ${step.plugin_id}`, approval_id: approval?.id || null, action_hash: actionHash(requestedAction), risk_level: risk, paused_state: { conversation, step_count: stepCount, artifacts } }, lease_token: null, lease_expires_at: null, updated_at: new Date().toISOString() }).eq("id", taskId);
        await recordActivity({ agentId: agent.id, taskId, type: "approval_requested", summary: "Approval required before a consequential action", detail: { plugin_id: step.plugin_id, action: step.action }, severity: "warning" });
        return;
      }
      const result = await runPluginAction({ userId: task.user_id, agentId: agent.id, taskId, pluginId: step.plugin_id, action: step.action, params: step.params });
      await appendRunStep({ taskId, runId: activeRuns.get(taskId), index: stepCount + 1000, type: "tool", status: result.ok ? "succeeded" : "failed", toolName: `${step.plugin_id}.${step.action}`, risk, input: step.params, output: result.ok ? result.data : {}, error: result.ok ? null : result.error });
      conversation.push({ role: "user", content: `[Tool result for ${step.plugin_id}.${step.action}]: ${JSON.stringify(result).slice(0, 2000)}` });
      if (!result.ok) { await failTask(taskId, result.error); return; }
      if (step.plugin_id === "files" && ["create_file", "edit_file"].includes(step.action) && result.data?.id) artifacts = [...artifacts.filter((file) => file.id !== result.data.id), result.data];
      if (step.plugin_id === "files" && ["create_file", "edit_file"].includes(step.action) && result.data?.id && !/\b(multiple|several|two|three|four|five|\d+\s+(?:files|documents))\b/i.test(String(task.instruction || ""))) {
        await completeTask(taskId, { result_type: "task_complete", result_payload: { title: step.action === "edit_file" ? "Document Updated" : "Document Created", text: `${step.action === "edit_file" ? "Updated" : "Created"} ${result.data.name}.`, files: artifacts } });
        await extractMemory({ agent, task, conversation });
        return;
      }
      continue;
    }
    await failTask(taskId, `Model returned an unrecognized step type: ${step.type}`); return;
  }
  await failTask(taskId, `Task exceeded ${maxSteps} steps without reaching a final answer.`);
}

async function buildSkillsBlock(agentId) {
  const { data: coreSkills } = await supabaseAdmin.from("skills").select("name, instructions").eq("tier", "core").eq("status", "active");
  const { data: enabledRows } = await supabaseAdmin.from("agent_skills").select("skill_id").eq("agent_id", agentId);
  const enabledIds = (enabledRows || []).map((r) => r.skill_id);
  let librarySkills = [];
  if (enabledIds.length) { const { data } = await supabaseAdmin.from("skills").select("name, instructions").in("id", enabledIds).eq("status", "active"); librarySkills = data || []; }
  const { data: agent } = await supabaseAdmin.from("agents").select("role,goal").eq("id", agentId).single();
  const dedupe = (list) => [...new Map(list.filter((s) => s?.name && s?.instructions).map((s) => [s.name, s])).values()];
  const format = (list) => list.map((s) => `• ${s.name}: ${s.instructions}`).join("\n");
  const baseline = dedupe([...(coreSkills || []), ...BASELINE_EXECUTION_SKILLS]);
  const roleSkills = getRoleSkills(agent || {});
  return [
    "CORE EXECUTION SKILLS (always active):", format(baseline),
    roleSkills.length ? "\nROLE DEFAULTS (automatically selected from this agent's job):" : "", roleSkills.length ? format(roleSkills) : "",
    librarySkills.length ? "\nINSTALLED SKILLS (enabled for this agent):" : "", librarySkills.length ? format(librarySkills) : "",
  ].filter(Boolean).join("\n");
}

function buildSystemPrompt(agent, memoryBlock, skillsBlock, roster = []) {
  const connectedPlugins = [...new Set([...(Array.isArray(agent.allowed_plugins) ? agent.allowed_plugins : []), ...BUILT_IN_TOOLS])];
  const actionCatalog = `${toolsForAgent(connectedPlugins).map((tool) => `${tool.name} [${tool.risk}] required: ${tool.required.join(", ") || "none"}`).join("\n")}\n\nFile generation: use one exact supported extension (.docx, .pdf, .xlsx, .pptx, .csv, .txt, .md, .json, or .html). Match the user's requested format; use .xlsx for spreadsheets and .pptx for presentations.\n\nFor 2-6 genuinely independent specialist assignments, you may return: {"type":"parallel","assignments":[{"to_agent_name":"exact agent name","instruction":"independent outcome"},{"to_agent_name":"another exact agent name","instruction":"independent outcome"}]}. Use handoff for one specialist. Never duplicate an assignment.`;
  const rosterBlock = roster.length ? roster.map((member) => `- ${member.name}: ${member.role || "Agent"}; ${member.goal || "no goal supplied"}`).join("\n") : "(no other active agents)";
  return `${agent.system_prompt}\n\n${skillsBlock}\n\nOnly these plugin actions are executable:\n${actionCatalog}\n\nAvailable agent roster for handoffs (use exact names only):\n${rosterBlock}\n\nBRAIN LOOP: Understand the outcome, make a short plan only for multi-step work, execute the next safe step, inspect the real result, then continue, ask one material question, request approval, hand off, or finish. Do not expose private chain-of-thought.\n\nKnown facts about how this user works:\n${memoryBlock}\n\nRespond with ONLY one JSON object:\n{\"type\":\"plan\",\"goal\":\"short objective\",\"steps\":[{\"title\":\"first outcome\"},{\"title\":\"second outcome\"}]}\n{\"type\":\"action\",\"plugin_id\":\"files\",\"action\":\"create_file\",\"params\":{\"name\":\"example.pdf\",\"content\":\"...\"},\"description\":\"Create the requested file\"}\n{\"type\":\"question\",\"question\":\"one material missing detail\",\"options\":[\"A\",\"B\"]}\n{\"type\":\"handoff\",\"to_agent_name\":\"exact agent name\",\"note\":\"context and requested outcome\"}\n{\"type\":\"final_answer\",\"text\":\"what was completed and verified\",\"result_type\":\"task_complete\"}\n\nRules:\n- Plan only once, before the first action, and only when steps are dependent.\n- Never invent an action outside the executable catalog or claim success without a tool result.\n- Sensitive and restricted actions pause for approval. Restricted actions can never be auto-approved.\n- Ask a question only when a missing detail materially blocks safe, correct work; otherwise make a reversible assumption and proceed.\n- After a successful tool result, continue toward completion without waiting for another user prompt.\n- Use final_answer only when the task is genuinely complete and verified.`;
}

function repairJsonStringControls(value) {
  let output = ""; let inString = false; let escaped = false;
  for (const char of String(value || "")) {
    if (escaped) { output += char; escaped = false; continue; }
    if (char === "\\" && inString) { output += char; escaped = true; continue; }
    if (char === '"') { output += char; inString = !inString; continue; }
    if (inString && char === "\n") { output += "\\n"; continue; }
    if (inString && char === "\r") { output += "\\r"; continue; }
    if (inString && char === "\t") { output += "\\t"; continue; }
    output += char;
  }
  return output;
}

function parseStep(text) {
  let raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const parsed = JSON.parse(pass === 0 ? raw : repairJsonStringControls(raw));
      if (typeof parsed === "string") { raw = parsed; continue; }
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {}
    let start = raw.indexOf("{"); let depth = 0; let inString = false; let escaped = false;
    if (start < 0) return null;
    for (let i = start; i < raw.length; i += 1) {
      const char = raw[i];
      if (escaped) { escaped = false; continue; }
      if (char === "\\" && inString) { escaped = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      if (depth === 0) { raw = raw.slice(start, i + 1); break; }
    }
  }
  try { const parsed = JSON.parse(raw); return parsed && typeof parsed === "object" ? parsed : null; } catch { return null; }
}
async function completeTask(taskId, { result_type, result_payload }) {
  const now = new Date().toISOString();
  const { data: task } = await supabaseAdmin.from("tasks").update({ status: "done", result_type, result_payload, completed_at: now, lease_token: null, lease_expires_at: null, updated_at: now }).eq("id", taskId).select("agent_id,user_id,conversation_id,parent_task_id").single();
  await finishRun(activeRuns.get(taskId), "succeeded"); activeRuns.delete(taskId);
  if (task) {
    await recordActivity({ agentId: task.agent_id, taskId, type: "task_completed", summary: "Agent completed work", detail: { result_type } });
    if (task.conversation_id && result_payload?.text) await supabaseAdmin.from("messages").insert({ user_id: String(task.user_id), conversation_id: task.conversation_id, task_id: taskId, agent_id: task.agent_id, sender_type: "agent", content: String(result_payload.text), content_json: { result_type, result_payload } });
    if (task.parent_task_id) await resumeParentTask(task.parent_task_id, taskId, result_payload);
  }
}
async function failTask(taskId, message) {
  const now = new Date().toISOString();
  const { data: task } = await supabaseAdmin.from("tasks").update({ status: "failed", result_type: "failure", result_payload: { error: message }, completed_at: now, lease_token: null, lease_expires_at: null, updated_at: now }).eq("id", taskId).select("agent_id,parent_task_id").single();
  await finishRun(activeRuns.get(taskId), "failed", message); activeRuns.delete(taskId);
  if (task) {
    await recordActivity({ agentId: task.agent_id, taskId, type: "task_failed", summary: "Agent task failed", detail: { message: String(message).slice(0, 500) }, severity: "error" });
    if (task.parent_task_id) await resumeParentTask(task.parent_task_id, taskId, { error: message, status: "failed" });
  }
}

async function handleHandoff({ fromAgent, task, step, conversation = [], stepCount = 0, artifacts = [] }) {
  const { data: toAgent } = await supabaseAdmin.from("agents").select("*").eq("user_id", task.user_id).ilike("name", step.to_agent_name).single();
  if (!toAgent) { await failTask(task.id, `Tried to hand off to \"${step.to_agent_name}\" but no such agent exists.`); return; }
  if (!canHandoffTo(fromAgent, toAgent.id)) { await failTask(task.id, `Handoff to \"${toAgent.name}\" is not allowed for this agent.`); return; }
  const { data: newTask } = await supabaseAdmin.from("tasks").insert({ user_id: task.user_id, agent_id: toAgent.id, instruction: step.note || task.instruction, status: "pending", source: "handoff", conversation_id: task.conversation_id || null, parent_task_id: task.id, root_task_id: task.root_task_id || task.id, delegated_by_agent_id: fromAgent.id, context: { conversation: task.context?.conversation || [] } }).select().single();
  if (!newTask) { await failTask(task.id, "Failed to create handoff task."); return; }
  await supabaseAdmin.from("task_handoffs").insert({ from_agent_id: fromAgent.id, to_agent_id: toAgent.id, task_id: newTask.id, note: step.note || task.instruction, context_summary: step.note || task.instruction });
  await supabaseAdmin.from("tasks").update({ status: "waiting_children", result_type: "delegated", result_payload: { handed_off_to: toAgent.name, child_task_id: newTask.id, note: step.note, pending_child_ids: [newTask.id], child_results: {}, paused_state: { conversation, step_count: stepCount, artifacts } }, lease_token: null, lease_expires_at: null, updated_at: new Date().toISOString() }).eq("id", task.id);
  await finishRun(activeRuns.get(task.id), "waiting_children"); activeRuns.delete(task.id);
  const { agentTaskQueue } = await import("./queue.js");
  await agentTaskQueue.add("run-task", { taskId: newTask.id }, { attempts: 3, backoff: { type: "exponential", delay: 5000 } });
}

async function handleParallel({ fromAgent, task, step, conversation = [], stepCount = 0, artifacts = [] }) {
  const requested = Array.isArray(step.assignments) ? step.assignments.slice(0, 6) : [];
  if (requested.length < 2) { await failTask(task.id, "Parallel delegation requires at least two independent assignments."); return; }
  const { data: roster } = await supabaseAdmin.from("agents").select("id,name,role,status").eq("user_id", task.user_id).eq("status", "active");
  const byName = new Map((roster || []).map(member => [String(member.name).trim().toLowerCase(), member]));
  const seen = new Set();
  const assignments = requested.map(item => {
    const target = byName.get(String(item?.to_agent_name || "").trim().toLowerCase());
    const instruction = String(item?.instruction || item?.note || "").trim();
    if (!target || target.id === fromAgent.id || !instruction || seen.has(target.id) || !canHandoffTo(fromAgent, target.id)) return null;
    seen.add(target.id);
    return { target, instruction };
  }).filter(Boolean);
  if (assignments.length < 2) { await failTask(task.id, "Parallel delegation did not contain two valid, allowed agents with instructions."); return; }

  const rows = assignments.map(({ target, instruction }) => ({
    user_id: task.user_id,
    agent_id: target.id,
    instruction,
    status: "pending",
    source: "handoff",
    conversation_id: task.conversation_id || null,
    parent_task_id: task.id,
    root_task_id: task.root_task_id || task.id,
    delegated_by_agent_id: fromAgent.id,
    context: { conversation: task.context?.conversation || [], parallel: true },
  }));
  const { data: childTasks, error } = await supabaseAdmin.from("tasks").insert(rows).select();
  if (error || !childTasks?.length) { await failTask(task.id, error?.message || "Failed to create parallel tasks."); return; }
  const targetById = new Map(assignments.map(item => [item.target.id, item]));
  await supabaseAdmin.from("task_handoffs").insert(childTasks.map(child => ({
    from_agent_id: fromAgent.id,
    to_agent_id: child.agent_id,
    task_id: child.id,
    note: targetById.get(child.agent_id)?.instruction || child.instruction,
    context_summary: targetById.get(child.agent_id)?.instruction || child.instruction,
  })));
  const pendingChildIds = childTasks.map(child => child.id);
  await supabaseAdmin.from("tasks").update({
    status: "waiting_children",
    result_type: "delegated_parallel",
    result_payload: {
      pending_child_ids: pendingChildIds,
      child_results: {},
      delegated_to: assignments.map(item => item.target.name),
      paused_state: { conversation, step_count: stepCount, artifacts },
    },
    lease_token: null,
    lease_expires_at: null,
    updated_at: new Date().toISOString(),
  }).eq("id", task.id);
  await finishRun(activeRuns.get(task.id), "waiting_children"); activeRuns.delete(task.id);
  await recordActivity({ agentId: fromAgent.id, taskId: task.id, type: "parallel_delegation", summary: `Delegated work to ${childTasks.length} agents`, detail: { child_task_ids: pendingChildIds } });
  const { agentTaskQueue } = await import("./queue.js");
  await Promise.all(childTasks.map(child => agentTaskQueue.add("run-task", { taskId: child.id }, { attempts: 3, backoff: { type: "exponential", delay: 5000 } })));
}

async function resumeParentTask(parentTaskId, childTaskId, childResult) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { data: parent } = await supabaseAdmin.from("tasks").select("result_payload,updated_at").eq("id", parentTaskId).eq("status", "waiting_children").maybeSingle();
    if (!parent) return;
    const payload = parent.result_payload || {};
    const knownPending = Array.isArray(payload.pending_child_ids) ? payload.pending_child_ids : (payload.child_task_id ? [payload.child_task_id] : []);
    if (knownPending.length && !knownPending.includes(childTaskId)) return;
    const pendingChildIds = knownPending.filter(id => id !== childTaskId);
    const childResults = { ...(payload.child_results || {}), [childTaskId]: childResult };
    const paused = payload.paused_state || {};
    const conversation = Array.isArray(paused.conversation) ? paused.conversation : [];
    const resultPayload = { ...payload, pending_child_ids: pendingChildIds, child_results: childResults, paused_state: { ...paused, conversation: [...conversation, { role: "user", content: `[Delegated task ${childTaskId} completed]: ${JSON.stringify(childResult).slice(0, 3000)}` }] } };
    const ready = pendingChildIds.length === 0;
    const { data: updated } = await supabaseAdmin.from("tasks").update({ status: ready ? "pending" : "waiting_children", result_payload: resultPayload, updated_at: new Date().toISOString() }).eq("id", parentTaskId).eq("status", "waiting_children").eq("updated_at", parent.updated_at).select("id").maybeSingle();
    if (!updated) continue;
    if (ready) {
      const { agentTaskQueue } = await import("./queue.js");
      await agentTaskQueue.add("run-task", { taskId: parentTaskId, resume: true }, { attempts: 3, backoff: { type: "exponential", delay: 5000 } });
    }
    return;
  }
  console.error(`[agentLoop] could not resume parent ${parentTaskId} after concurrent child updates`);
}

async function extractMemory({ agent, task, conversation }) {
  try {
    await extractAndSaveMemories({ agent, task, conversation });
  } catch (err) { console.error("[agentLoop] memory extraction failed (non-fatal):", err.message); }
}
