// Agentie plugin compatibility layer. Uses the existing marketplace UI; it keeps the
// existing visual design while making the frontend catalog authoritative from the backend.
(function () {
  const API_KEY_PLUGINS = new Set(['agentmail','discord','telegram','whatsapp','twilio','hubspot','postgres','stripe','shopify','aws']);
  const FIELD_DEFS = {
    agentmail: [['api_key','AgentMail API key']],
    stripe: [['api_key','Stripe secret key']],
    shopify: [['shop_domain','Shop domain (e.g. myshop.myshopify.com)'],['admin_access_token','Shopify Admin API access token']],
    whatsapp: [['access_token','WhatsApp/Meta access token'],['phone_number_id','WhatsApp phone number ID']],
    telegram: [['bot_token','Telegram bot token']],
    discord: [['bot_token','Discord bot token']],
    twilio: [['account_sid','Twilio Account SID'],['auth_token','Twilio Auth Token']],
    hubspot: [['access_token','HubSpot private app access token']],
    postgres: [['connection_string','PostgreSQL connection string']],
    aws: [['access_key_id','AWS access key ID'],['secret_access_key','AWS secret access key'],['region','AWS region (e.g. eu-west-1)']]
  };

  function api(path, options) {
    const url = (typeof window.agentieApiUrl === 'function') ? window.agentieApiUrl(path) : path;
    const token = window.AgentieAuth && window.AgentieAuth.getToken ? window.AgentieAuth.getToken() : null;
    const headers = Object.assign({'Content-Type':'application/json'}, (options && options.headers) || {});
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(url, Object.assign({}, options || {}, {headers}));
  }

  function ensureAgentMail() {
    if (typeof state === 'undefined' || !Array.isArray(state.plugins)) return false;
    if (!state.plugins.some(p => p.id === 'agentmail')) {
      state.plugins.push({
        id:'agentmail', name:'AgentMail', section:'Email & Communication', auth_type:'api_key',
        desc:'Give agents their own email inboxes and identities for sending, receiving, and replying to email.',
        added:false, keywords:['agentmail','agent mail','agent inbox','agent email','email identity']
      });
      return true;
    }
    return false;
  }

  function addLogo() {
    if (typeof getPluginLogoSvg !== 'function') return;
    const original = getPluginLogoSvg;
    window.getPluginLogoSvg = function(id) {
      if (id === 'agentmail') return '<img src="https://cdn.simpleicons.org/maildotru/ffffff" alt="AgentMail" class="w-5 h-5 object-contain" loading="lazy" onerror="this.outerHTML=\'<span class=\\\'material-symbols-outlined text-[18px] text-white\\\'>mail</span>\'"/>';
      return original(id);
    };
  }

  // The backend is the source of truth. Merge it into the existing UI state so
  // new plugins can never silently exist only in the backend. Existing local
  // metadata is preserved for UI wording/keywords while auth/category/status
  // from the backend take precedence when available.
  async function syncBackendCatalog() {
    try {
      if (typeof state === 'undefined' || !Array.isArray(state.plugins)) return;
      const res = await api('api/plugins');
      if (!res.ok) return;
      const payload = await res.json().catch(() => ({}));
      const remote = Array.isArray(payload.plugins) ? payload.plugins : [];
      for (const remotePlugin of remote) {
        if (!remotePlugin || !remotePlugin.id) continue;
        const local = state.plugins.find(p => p.id === remotePlugin.id);
        if (local) {
          Object.assign(local, {
            name: remotePlugin.name || local.name,
            section: remotePlugin.category || local.section,
            auth_type: remotePlugin.auth_type || local.auth_type,
            desc: remotePlugin.description || local.desc,
            added: !!remotePlugin.added,
            added_status: remotePlugin.added_status || null,
            logo: remotePlugin.logo || local.logo,
            icon_url: remotePlugin.icon_url || local.icon_url
          });
        } else {
          state.plugins.push({
            id: remotePlugin.id,
            name: remotePlugin.name || remotePlugin.id,
            section: remotePlugin.category || 'Other',
            auth_type: remotePlugin.auth_type || 'oauth',
            desc: remotePlugin.description || '',
            added: !!remotePlugin.added,
            added_status: remotePlugin.added_status || null,
            logo: remotePlugin.logo || null,
            icon_url: remotePlugin.icon_url || null,
            keywords: [String(remotePlugin.name || remotePlugin.id).toLowerCase()]
          });
        }
      }
      ensureAgentMail();
      if (typeof renderPlugins === 'function') renderPlugins();
      if (typeof updatePluginsBadges === 'function') updatePluginsBadges();
    } catch (err) {
      console.warn('[Agentie] plugin catalog sync:', err.message || err);
    }
  }

  async function connectApiPlugin(plugin) {
    const fields = FIELD_DEFS[plugin.id] || [['api_key', plugin.name + ' API key']];
    const credentials = {};
    for (const [key,label] of fields) {
      const value = window.prompt(label);
      if (value === null) return;
      if (!String(value).trim()) { window.alert(label + ' is required.'); return; }
      credentials[key] = String(value).trim();
    }
    const btn = document.querySelector('.toggle-plugin-btn[data-id="' + plugin.id + '"]');
    if (btn) btn.textContent = 'Connecting...';
    try {
      const res = await api('api/plugins/' + encodeURIComponent(plugin.id) + '/add-api-key', {method:'POST', body:JSON.stringify({credentials})});
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Credential validation failed');
      plugin.added = true;
      plugin.added_status = 'active';
      if (typeof updatePluginsBadges === 'function') updatePluginsBadges();
      if (typeof renderPlugins === 'function') renderPlugins();
    } catch (err) {
      window.alert('Connection failed: ' + (err.message || err));
      if (typeof renderPlugins === 'function') renderPlugins();
    }
  }

  function install() {
    if (typeof state === 'undefined' || typeof renderPlugins !== 'function') return false;
    ensureAgentMail();
    addLogo();
    if (!document.__agentieApiPluginPatch) {
      document.addEventListener('click', function (event) {
        const btn = event.target && event.target.closest ? event.target.closest('.toggle-plugin-btn') : null;
        if (!btn) return;
        const id = btn.getAttribute('data-id');
        if (!API_KEY_PLUGINS.has(id)) return;
        const plugin = state.plugins.find(p => p.id === id);
        if (!plugin || plugin.added) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        connectApiPlugin(plugin);
      }, true);
      document.__agentieApiPluginPatch = true;
    }
    renderPlugins();
    if (typeof updatePluginsBadges === 'function') updatePluginsBadges();
    syncBackendCatalog();
    return true;
  }

  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    try { if (install() || tries > 400) clearInterval(timer); } catch (err) { if (tries > 400) clearInterval(timer); }
  }, 50);
})();
