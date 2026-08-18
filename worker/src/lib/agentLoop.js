import { supabaseAdmin } from "../supabaseClient.js";
import { classifyIntent, fastReply, reasoningCall } from "./openrouter.js";
import { runPluginAction, IRREVERSIBLE_ACTIONS } from "./pluginRunner.js";

const MAX_STEPS = 8; // hard ceiling so a bad plan can't loop forever

// ── Routine matching + replay (mirrors server/src/services/routineService.js logic,
// duplicated here because the worker is a separate process/deploy from the server) ──

async function matchRoutineTrigger(agentId, instruction) {
  if (!instruction || !agentId) return null;
  const cleanInst = instruction.toLowerCase().trim();

  const { data: routines } = await supabaseAdmin
    .from("routines")
    .select("*")
    .eq("agent_id", agentId)
    .eq("status", "active");

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
      params[key] = params[key]
        .replace(/\{\{today_date\}\}/g, todayStr)
        .replace(/\{\{current_time\}\}/g, now.toLocaleTimeString())
        .replace(/\{\{today_summary\}\}/g, context.summary || `Summary for ${todayStr}`);
    }
  }
  return params;
}

async function recordRoutineRun(routineId, status) {
  const updates = { last_run_at: new Date().toISOString(), last_run_status: status, updated_at: new Date().toISOString() };
  const { data: routine } = await supabaseAdmin.from("routines").update(updates).eq("id", routineId).select().single();
  if (status === "success" && routine) {
    await supabaseAdmin.from("routines").update({ success_count: (routine.success_count || 0) + 1 }).eq("id", routineId);
  }
}

// Replays a matched routine's saved steps directly instead of asking the model to
// re-plan from scratch. Returns true if it fully handled the task (completed, failed,
// or paused for approval) — false only if there's nothing to replay (shouldn't happen
// given the caller already confirmed a match, but kept defensive).
async function replayRoutine({ routine, agent, task }) {
  const steps = routine.steps || [];
  if (!steps.length) return false;

  for (const step of steps) {
    const isIrreversible = IRREVERSIBLE_ACTIONS.has(step.action) && !agent.auto_approved_actions.includes(step.action);
    const params = adaptStepParams(step);

    if (isIrreversible) {
      await supabaseAdmin.from("tasks").update({
        status: "needs_approval",
        result_type: "irreversible_pending",
        result_payload: {
          action: step.action,
          plugin_id: step.plugin_id,
          params,
          description: `${agent.name} wants to run "${routine.name}" step: ${step.action} on ${step.plugin_id}`,
          routine_id: routine.id,
        },
        updated_at: new Date().toISOString(),
      }).eq("id", task.id);
      // NOTE: resuming a paused routine step-by-step isn't implemented in this pass —
      // once approved, the task can be safely re-run as a normal reasoning task by
      // clearing routine context, since the risky step will have already gone through
      // approval once resolved. This keeps the approval gate airtight even for routines.
      return true;
    }

    const result = await runPluginAction({
      userId: task.user_id, agentId: agent.id, taskId: task.id,
      pluginId: step.plugin_id, action: step.action, params,
    });

    if (!result.ok) {
      await supabaseAdmin.from("tasks").update({
        status: "failed",
        result_type: "failure",
        result_payload: { error: result.error, action: step.action, routine_id: routine.id },
        updated_at: new Date().toISOString(),
      }).eq("id", task.id);
      await recordRoutineRun(routine.id, "failed");
      return true;
    }
  }

  await supabaseAdmin.from("tasks").update({
    status: "done",
    result_type: "task_complete",
    result_payload: { text: `Completed routine "${routine.name}" (${steps.length} step${steps.length > 1 ? "s" : ""}).`, routine_id: routine.id },
    updated_at: new Date().toISOString(),
  }).eq("id", task.id);
  await recordRoutineRun(routine.id, "success");
  return true;
}

export async function runTask(taskId) {
  const { data: task, error: taskErr } = await supabaseAdmin.from("tasks").select("*").eq("id", taskId).single();
  if (taskErr || !task) {
    console.error(`[agentLoop] task ${taskId} not found`, taskErr?.message);
    return;
  }

  const { data: agent, error: agentErr } = await supabaseAdmin.from("agents").select("*").eq("id", task.agent_id).single();
  if (agentErr || !agent) {
    await failTask(taskId, "Agent not found");
    return;
  }

  // Idempotency guard: if a duplicate enqueue (direct call + DB webhook both firing)
  // lands here while the task is already being worked or finished, skip silently.
  if (!["pending"].includes(task.status)) {
    console.log(`[agentLoop] skipping ${taskId}, status is already '${task.status}'`);
    return;
  }

  await supabaseAdmin.from("tasks").update({ status: "in_progress", updated_at: new Date().toISOString() }).eq("id", taskId);

  // ── Step 0: does a taught routine match this instruction? Replay it instead of re-planning. ──
  // Skipped on resume (a paused task is already mid-plan or mid-routine-replay).
  const isResume = !!(task.result_payload && task.result_payload.paused_state);
  if (!isResume) {
    const routine = await matchRoutineTrigger(agent.id, task.instruction);
    if (routine) {
      const handled = await replayRoutine({ routine, agent, task });
      if (handled) return; // routine handled the task fully (or paused for approval) — stop here
    }
  }

  // ── Step 1: cheap intent check — skip the whole pipeline for small talk ──
  if (!isResume) {
    const intent = await classifyIntent({ instruction: task.instruction, userId: task.user_id, agentId: agent.id, taskId });
    if (intent === "SIMPLE") {
      const reply = await fastReply({ instruction: task.instruction, agentName: agent.name, userId: task.user_id, agentId: agent.id, taskId });
      await completeTask(taskId, { result_type: "fact", result_payload: { text: reply } });
      return;
    }
  }

  // ── Step 2: load memory + plugin list + skills into context ──
  const { data: memories } = await supabaseAdmin.from("agent_memory").select("key, value").eq("agent_id", agent.id);
  const memoryBlock = (memories || []).map((m) => `- ${m.key}: ${m.value}`).join("\n") || "(no saved facts yet)";

  const skillsBlock = await buildSkillsBlock(agent.id);
  const systemPrompt = buildSystemPrompt(agent, memoryBlock, skillsBlock);

  // conversation + loop state — resumed from result_payload if this is a re-run after approval
  let conversation = task.result_payload?.paused_state?.conversation || [
    { role: "user", content: task.instruction },
  ];
  let stepCount = task.result_payload?.paused_state?.step_count || 0;

  while (stepCount < MAX_STEPS) {
    stepCount += 1;

    let modelOutput;
    try {
      modelOutput = await reasoningCall({ systemPrompt, conversation, userId: task.user_id, agentId: agent.id, taskId });
    } catch (err) {
      await failTask(taskId, `Model call failed: ${err.response?.data?.error?.message || err.message}`);
      return;
    }

    const step = parseStep(modelOutput);
    if (!step) {
      // model didn't return valid JSON — treat its raw text as a final answer
      await completeTask(taskId, { result_type: "task_complete", result_payload: { text: modelOutput } });
      return;
    }

    conversation.push({ role: "assistant", content: modelOutput });

    if (step.type === "final_answer") {
      await completeTask(taskId, { result_type: step.result_type || "task_complete", result_payload: { text: step.text, ...step.extra } });
      await extractMemory({ agent, task, conversation });
      return;
    }

    if (step.type === "question") {
      await supabaseAdmin.from("tasks").update({
        status: "needs_approval", // reuses the same "waiting on user" UI state
        result_type: "missing_info",
        result_payload: { question: step.question, options: step.options || null, paused_state: { conversation, step_count: stepCount } },
        updated_at: new Date().toISOString(),
      }).eq("id", taskId);
      return;
    }

    if (step.type === "handoff") {
      await handleHandoff({ fromAgent: agent, task, step });
      return;
    }

    if (step.type === "action") {
      const isIrreversible = IRREVERSIBLE_ACTIONS.has(step.action) && !agent.auto_approved_actions.includes(step.action);

      if (isIrreversible) {
        await supabaseAdmin.from("tasks").update({
          status: "needs_approval",
          result_type: "irreversible_pending",
          result_payload: {
            action: step.action,
            plugin_id: step.plugin_id,
            params: step.params,
            description: step.description || `${agent.name} wants to run ${step.action} on ${step.plugin_id}`,
            paused_state: { conversation, step_count: stepCount },
          },
          updated_at: new Date().toISOString(),
        }).eq("id", taskId);
        return; // STOP — wait for /approve to resume
      }

      const result = await runPluginAction({
        userId: task.user_id, agentId: agent.id, taskId,
        pluginId: step.plugin_id, action: step.action, params: step.params,
      });

      conversation.push({
        role: "user",
        content: `[Tool result for ${step.plugin_id}.${step.action}]: ${JSON.stringify(result).slice(0, 2000)}`,
      });

      if (!result.ok) {
        await supabaseAdmin.from("tasks").update({
          status: "failed",
          result_type: "failure",
          result_payload: { error: result.error, action: step.action },
          updated_at: new Date().toISOString(),
        }).eq("id", taskId);
        return;
      }
      // loop continues — model sees the tool result next iteration
      continue;
    }

    // unrecognized step type — bail safely rather than loop blindly
    await failTask(taskId, `Model returned an unrecognized step type: ${step.type}`);
    return;
  }

  await failTask(taskId, `Task exceeded ${MAX_STEPS} steps without reaching a final answer.`);
}

// Core skills apply to every agent automatically — no install, cannot be disabled.
// Library skills only apply if the agent has them enabled in agent_skills.
async function buildSkillsBlock(agentId) {
  const { data: coreSkills } = await supabaseAdmin.from("skills").select("name, instructions").eq("tier", "core").eq("status", "active");

  const { data: enabledRows } = await supabaseAdmin.from("agent_skills").select("skill_id").eq("agent_id", agentId);
  const enabledIds = (enabledRows || []).map((r) => r.skill_id);

  let librarySkills = [];
  if (enabledIds.length) {
    const { data } = await supabaseAdmin.from("skills").select("name, instructions").in("id", enabledIds).eq("status", "active");
    librarySkills = data || [];
  }

  const format = (list) => list.map((s) => `• ${s.name}: ${s.instructions}`).join("\n");

  return [
    "CORE SKILLS (always active):",
    format(coreSkills || []),
    librarySkills.length ? "\nINSTALLED SKILLS (enabled for this agent):" : "",
    librarySkills.length ? format(librarySkills) : "",
  ].filter(Boolean).join("\n");
}

function buildSystemPrompt(agent, memoryBlock, skillsBlock) {
  return `${agent.system_prompt}

${skillsBlock}

You can use these plugins (only these): ${agent.allowed_plugins.join(", ") || "(none connected)"}

Skills determine HOW you approach a task (how you plan, review, communicate).
Plugins determine WHAT tools you have access to. Apply your skills' guidance
regardless of which plugins are available — skills shape reasoning and output
quality even on tasks that use no plugin at all.

Known facts about how this user works:
${memoryBlock}

Respond with ONLY a single JSON object, no other text, matching one of these shapes:
{"type":"action","plugin_id":"gmail","action":"send_email","params":{...},"description":"short human description of what this does"}
{"type":"question","question":"...", "options":["A","B"]}
{"type":"handoff","to_agent_name":"...", "note":"context summary for the receiving agent"}
{"type":"final_answer","text":"...", "result_type":"task_complete"}

Rules:
- Never invent a plugin action outside the list of connected plugins.
- Any send/delete/pay/publish action must go through "action" — the system will pause for approval automatically, you don't need to ask permission yourself.
- If you're missing information needed to proceed, use "question" instead of guessing.
- Once the task is genuinely done, respond with "final_answer".`;
}

function parseStep(text) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

async function completeTask(taskId, { result_type, result_payload }) {
  await supabaseAdmin.from("tasks").update({
    status: "done", result_type, result_payload, updated_at: new Date().toISOString(),
  }).eq("id", taskId);
}

async function failTask(taskId, message) {
  await supabaseAdmin.from("tasks").update({
    status: "failed", result_type: "failure", result_payload: { error: message }, updated_at: new Date().toISOString(),
  }).eq("id", taskId);
}

async function handleHandoff({ fromAgent, task, step }) {
  const { data: toAgent } = await supabaseAdmin
    .from("agents")
    .select("*")
    .eq("user_id", task.user_id)
    .ilike("name", step.to_agent_name)
    .single();

  if (!toAgent) {
    await failTask(task.id, `Tried to hand off to "${step.to_agent_name}" but no such agent exists.`);
    return;
  }

  const { data: newTask } = await supabaseAdmin.from("tasks").insert({
    user_id: task.user_id, agent_id: toAgent.id, instruction: step.note || task.instruction,
    status: "pending", source: "handoff",
  }).select().single();

  await supabaseAdmin.from("task_handoffs").insert({
    from_agent_id: fromAgent.id, to_agent_id: toAgent.id, task_id: newTask.id, note: step.note,
  });

  await supabaseAdmin.from("tasks").update({
    status: "done", result_type: "delegated",
    result_payload: { handed_off_to: toAgent.name, note: step.note },
    updated_at: new Date().toISOString(),
  }).eq("id", task.id);
}

// After a task completes, pull out any fact worth remembering long-term.
// Cheap fast-tier call — only runs on real completed outcomes, never speculative.
async function extractMemory({ agent, task, conversation }) {
  try {
    const { fastReply: extract } = await import("./openrouter.js");
    const transcript = conversation.map((m) => `${m.role}: ${m.content}`).join("\n").slice(0, 3000);
    const raw = await extract({
      instruction: `From this finished task, extract ONE short fact worth remembering for next time, in the form "key: value". If nothing is worth remembering, respond with exactly "NONE".\n\n${transcript}`,
      agentName: agent.name,
      userId: task.user_id,
      agentId: agent.id,
      taskId: task.id,
    });
    if (raw && !raw.trim().toUpperCase().startsWith("NONE") && raw.includes(":")) {
      const [key, ...rest] = raw.split(":");
      await supabaseAdmin.from("agent_memory").upsert(
        { agent_id: agent.id, key: key.trim().slice(0, 100), value: rest.join(":").trim().slice(0, 500), source_task_id: task.id },
        { onConflict: "agent_id,key" }
      );
    }
  } catch (err) {
    console.error("[agentLoop] memory extraction failed (non-fatal):", err.message);
  }
}
