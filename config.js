// Agentie frontend API configuration
window.AGENTIE_API_URL = window.AGENTIE_API_URL || 'https://agentie-server-production.up.railway.app';
window.AGENTIE_API_BASE = window.AGENTIE_API_URL;
window.AGENTIE_SUPABASE_URL = window.AGENTIE_SUPABASE_URL || window.SUPABASE_URL || window.NEXT_PUBLIC_SUPABASE_URL || window.VITE_SUPABASE_URL || localStorage.getItem('supabase_url') || 'https://cugaysbdpfzunwwlbfsn.supabase.co';
window.AGENTIE_SUPABASE_ANON_KEY = window.AGENTIE_SUPABASE_ANON_KEY || window.SUPABASE_ANON_KEY || window.NEXT_PUBLIC_SUPABASE_ANON_KEY || window.VITE_SUPABASE_ANON_KEY || localStorage.getItem('supabase_anon_key') || 'sb_publishable_NbRl0ZMqVvVb3Rf4Abs9AQ_D9xsCNQ2';

window.agentieApiUrl = function(path) {
  var base = window.AGENTIE_API_URL.replace(/\/$/, '');
  var suffix = String(path || '').replace(/^\//, '');
  return base + '/' + suffix;
};

// New-agent first-choice bridge.
// The actual app owns state and handlers inside index.html, so this script
// deliberately does not try to access those private variables. Instead it
// uses the real chat input/send controls, which are wired to the real Brain
// task pipeline. This also prevents the old local choice handler from firing.
(function installFirstChoiceBridge() {
  var handled = false;
  var labels = {
    'work / business': 'Work / business',
    'personal life': 'Personal life',
    'a mix of both': 'A mix of both',
    "i'll tell you": "I'll tell you"
  };

  function normalize(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function getChoice(target) {
    var node = target;
    for (var i = 0; node && i < 6; i++, node = node.parentElement) {
      if (!node.matches || !node.matches('.choice-option-row')) continue;
      var value = normalize(node.getAttribute('data-choice') || node.textContent);
      if (labels[value]) return labels[value];
    }
    return null;
  }

  document.addEventListener('click', function(event) {
    var choice = getChoice(event.target);
    if (!choice || handled) return;

    // Let the UI remain exactly as it is, but replace the old local response
    // with a real chat submission through the existing Brain pipeline.
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    handled = true;

    var input = document.getElementById('chat-input');
    var send = document.getElementById('chat-send-btn');
    if (!input || !send) {
      handled = false;
      console.error('[Agentie] New-agent choice controls are not ready.');
      return;
    }

    input.value = choice;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // The existing index.html send handler owns the real state, persistence,
    // Supabase task creation and Brain worker dispatch.
    setTimeout(function() {
      send.click();
      setTimeout(function() { handled = false; }, 1000);
    }, 0);
  }, true);
})();
