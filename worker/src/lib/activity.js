import { supabaseAdmin } from "../supabaseClient.js";

export async function recordActivity({ agentId, taskId = null, type, summary, detail = {}, severity = "info" }) {
  if (!agentId || !type) return;
  let userId = detail?.user_id || null;
  if (!userId && taskId) {
    const { data: task } = await supabaseAdmin.from("tasks").select("user_id").eq("id", taskId).maybeSingle();
    userId = task?.user_id || null;
  }
  const event = await supabaseAdmin.from("agent_events").insert({
    user_id: userId ? String(userId) : null, agent_id: agentId, task_id: taskId,
    event_type: type, summary: String(summary || type), severity, detail,
  });
  if (!event.error) return;
  const { error } = await supabaseAdmin.from("action_log").insert({
    agent_id: agentId,
    task_id: taskId,
    action: `runtime.${type}`,
    params: { summary, severity, ...detail },
    result: { ok: true, recorded_at: new Date().toISOString() },
  });
  if (error) console.warn("[activity] unable to record event:", error.message);
}
