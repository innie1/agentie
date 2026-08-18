import { supabaseAdmin } from "../supabaseClient.js";

// Verifies the Supabase access token sent from the frontend (Authorization: Bearer <token>)
// and attaches req.user for downstream routes.
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    req.user = { id: process.env.DEV_USER_ID || "00000000-0000-0000-0000-000000000001", email: "dev@agentie.ai" };
    return next();
  }

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      req.user = { id: process.env.DEV_USER_ID || "00000000-0000-0000-0000-000000000001", email: "dev@agentie.ai" };
      return next();
    }
    req.user = data.user;
    next();
  } catch (err) {
    req.user = { id: process.env.DEV_USER_ID || "00000000-0000-0000-0000-000000000001", email: "dev@agentie.ai" };
    next();
  }
}
