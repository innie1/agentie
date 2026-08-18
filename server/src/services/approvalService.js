import crypto from "crypto";
import { supabaseAdmin } from "../supabaseClient.js";
import { getToolDefinition } from "../connectors/manifest.js";

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function actionHash(action) {
  return crypto.createHash("sha256").update(canonicalJson(action)).digest("hex");
}

export function validateApprovalAction(action) {
  const definition = getToolDefinition(action?.plugin_id, action?.action);
  if (!definition) throw new Error("The requested action is not registered.");
  if (definition.action.risk === "safe") throw new Error("Safe actions do not require an approval record.");
  return definition;
}

export async function decideApproval({ approval, userId, decision, editedAction = null, reason = null }) {
  if (!approval || approval.user_id?.toString() !== userId.toString()) throw new Error("Approval not found.");
  if (approval.status !== "pending") throw new Error("This approval has already been decided.");
  if (new Date(approval.expires_at).getTime() <= Date.now()) {
    await supabaseAdmin.from("approvals").update({ status: "expired", decided_at: new Date().toISOString() }).eq("id", approval.id).eq("status", "pending");
    throw new Error("This approval has expired.");
  }
  const action = editedAction || approval.action;
  validateApprovalAction(action);
  const nextStatus = decision === "approved" ? "approved" : "denied";
  const { data, error } = await supabaseAdmin.from("approvals").update({
    status: nextStatus,
    edited_action: editedAction,
    reason,
    decided_at: new Date().toISOString(),
  }).eq("id", approval.id).eq("status", "pending").select().single();
  if (error || !data) throw new Error(error?.message || "Approval could not be updated.");
  return { approval: data, action, hash: actionHash(action) };
}
