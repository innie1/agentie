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

// Runtime compatibility fixes for the legacy single-file frontend.
// The UI keeps a stable local agent id while backend_id stores the Supabase UUID.
// This prevents the first successful persistence from breaking the next Send click.
(function installAgentieRuntimeFixes() {
  var installed = false;
  var timer = setInterval(function () {
    if (installed || typeof window.persistAgentToBackend !== 'function' || typeof window.handleSendMessage !== 'function') return;
    installed = true;
    clearInterval(timer);

    var originalPersist = window.persistAgentToBackend;
    window.persistAgentToBackend = async function(agent) {
      if (!agent) return;
      var stableId = agent.id;
      var result = await originalPersist(agent);
      // The legacy function accidentally replaces agent.id with the backend UUID.
      // Restore the stable UI id and keep the real UUID in backend_id.
      if (stableId && agent.backend_id) agent.id = stableId;
      if (window.state && window.state.activeAgentId) window.state.activeAgentId = stableId || window.state.activeAgentId;
      return result;
    };

    var originalSend = window.handleSendMessage;
    var simpleChat = /^(hi|hello|hey|yo|good morning|good afternoon|good evening|thanks|thank you|ok|okay|what|why|how|when|where|who|can you|could you|tell me|explain|help me understand|is |are |do |does |will |would |should |i |my )/i;
    var actionWords = /\b(create|build|make|start|launch|deploy|send|delete|remove|update|change|edit|research|find|search|analy[sz]e|plan|schedule|book|buy|pay|publish|post|email|message|call|delegate|assign|automate|run|execute|organize|organise|generate a report|set up|setup)\b/i;

    window.handleSendMessage = async function(customPrompt) {
      var text = customPrompt ? decodeURIComponent(customPrompt) : (window.dom && window.dom.chatInput ? window.dom.chatInput.value.trim() : '');
      if (!text || actionWords.test(text) || text.length > 280 || !simpleChat.test(text)) {
        return originalSend(customPrompt);
      }

      var state = window.state;
      var dom = window.dom;
      if (!state || !dom) return originalSend(customPrompt);

      if (!state.activeAgentId && typeof window.createNewAgent === 'function') window.createNewAgent();
      var agent = state.agents.find(function(a) { return a.id === state.activeAgentId; });
      if (!agent) return originalSend(customPrompt);

      agent.choiceAnswered = true;

      // Let the Brain/server own the first real agent name instead of hard-coding one locally.
      if ((!agent.backend_id || !/^[0-9a-fA-F-]{36}$/.test(agent.backend_id)) && typeof window.authedFetch === 'function') {
        try {
          var createRes = await window.authedFetch(window.agentieApiUrl('api/agents'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              role: 'General Assistant',
              goal: text,
              allowed_plugins: agent.allowed_plugins || []
            })
          });
          if (createRes.ok) {
            var created = await createRes.json();
            if (created.agent) {
              agent.backend_id = created.agent.id;
              agent.name = created.agent.name || agent.name;
              agent.name_source = created.agent.name_source || 'auto';
              agent.role = created.agent.role || agent.role;
              agent.goal = created.agent.goal || agent.goal;
              agent.system_prompt = created.agent.system_prompt || agent.system_prompt;
              dom.topAgentTitle.textContent = agent.name;
              dom.chatInput.placeholder = 'Message ' + agent.name;
              if (dom.screenCaptionText) dom.screenCaptionText.textContent = agent.name + "'s screen";
            }
          }
        } catch (e) {
          console.warn('[Agentie] Brain agent creation failed:', e.message);
        }
      }

      agent.messages.push({ sender: 'user', text: text });
      agent.isWorking = true;
      if (dom.chatInput && !customPrompt) dom.chatInput.value = '';
      if (typeof window.updateSendButtonState === 'function') window.updateSendButtonState();
      if (typeof window.renderSidebar === 'function') window.renderSidebar();
      if (typeof window.renderMainWorkspace === 'function') window.renderMainWorkspace(agent);

      try {
        if (!agent.backend_id) throw new Error('Agent backend record is not ready');
        var res = await window.authedFetch(window.agentieApiUrl('api/tasks'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: agent.backend_id, instruction: text })
        });
        var data = await res.json();
        if (!res.ok || !data.task) throw new Error(data.error || data.detail || 'Chat request failed');
        agent.isWorking = false;
        if (typeof window.applyTaskResultToAgent === 'function') window.applyTaskResultToAgent(agent, data.task);
        else {
          agent.messages.push({ sender: 'agent', task_id: data.task.id, result_type: data.task.result_type || 'fact', result_payload: data.task.result_payload || {}, text: data.task.result || data.task.result_payload?.text || '' });
          if (typeof window.renderMainWorkspace === 'function') window.renderMainWorkspace(agent);
        }
      } catch (err) {
        agent.isWorking = false;
        agent.messages.push({ sender: 'agent', result_type: 'failure', result_payload: { error: err.message }, text: 'Chat failed: ' + err.message });
        if (typeof window.renderSidebar === 'function') window.renderSidebar();
        if (typeof window.renderMainWorkspace === 'function') window.renderMainWorkspace(agent);
      }
    };
  }, 50);
})();
