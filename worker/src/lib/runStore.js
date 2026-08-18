import crypto from "node:crypto";
import { supabaseAdmin } from "../supabaseClient.js";

const missingTable = (error) => ["42P01", "PGRST205"].includes(error?.code) || /does not exist|schema cache/i.test(error?.message || "");

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export const actionHash = (action) => crypto.createHash("sha256").update(canonicalJson(action)).digest("hex");

export async function startRun(task, leaseToken) {
  const attempt = Number(task.attempt_count || 0) + 1;
  const { data, error } = await supabaseAdmin.from("task_runs").insert({
    task_id: task.id, attempt, status: "running", lease_token: leaseToken,
  }).select().single();
  if (error && !missingTable(error)) console.warn("[runStore] start run:", error.message);
  return error ? null : data;
}

export async function appendRunStep({ taskId, runId, index, type, status = "succeeded", toolName = null, risk = null, input = {}, output = {}, error = null }) {
  if (!runId) return null;
  const now = new Date().toISOString();
  const { data, error: dbError } = await supabaseAdmin.from("task_steps").upsert({
    task_id: taskId, run_id: runId, step_index: index, step_type: type, status,
    tool_name: toolName, risk_level: risk, input, output,
    error: error ? { message: String(error) } : null, finished_at: status === "running" ? null : now,
  }, { onConflict: "run_id,step_index" }).select().single();
  if (dbError && !missingTable(dbError)) console.warn("[runStore] append step:", dbError.message);
  return dbError ? null : data;
}

export async function finishRun(runId, status, error = null) {
  if (!runId) return;
  const { error: dbError } = await supabaseAdmin.from("task_runs").update({
    status, error: error ? { message: String(error) } : null, finished_at: new Date().toISOString(),
  }).eq("id", runId);
  if (dbError && !missingTable(dbError)) console.warn("[runStore] finish run:", dbError.message);
}

export async function createApproval({ userId, taskId, runId, stepId, action, risk, reason }) {
  const { data, error } = await supabaseAdmin.from("approvals").insert({
    user_id: String(userId), task_id: taskId, run_id: runId, step_id: stepId,
    action, action_hash: actionHash(action), risk_level: risk, reason,
  }).select().single();
  if (error) {
    if (!missingTable(error)) console.warn("[runStore] approval:", error.message);
    return null;
  }
  return data;
}
