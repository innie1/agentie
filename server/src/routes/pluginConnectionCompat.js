import express from 'express';
import axios from 'axios';
import { supabaseAdmin } from '../supabaseClient.js';
import { encrypt } from '../lib/crypto.js';

const router = express.Router();

const API_KEY_PLUGINS = new Set([
  'agentmail', 'discord', 'telegram', 'whatsapp', 'twilio', 'hubspot',
  'postgres', 'stripe', 'shopify', 'aws'
]);

async function validate(pluginId, c) {
  try {
    switch (pluginId) {
      case 'agentmail': {
        const key = c.api_key;
        if (!key) return { ok: false, error: 'AgentMail API key is required' };
        const r = await axios.get('https://api.agentmail.to/v0/inboxes', { headers: { Authorization: `Bearer ${key}` }, params: { limit: 1 } });
        return { ok: r.status === 200 };
      }
      case 'stripe': {
        if (!c.api_key) return { ok: false, error: 'Stripe secret key is required' };
        const r = await axios.get('https://api.stripe.com/v1/account', { auth: { username: c.api_key, password: '' } });
        return { ok: r.status === 200 };
      }
      case 'shopify': {
        if (!c.shop_domain || !c.admin_access_token) return { ok: false, error: 'Shop domain and Admin API access token are required' };
        const domain = String(c.shop_domain).replace(/^https?:\/\//, '').replace(/\/$/, '');
        const r = await axios.get(`https://${domain}/admin/api/2025-10/shop.json`, { headers: { 'X-Shopify-Access-Token': c.admin_access_token } });
        return { ok: r.status === 200 };
      }
      case 'whatsapp': {
        if (!c.access_token || !c.phone_number_id) return { ok: false, error: 'WhatsApp access token and phone number ID are required' };
        const r = await axios.get(`https://graph.facebook.com/v23.0/${encodeURIComponent(c.phone_number_id)}`, { headers: { Authorization: `Bearer ${c.access_token}` } });
        return { ok: r.status === 200 };
      }
      case 'telegram': {
        if (!c.bot_token) return { ok: false, error: 'Telegram bot token is required' };
        const r = await axios.get(`https://api.telegram.org/bot${c.bot_token}/getMe`);
        return { ok: r.data?.ok === true };
      }
      case 'discord': {
        if (!c.bot_token) return { ok: false, error: 'Discord bot token is required' };
        const r = await axios.get('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bot ${c.bot_token}` } });
        return { ok: r.status === 200 };
      }
      case 'twilio': {
        if (!c.account_sid || !c.auth_token) return { ok: false, error: 'Twilio Account SID and Auth Token are required' };
        const r = await axios.get(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.account_sid)}.json`, { auth: { username: c.account_sid, password: c.auth_token } });
        return { ok: r.status === 200 };
      }
      case 'hubspot': {
        if (!c.access_token) return { ok: false, error: 'HubSpot private app access token is required' };
        const r = await axios.get('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', { headers: { Authorization: `Bearer ${c.access_token}` } });
        return { ok: r.status === 200 };
      }
      case 'postgres': {
        const value = c.connection_string || c.database_url;
        if (!value) return { ok: false, error: 'PostgreSQL connection string is required' };
        const parsed = new URL(value);
        if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) return { ok: false, error: 'Use a PostgreSQL connection string beginning with postgres:// or postgresql://' };
        return { ok: true };
      }
      case 'aws': {
        if (!c.access_key_id || !c.secret_access_key || !c.region) return { ok: false, error: 'AWS access key ID, secret access key, and region are required' };
        if (!/^\w[\w-]*$/.test(c.region)) return { ok: false, error: 'Invalid AWS region' };
        // Validate the credential shape without transmitting the secret anywhere.
        if (!/^AKIA|ASIA/.test(c.access_key_id)) return { ok: false, error: 'AWS access key ID format is invalid' };
        if (String(c.secret_access_key).length < 20) return { ok: false, error: 'AWS secret access key appears invalid' };
        return { ok: true };
      }
      default:
        return { ok: false, error: `Unsupported API-key plugin: ${pluginId}` };
    }
  } catch (err) {
    const providerError = err.response?.data?.error?.message || err.response?.data?.message || err.response?.data?.errors?.[0]?.message;
    return { ok: false, error: providerError || err.message || 'Provider rejected the credentials' };
  }
}

router.post('/:pluginId/add-api-key', async (req, res, next) => {
  const { pluginId } = req.params;
  if (!API_KEY_PLUGINS.has(pluginId)) return next();

  const supplied = req.body?.credentials && typeof req.body.credentials === 'object'
    ? req.body.credentials
    : (req.body?.api_key ? { api_key: req.body.api_key } : null);
  if (!supplied) return res.status(400).json({ error: 'credentials are required' });

  const validation = await validate(pluginId, supplied);
  if (!validation.ok) return res.status(400).json({ error: validation.error });

  const encrypted = Object.fromEntries(Object.entries(supplied).map(([key, value]) => [key, encrypt(String(value))]));
  const { error } = await supabaseAdmin.from('user_plugins').upsert({
    user_id: req.user.id,
    plugin_id: pluginId,
    credentials: { type: 'api_key', values: encrypted },
    status: 'active'
  }, { onConflict: 'user_id,plugin_id' });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, user_plugin: { plugin_id: pluginId, status: 'active' } });
});

export default router;
