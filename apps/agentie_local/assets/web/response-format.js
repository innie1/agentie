// Agentie response presentation normalizer + proactive action suggestions.
// Keeps model output conversational and gives long replies comfortable reading rhythm.
(function installCleanAgentResponses() {
  function cleanText(value) {
    return String(value || '')
      .replace(/(^|\n)\s*#{1,6}\s+/g, '$1')
      .replace(/\*{2,3}/g, '')
      .replace(/(^|\n)\s*_{2,3}(?=\s|$)/g, '$1')
      .replace(/[ \t]{2,}/g, ' ');
  }

  function styleResponseRoot(root) {
    if (!root || root.nodeType !== 1) return;
    root.classList.add('agentie-readable-response');
    root.style.whiteSpace = 'pre-wrap';
    root.style.lineHeight = '1.72';
    root.style.overflowWrap = 'anywhere';
    root.style.maxWidth = '760px';
  }

  function cleanResponseRoot(root) {
    if (!root || root.nodeType !== 1) return;
    styleResponseRoot(root);
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var nodes = [];
    var node;
    while ((node = walker.nextNode())) nodes.push(node);
    nodes.forEach(function(textNode) {
      var parent = textNode.parentElement;
      if (!parent || textNode.closest('pre,code,script,style,textarea,input')) return;
      var cleaned = cleanText(textNode.nodeValue);
      if (cleaned !== textNode.nodeValue) textNode.nodeValue = cleaned;
    });
  }

  // Proactive suggestions are deliberately conservative. They appear only when
  // the assistant has just discussed a concrete follow-up action that Agentie can
  // turn into a real task/routine, not after ordinary answers.
  function getSuggestion(text) {
    var t = String(text || '').replace(/<[^>]*>/g, ' ').toLowerCase();
    if (!t || t.length < 80) return null;

    if ((/workout|exercise|training|gym|meal plan|eating plan|diet/).test(t) && (/week|month|routine|schedule|remind|consisten/).test(t)) {
      return {
        label: 'Would you like me to turn this into a routine and remind you to follow it?',
        action: 'Create a recurring routine from the plan in the previous response. Ask the user for the preferred days and time if they were not specified, then create the routine and reminder only after confirmation.',
        accept: 'Create routine'
      };
    }

    if ((/follow up|follow-up|contact again|reach out again|check back/).test(t) && (/next week|tomorrow|next month|remind|schedule/).test(t)) {
      return {
        label: 'Would you like me to create a follow-up reminder for this?',
        action: 'Create a follow-up reminder for the action discussed in the previous response. Ask for the date/time only if it was not specified, then create it after confirmation.',
        accept: 'Create reminder'
      };
    }

    if ((/monitor|keep an eye on|track|watch for|let you know if/).test(t) && (/change|update|important|new/).test(t)) {
      return {
        label: 'Would you like me to monitor this and let you know when something important changes?',
        action: 'Create a monitoring task for the topic discussed in the previous response. Ask for frequency if it is not clear, then create it after confirmation.',
        accept: 'Monitor it'
      };
    }

    if ((/every (day|week|monday|friday)|weekly|daily/).test(t) && (/review|check|report|send|research|update/).test(t)) {
      return {
        label: 'Would you like me to make this a recurring routine?',
        action: 'Create a recurring routine for the recurring work described in the previous response. Ask for the preferred time if it was not specified, then create it after confirmation.',
        accept: 'Create routine'
      };
    }

    return null;
  }

  async function resolveActiveAgentId() {
    try {
      var base = (window.AGENTIE_API_URL || 'https://agentie-production.up.railway.app').replace(/\/$/, '');
      var token = window.AgentieAuth && window.AgentieAuth.getToken ? window.AgentieAuth.getToken() : null;
      var headers = token ? { Authorization: 'Bearer ' + token } : {};
      var res = await fetch(base + '/api/agents', { headers: headers });
      if (!res.ok) return null;
      var data = await res.json();
      var agents = Array.isArray(data.agents) ? data.agents : [];
      var title = (document.getElementById('top-agent-title')?.textContent || '').trim().toLowerCase();
      var match = agents.find(function(a) { return String(a.name || '').trim().toLowerCase() === title; });
      return (match || agents[0])?.id || null;
    } catch (e) {
      return null;
    }
  }

  function addSuggestion(root, suggestion) {
    if (!root || !suggestion || root.querySelector('.agentie-proactive-suggestion')) return;

    var card = document.createElement('div');
    card.className = 'agentie-proactive-suggestion';
    card.style.cssText = 'margin-top:12px;padding:12px 14px;border:1px solid rgba(16,168,255,.25);border-radius:14px;background:rgba(16,168,255,.06);font-size:12px;line-height:1.5;';
    card.innerHTML = `
      <div style="color:var(--text-primary,#f3f3f4);margin-bottom:10px;">${suggestion.label}</div>
      <div style="display:flex;gap:8px;align-items:center;">
        <button type="button" class="agentie-proactive-accept" style="border:0;border-radius:9px;padding:7px 11px;background:#10A8FF;color:#fff;font-weight:600;cursor:pointer;">${suggestion.accept}</button>
        <button type="button" class="agentie-proactive-decline" style="border:1px solid rgba(255,255,255,.12);border-radius:9px;padding:7px 11px;background:transparent;color:inherit;cursor:pointer;">Decline</button>
      </div>`;

    root.appendChild(card);

    card.querySelector('.agentie-proactive-decline').addEventListener('click', function() {
      card.remove();
    });

    card.querySelector('.agentie-proactive-accept').addEventListener('click', async function() {
      var button = this;
      button.disabled = true;
      button.textContent = 'Creating...';
      try {
        var agentId = await resolveActiveAgentId();
        if (!agentId) throw new Error('No saved agent is available for this action.');

        var base = (window.AGENTIE_API_URL || 'https://agentie-production.up.railway.app').replace(/\/$/, '');
        var token = window.AgentieAuth && window.AgentieAuth.getToken ? window.AgentieAuth.getToken() : null;
        var headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = 'Bearer ' + token;

        var res = await fetch(base + '/api/tasks', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({ agent_id: agentId, instruction: suggestion.action })
        });
        var data = await res.json().catch(function() { return {}; });
        if (!res.ok) throw new Error(data.detail || data.error || 'Unable to create the action.');

        card.innerHTML = '<div style="display:flex;align-items:center;gap:7px;color:#4ade80;font-weight:600;"><span>✓</span><span>Done — I created it. Your agent will handle the next step.</span></div>';
      } catch (err) {
        button.disabled = false;
        button.textContent = suggestion.accept;
        var error = document.createElement('div');
        error.style.cssText = 'margin-top:7px;color:#f87171;font-size:11px;';
        error.textContent = err.message || 'Could not create the action.';
        card.appendChild(error);
      }
    });
  }

  function enhanceAgentResponse(root) {
    cleanResponseRoot(root);
    var suggestion = getSuggestion(root.textContent || '');
    if (suggestion) addSuggestion(root, suggestion);
  }

  function scan() {
    var stream = document.getElementById('chat-stream-container');
    if (!stream) return;
    stream.querySelectorAll('[id$="-body"]').forEach(enhanceAgentResponse);
    stream.querySelectorAll('.text-text-primary').forEach(cleanResponseRoot);
  }

  function start() {
    scan();
    var stream = document.getElementById('chat-stream-container');
    if (!stream || !window.MutationObserver) return;
    var observer = new MutationObserver(function() { scan(); });
    observer.observe(stream, { childList: true, subtree: true, characterData: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
