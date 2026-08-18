// Agentie frontend API configuration
// Railway API Server public URL
window.AGENTIE_API_URL = window.AGENTIE_API_URL || 'https://agentie-server-production.up.railway.app';
window.AGENTIE_API_BASE = window.AGENTIE_API_URL;

// Supabase Production Configuration (Public Anon / Publishable variables)
window.AGENTIE_SUPABASE_URL = window.AGENTIE_SUPABASE_URL || window.SUPABASE_URL || window.NEXT_PUBLIC_SUPABASE_URL || window.VITE_SUPABASE_URL || localStorage.getItem('supabase_url') || 'https://cugaysbdpfzunwwlbfsn.supabase.co';
window.AGENTIE_SUPABASE_ANON_KEY = window.AGENTIE_SUPABASE_ANON_KEY || window.SUPABASE_ANON_KEY || window.NEXT_PUBLIC_SUPABASE_ANON_KEY || window.VITE_SUPABASE_ANON_KEY || localStorage.getItem('supabase_anon_key') || 'sb_publishable_NbRl0ZMqVvVb3Rf4Abs9AQ_D9xsCNQ2';

// Helper for building API URLs.
window.agentieApiUrl = function(path) {
  var base = window.AGENTIE_API_URL.replace(/\/$/, '');
  var suffix = String(path || '').replace(/^\//, '');
  return base + '/' + suffix;
};
