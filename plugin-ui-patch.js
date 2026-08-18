// Agentie plugin compatibility layer. Uses the existing marketplace UI; it only fills
// missing capability metadata and routes API-key plugins through the real backend.
(function () {
  const API_KEY_PLUGINS = new Set(['github','agentmail','discord','telegram','whatsapp','twilio','hubspot','postgres','stripe','shopify','aws']);
  const FIELD_DEFS = {
    github: [['access_token','GitHub personal access token']],
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

  function normalizeBackendPlugin(p) {
    return {
      id: p.id,
      name: p.name || p.id,
      section: p.category || p.section || 'Featured',
      desc: p.description || p.desc || '',
      added: !!p.added,
      auth_type: p.auth_type || 'oauth',
      icon_url: p.icon_url || p.logo_url || null,
      keywords: Array.isArray(p.keywords) ? p.keywords : [p.id, p.name || '']
    };
  }

  function mergeBackendCatalog(backendPlugins) {
    if (typeof state === 'undefined' || !Array.isArray(state.plugins)) return;
    const localById = new Map(state.plugins.map(p => [p.id, p]));
    backendPlugins.forEach(raw => {
      const incoming = normalizeBackendPlugin(raw);
      const current = localById.get(incoming.id);
      if (current) {
        current.name = incoming.name || current.name;
        current.section = incoming.section || current.section;
        current.desc = incoming.desc || current.desc;
        current.added = incoming.added;
        current.auth_type = incoming.auth_type;
        current.icon_url = incoming.icon_url || current.icon_url;
      } else {
        state.plugins.push(incoming);
        localById.set(incoming.id, incoming);
      }
    });
  }

  function addLogo() {
    if (typeof getPluginLogoSvg !== 'function' || window.__agentieLogoPatch) return;
    const original = getPluginLogoSvg;
    window.getPluginLogoSvg = function(id) {
      const plugin = (typeof state !== 'undefined' && Array.isArray(state.plugins)) ? state.plugins.find(p => p.id === id) : null;
      if (plugin && plugin.icon_url) return '<img src="' + plugin.icon_url + '" alt="' + (plugin.name || id) + '" class="w-5 h-5 object-contain" loading="lazy" onerror="this.outerHTML=\'<span class=\\\'material-symbols-outlined text-[18px] text-white\\\'>extension</span>\'"/>';
      if (id === 'agentmail') return '<span class="material-symbols-outlined text-[20px] text-white">alternate_email</span>';
      return original(id);
    };
    window.__agentieLogoPatch = true;
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
      if (typeof updatePluginsBadges === 'function') updatePluginsBadges();
      if (typeof renderPlugins === 'function') renderPlugins();
    } catch (err) {
      window.alert('Connection failed: ' + (err.message || err));
      if (typeof renderPlugins === 'function') renderPlugins();
    }
  }

  async function syncCatalog() {
    try {
      const res = await api('api/plugins');
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      if (Array.isArray(data.plugins)) mergeBackendCatalog(data.plugins);
    } catch (_) {}
  }

  function installClickBridge() {
    if (document.__agentieApiPluginPatch) return;
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

  async function install() {
    if (typeof state === 'undefined' || typeof renderPlugins !== 'function') return false;
    await syncCatalog();
    addLogo();
    installClickBridge();
    renderPlugins();
    if (typeof updatePluginsBadges === 'function') updatePluginsBadges();
    return true;
  }

  let tries = 0;
  const timer = setInterval(async () => {
    tries++;
    try { if (await install() || tries > 400) clearInterval(timer); } catch (err) { if (tries > 400) clearInterval(timer); }
  }, 50);
})();
