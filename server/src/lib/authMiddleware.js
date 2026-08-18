import { supabaseAdmin } from "../supabaseClient.js";

// Verifies the Supabase access token sent from the frontend (Authorization: Bearer <token>)
// and attaches req.user for downstream routes.
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  const allowDevAuth = process.env.NODE_ENV !== "production" && Boolean(process.env.DEV_USER_ID);
  const devUser = allowDevAuth ? { id: process.env.DEV_USER_ID, email: process.env.DEV_USER_EMAIL || "dev@agentie.local" } : null;

  if (!token) {
    if (devUser) { req.user = devUser; return next(); }
    return res.status(401).json({ error: "Authentication is required" });
  }

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      if (devUser) { req.user = devUser; return next(); }
      return res.status(401).json({ error: "Invalid or expired authentication token" });
    }
    req.user = data.user;
    next();
  } catch (err) {
    if (devUser) { req.user = devUser; return next(); }
    next(err);
  }
}
