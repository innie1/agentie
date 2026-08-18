import express from "express";
import axios from "axios";
import crypto from "crypto";
import { supabaseAdmin } from "../supabaseClient.js";
import { encrypt } from "../lib/crypto.js";
import { OAUTH_PROVIDERS } from "../lib/oauthProviders.js";

const router = express.Router();

// GET /api/plugins — list catalog + which ones this user has added
router.get("/", async (req, res) => {
  const userId = req.user.id; // set by auth middleware, see index.js
  const { data: plugins, error: pErr } = await supabaseAdmin.from("plugins").select("*").eq("status", "active");
  if (pErr) return res.status(500).json({ error: pErr.message });

  const { data: userPlugins, error: uErr } = await supabaseAdmin
    .from("user_plugins")
    .select("plugin_id, status, expires_at")
    .eq("user_id", userId);
  if (uErr) return res.status(500).json({ error: uErr.message });

  const addedMap = Object.fromEntries(userPlugins.map((p) => [p.plugin_id, p]));
  const merged = plugins.map((p) => ({
    ...p,
    added: !!addedMap[p.id],
    added_status: addedMap[p.id]?.status ?? null,
  }));

  res.json({ plugins: merged });
});

// POST /api/plugins/:pluginId/start — kicks off OAuth, returns the URL frontend should redirect to
router.post("/:pluginId/start", async (req, res) => {
  const userId = req.user.id;
  const { pluginId } = req.params;

  const { data: plugin, error } = await supabaseAdmin.from("plugins").select("*").eq("id", pluginId).single();
  if (error || !plugin) return res.status(404).json({ error: "Unknown plugin" });

  if (plugin.auth_type !== "oauth") {
    return res.status(400).json({ error: "This plugin uses api_key flow, call /add-api-key instead" });
  }

  const provider = OAUTH_PROVIDERS[pluginId];
  if (!provider?.clientId) {
    return res.status(500).json({
      error: `No OAuth app configured for '${pluginId}'. Set its client id/secret in server env vars.`,
    });
  }

  const state = crypto.randomBytes(24).toString("hex");
  const { error: insertErr } = await supabaseAdmin.from("pending_auth").insert({
    user_id: userId,
    plugin_id: pluginId,
    state,
  });
  if (insertErr) return res.status(500).json({ error: insertErr.message });

  const redirectUri = `${process.env.APP_URL}/api/plugins/callback`;
  const params = new URLSearchParams({
    client_id: provider.clientId,
    redirect_uri: redirectUri,
    scope: (plugin.oauth_scopes || []).join(" "),
    response_type: "code",
    state,
    access_type: "offline",   // harmless if provider ignores it (needed for Google refresh tokens)
    prompt: "consent",
  });

  res.json({ authorize_url: `${plugin.oauth_authorize_url}?${params.toString()}` });
});

// GET /api/plugins/callback — provider redirects here after user approves access.
// Exported separately and mounted WITHOUT requireAuth in index.js, since the
// provider's redirect won't carry the user's Supabase bearer token.
export async function oauthCallbackHandler(req, res) {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send("Missing code or state");

  const { data: pending, error: pErr } = await supabaseAdmin
    .from("pending_auth")
    .select("*")
    .eq("state", state)
    .gt("expires_at", new Date().toISOString())
    .single();

  if (pErr || !pending) return res.status(400).send("Invalid or expired auth attempt. Please try Add again.");

  const provider = OAUTH_PROVIDERS[pending.plugin_id];
  const { data: plugin } = await supabaseAdmin.from("plugins").select("*").eq("id", pending.plugin_id).single();
  const redirectUri = `${process.env.APP_URL}/api/plugins/callback`;

  try {
    const tokenReqConfig = {
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...(provider.tokenHeaders || {}) },
    };
    if (provider.basicAuth) tokenReqConfig.auth = provider.basicAuth();

    const body = new URLSearchParams(provider.tokenBody(code, redirectUri));
    const tokenRes = await axios.post(plugin.oauth_token_url, body, tokenReqConfig);
    const parsed = provider.parseToken(tokenRes.data);

    if (!parsed.access_token) {
      throw new Error("Provider did not return an access_token");
    }

    const expiresAt = parsed.expires_in
      ? new Date(Date.now() + parsed.expires_in * 1000).toISOString()
      : null;

    await supabaseAdmin.from("user_plugins").upsert(
      {
        user_id: pending.user_id,
        plugin_id: pending.plugin_id,
        access_token: encrypt(parsed.access_token),
        refresh_token: encrypt(parsed.refresh_token),
        expires_at: expiresAt,
        status: "active",
      },
      { onConflict: "user_id,plugin_id" }
    );

    await supabaseAdmin.from("pending_auth").delete().eq("id", pending.id);

    // Redirect back into the app's Plugins page — frontend should read ?connected=<id> to refresh UI
    res.redirect(`${process.env.APP_URL}/plugins?added=${pending.plugin_id}`);
  } catch (err) {
    console.error("[oauth callback]", err.response?.data || err.message);
    res.redirect(`${process.env.APP_URL}/plugins?error=${pending.plugin_id}`);
  }
}

// POST /api/plugins/:pluginId/add-api-key — for api_key-type plugins
router.post("/:pluginId/add-api-key", async (req, res) => {
  const userId = req.user.id;
  const { pluginId } = req.params;
  const { api_key } = req.body;

  if (!api_key) return res.status(400).json({ error: "api_key is required" });

  const { data: plugin, error } = await supabaseAdmin.from("plugins").select("*").eq("id", pluginId).single();
  if (error || !plugin) return res.status(404).json({ error: "Unknown plugin" });
  if (plugin.auth_type !== "api_key") return res.status(400).json({ error: "This plugin uses OAuth, not an API key" });

  // IMPORTANT: validate the key actually works before saving — never flip UI to "Added" on an unverified key.
  const valid = await testApiKey(pluginId, api_key);
  if (!valid.ok) {
    return res.status(400).json({ error: valid.error || "Key validation failed" });
  }

  await supabaseAdmin.from("user_plugins").upsert(
    {
      user_id: userId,
      plugin_id: pluginId,
      api_key: encrypt(api_key),
      status: "active",
    },
    { onConflict: "user_id,plugin_id" }
  );

  res.json({ ok: true });
});

// DELETE /api/plugins/:pluginId — remove a connected plugin
router.delete("/:pluginId", async (req, res) => {
  const userId = req.user.id;
  const { pluginId } = req.params;
  const { error } = await supabaseAdmin
    .from("user_plugins")
    .delete()
    .eq("user_id", userId)
    .eq("plugin_id", pluginId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Add real test calls per api_key-type plugin here as you add them.
async function testApiKey(pluginId, key) {
  try {
    switch (pluginId) {
      // example shape for a future api_key plugin:
      // case "some_service": {
      //   const r = await axios.get("https://api.example.com/me", { headers: { Authorization: `Bearer ${key}` } });
      //   return { ok: r.status === 200 };
      // }
      default:
        return { ok: false, error: `No key-validation logic wired up for '${pluginId}' yet.` };
    }
  } catch (err) {
    return { ok: false, error: err.response?.data?.error || err.message };
  }
}

export default router;
