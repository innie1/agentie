// Agentie frontend API configuration
window.AGENTIE_API_URL = window.AGENTIE_API_URL || 'https://agentie-server-production.up.railway.app';
window.AGENTIE_API_BASE = window.AGENTIE_API_URL;
window.AGENTIE_SUPABASE_URL = window.AGENTIE_SUPABASE_URL || window.SUPABASE_URL || window.NEXT_PUBLIC_SUPABASE_URL || window.VITE_SUPABASE_URL || localStorage.getItem('supabase_url') || 'https://cugaysbdpfzunwwlbfsn.supabase.co';
window.AGENTIE_SUPABASE_ANON_KEY = window.AGENTIE_SUPABASE_ANON_KEY || window.SUPABASE_ANON_KEY || window.NEXT_PUBLIC_SUPABASE_ANON_KEY || window.VITE_SUPABASE_ANON_KEY || localStorage.getItem('supabase_anon_key') || 'sb_publishable_NbRl0ZMqVvVb3Rf4Abs9AQ_D9xsCNQ2';
window.agentieApiUrl = function(path) { var base = window.AGENTIE_API_URL.replace(/\/$/, ''); return base + '/' + String(path || '').replace(/^\//, ''); };

(function loadResponseFormatter() {
  var script = document.createElement('script');
  script.src = '/response-format.js?v=1';
  script.async = true;
  document.head.appendChild(script);
})();

(function loadPluginCompatibilityLayer() {
  var script = document.createElement('script');
  script.src = '/plugin-ui-patch.js?v=2';
  script.async = true;
  document.head.appendChild(script);
})();
