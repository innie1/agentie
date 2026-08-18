// Agentie frontend API configuration
window.AGENTIE_API_URL = window.AGENTIE_API_URL || 'https://agentie-server-production.up.railway.app';
window.AGENTIE_API_BASE = window.AGENTIE_API_URL;
window.AGENTIE_SUPABASE_URL = window.AGENTIE_SUPABASE_URL || window.SUPABASE_URL || window.NEXT_PUBLIC_SUPABASE_URL || window.VITE_SUPABASE_URL || localStorage.getItem('supabase_url') || 'https://cugaysbdpfzunwwlbfsn.supabase.co';
window.AGENTIE_SUPABASE_ANON_KEY = window.AGENTIE_SUPABASE_ANON_KEY || window.SUPABASE_ANON_KEY || window.NEXT_PUBLIC_SUPABASE_ANON_KEY || window.VITE_SUPABASE_ANON_KEY || localStorage.getItem('supabase_anon_key') || 'sb_publishable_NbRl0ZMqVvVb3Rf4Abs9AQ_D9xsCNQ2';
window.agentieApiUrl = function(path) { var base = window.AGENTIE_API_URL.replace(/\/$/, ''); return base + '/' + String(path || '').replace(/^\//, ''); };

(function installFirstChoiceBridge() {
  var handled = false;
  var labels = { 'work / business':'Work / business', 'personal life':'Personal life', 'a mix of both':'A mix of both', "i'll tell you":"I'll tell you" };
  function normalize(s) { return String(s || '').replace(/\s+/g,' ').trim().toLowerCase(); }
  function getChoice(target) {
    var node = target;
    for (var i=0; node && i<6; i++, node=node.parentElement) {
      if (!node.matches || !node.matches('.choice-option-row')) continue;
      var value = normalize(node.getAttribute('data-choice') || node.textContent);
      if (labels[value]) return labels[value];
    }
    return null;
  }
  document.addEventListener('click', function(event) {
    var choice = getChoice(event.target);
    if (!choice || handled) return;
    event.preventDefault(); event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    handled = true;
    var input = document.getElementById('chat-input'), send = document.getElementById('chat-send-btn');
    if (!input || !send) { handled = false; return; }
    input.value = choice;
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
    setTimeout(function(){ send.click(); setTimeout(function(){handled=false;},1000); },0);
  }, true);
})();

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
