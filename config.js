// Agentie frontend API configuration
// Railway Worker public URL
window.AGENTIE_API_URL = 'https://agentie-production.up.railway.app';

// Compatibility bridge for frontend code that still references localhost:4000.
// This provides a single production base URL without changing existing Agentie logic.
window.AGENTIE_API_BASE = window.AGENTIE_API_URL;

// Helper for building Worker API URLs.
window.agentieApiUrl = function(path) {
  var base = window.AGENTIE_API_URL.replace(/\/$/, '');
  var suffix = String(path || '').replace(/^\//, '');
  return base + '/' + suffix;
};
