import { supabaseAdmin } from "../supabaseClient.js";

function isMissingRelation(error) {
  return error?.code === "42P01" || error?.code === "PGRST205" || /does not exist|schema cache/i.test(error?.message || "");
}

export async function getOrCreateConversation({ userId, agentId, conversationId, title }) {
  if (conversationId) {
    const { data, error } = await supabaseAdmin.from("conversations").select("*").eq("id", conversationId).eq("user_id", userId).single();
    if (!error && data) return data;
    if (!isMissingRelation(error)) throw new Error(error?.message || "Conversation not found");
    return null;
  }

  const { data: participant, error: participantError } = await supabaseAdmin
    .from("conversation_participants")
    .select("conversation_id, conversations!inner(*)")
    .eq("participant_type", "agent")
    .eq("participant_id", String(agentId))
    .eq("conversations.user_id", String(userId))
    .eq("conversations.kind", "direct")
    .eq("conversations.status", "active")
    .order("joined_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (participant?.conversations) return participant.conversations;
  if (participantError && isMissingRelation(participantError)) return null;

  const { data: conversation, error } = await supabaseAdmin.from("conversations").insert({
    user_id: String(userId), kind: "direct", title: title || "Agent conversation",
  }).select().single();
  if (error) {
    if (isMissingRelation(error)) return null;
    throw new Error(error.message);
  }
  await supabaseAdmin.from("conversation_participants").insert([
    { conversation_id: conversation.id, participant_type: "user", participant_id: String(userId) },
    { conversation_id: conversation.id, participant_type: "agent", participant_id: String(agentId) },
  ]);
  return conversation;
}

export async function appendMessage({ userId, conversationId, taskId = null, agentId = null, senderType, content, contentJson = {} }) {
  if (!conversationId) return null;
  const { data, error } = await supabaseAdmin.from("messages").insert({
    user_id: String(userId), conversation_id: conversationId, task_id: taskId,
    agent_id: agentId, sender_type: senderType, content: String(content || ""), content_json: contentJson || {},
  }).select().single();
  if (error) {
    if (isMissingRelation(error)) return null;
    throw new Error(error.message);
  }
  await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
  return data;
}

export async function recentConversationMessages(conversationId, limit = 20) {
  if (!conversationId) return [];
  const { data, error } = await supabaseAdmin.from("messages")
    .select("sender_type,content,content_json,created_at")
    .eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(limit);
  if (error) return [];
  return (data || []).reverse().filter((message) => ["user", "agent"].includes(message.sender_type)).map((message) => ({
    role: message.sender_type === "user" ? "user" : "assistant",
    content: message.content,
  }));
}
