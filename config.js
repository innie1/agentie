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

      if ((!agent.backend_id || !/^[0-9a-fA-F-]{36}$/.test(agent.backend_id)) && typeof window.authedFetch === 'function') {
        try {
          var createRes = await window.authedFetch(window.agentieApiUrl('api/agents'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'General Assistant', goal: text, allowed_plugins: agent.allowed_plugins || [] })
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
        if (typeof window.applyTaskResultToAgent === 'function') window.applyTaskResultToAgent(agent, data.task);
        else {
          agent.isWorking = false;
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

// Direct-first-choice Brain flow.
// The existing UI stays unchanged. When a user clicks A/B/C/D, this capture
// handler prevents the legacy local handler from generating a fake response and
// sends the selection straight to the Agentie Brain/backend instead.
(function installFirstChoiceBrainFlow() {
  var choices = {
    'Work / business': {
      role: 'Work and Business Assistant',
      goal: 'Help the user with work and business. Understand their business or professional needs, identify the most useful specialization, and begin helping immediately.'
    },
    'Personal life': {
      role: 'Personal Life Assistant',
      goal: 'Help the user with personal life, planning, organization, routines, learning, and everyday priorities. Understand the user\'s needs and begin helping immediately.'
    },
    'A mix of both': {
      role: 'Work and Personal Life Assistant',
      goal: 'Help the user across both work/business and personal life. Balance priorities and determine the most useful specialization from the user\'s needs.'
    },
    "I'll tell you": {
      role: 'General Assistant',
      goal: 'The user wants to describe their specific needs. Invite them to explain what they want, but do not generate a fake answer before they do.'
    }
  };

  async function sendChoiceToBrain(choice) {
    var state = window.state;
    var dom = window.dom;
    if (!state || !dom) return;

    if (!state.activeAgentId && typeof window.createNewAgent === 'function') window.createNewAgent();
    var agent = state.agents.find(function(a) { return a.id === state.activeAgentId; });
    if (!agent) return;

    var spec = choices[choice] || { role: 'General Assistant', goal: choice };
    agent.choiceAnswered = true;
    agent.isWorking = true;
    agent.messages = agent.messages || [];
    agent.messages.push({ sender: 'user', text: choice });

    if (dom.chatInput) dom.chatInput.value = '';
    if (typeof window.updateSendButtonState === 'function') window.updateSendButtonState();
    if (typeof window.renderSidebar === 'function') window.renderSidebar();
    if (typeof window.renderMainWorkspace === 'function') window.renderMainWorkspace(agent);

    try {
      var createRes = await window.authedFetch(window.agentieApiUrl('api/agents'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: spec.role,
          goal: spec.goal,
          allowed_plugins: agent.allowed_plugins || []
        })
      });
      var created = await createRes.json();
      if (!createRes.ok || !created.agent) throw new Error(created.error || created.detail || 'Brain agent creation failed');

      agent.backend_id = created.agent.id;
      agent.name = created.agent.name || agent.name;
      agent.name_source = created.agent.name_source || 'auto';
      agent.role = created.agent.role || spec.role;
      agent.goal = created.agent.goal || spec.goal;
      agent.system_prompt = created.agent.system_prompt || agent.system_prompt;
      agent.tags = created.agent.tags || [];

      dom.topAgentTitle.textContent = agent.name;
      dom.chatInput.placeholder = 'Message ' + agent.name;
      if (dom.screenCaptionText) dom.screenCaptionText.textContent = agent.name + "'s screen";

      // Ask the Brain to continue from the user's selection. No locally generated
      // filler response is inserted; the actual backend task supplies the reply.
      var taskInstruction = choice === "I'll tell you"
        ? "The user selected 'I'll tell you'. Do not invent their needs. Ask them what they want this agent to help with, then use their answer to specialize the agent."
        : "The user selected '" + choice + "'. Begin the agent-creation conversation immediately. Do not ask the user to select this category again. Use the category as context and ask only the most useful next question if more detail is needed.";

      var taskRes = await window.authedFetch(window.agentieApiUrl('api/tasks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agent.backend_id, instruction: taskInstruction })
      });
      var taskData = await taskRes.json();
      if (!taskRes.ok || !taskData.task) throw new Error(taskData.error || taskData.detail || 'Brain task submission failed');

      if (typeof window.applyTaskResultToAgent === 'function') {
        window.applyTaskResultToAgent(agent, taskData.task);
      } else {
        agent.isWorking = false;
        agent.messages.push({ sender: 'agent', task_id: taskData.task.id, result_type: taskData.task.result_type || 'fact', result_payload: taskData.task.result_payload || {}, text: taskData.task.result || taskData.task.result_payload?.text || '' });
        if (typeof window.renderMainWorkspace === 'function') window.renderMainWorkspace(agent);
      }
    } catch (err) {
      agent.isWorking = false;
      agent.messages.push({ sender: 'agent', result_type: 'failure', result_payload: { error: err.message }, text: 'Unable to start the Brain: ' + err.message });
      if (typeof window.renderSidebar === 'function') window.renderSidebar();
      if (typeof window.renderMainWorkspace === 'function') window.renderMainWorkspace(agent);
    }
  }

  // Capture phase runs before the legacy row click handler.
  document.addEventListener('click', function(event) {
    var row = event.target && event.target.closest ? event.target.closest('.choice-option-row') : null;
    if (!row) return;
    var choice = row.getAttribute('data-choice');
    if (!choice || !choices[choice]) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    sendChoiceToBrain(choice);
  }, true);
})();
