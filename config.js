// Agentie frontend API configuration
// Railway API Server public URL
window.AGENTIE_API_URL = window.AGENTIE_API_URL || 'https://agentie-server-production.up.railway.app';
window.AGENTIE_API_BASE = window.AGENTIE_API_URL;

// Supabase Production Configuration (Public Anon / Publishable variables)
window.AGENTIE_SUPABASE_URL = window.AGENTIE_SUPABASE_URL || window.SUPABASE_URL || window.NEXT_PUBLIC_SUPABASE_URL || window.VITE_SUPABASE_URL || localStorage.getItem('supabase_url') || 'https://cugaysbdpfzunwwlbfsn.supabase.co';
window.AGENTIE_SUPABASE_ANON_KEY = window.AGENTIE_SUPABASE_ANON_KEY || window.SUPABASE_ANON_KEY || window.NEXT_PUBLIC_SUPABASE_ANON_KEY || window.VITE_SUPABASE_ANON_KEY || localStorage.getItem('supabase_anon_key') || 'sb_publishable_NbRl0ZMqVvVb3Rf4Abs9AQ_D9xsCNQ2';

window.agentieApiUrl = function(path) {
  var base = window.AGENTIE_API_URL.replace(/\/$/, '');
  var suffix = String(path || '').replace(/^\//, '');
  return base + '/' + suffix;
};

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
      if (!text || actionWords.test(text) || text.length > 280 || !simpleChat.test(text)) return originalSend(customPrompt);
      var state = window.state;
      var dom = window.dom;
      if (!state || !dom) return originalSend(customPrompt);
      if (!state.activeAgentId && typeof window.createNewAgent === 'function') window.createNewAgent();
      var agent = state.agents.find(function(a) { return a.id === state.activeAgentId; });
      if (!agent) return originalSend(customPrompt);
      agent.choiceAnswered = true;
      if ((!agent.backend_id || !/^[0-9a-fA-F-]{36}$/.test(agent.backend_id)) && typeof window.authedFetch === 'function') {
        try {
          var createRes = await window.authedFetch(window.agentieApiUrl('api/agents'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'General Assistant', goal: text, allowed_plugins: agent.allowed_plugins || [] }) });
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
        } catch (e) { console.warn('[Agentie] Brain agent creation failed:', e.message); }
      }
      agent.messages.push({ sender: 'user', text: text });
      agent.isWorking = true;
      if (dom.chatInput && !customPrompt) dom.chatInput.value = '';
      if (typeof window.updateSendButtonState === 'function') window.updateSendButtonState();
      if (typeof window.renderSidebar === 'function') window.renderSidebar();
      if (typeof window.renderMainWorkspace === 'function') window.renderMainWorkspace(agent);
      try {
        if (!agent.backend_id) throw new Error('Agent backend record is not ready');
        var res = await window.authedFetch(window.agentieApiUrl('api/tasks'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_id: agent.backend_id, instruction: text }) });
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

// Direct-first-choice Brain flow.
// Capture the existing choice UI without requiring a particular CSS class or
// data attribute. The previous implementation required .choice-option-row and
// data-choice, which did not match the actual rendered controls and caused taps
// to do nothing.
(function installFirstChoiceBrainFlow() {
  var busy = false;

  function getChoiceFromElement(el) {
    var raw = '';
    if (el) {
      raw = [el.getAttribute && el.getAttribute('data-choice'), el.getAttribute && el.getAttribute('aria-label'), el.textContent].filter(Boolean).join(' ');
    }
    raw = raw.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!raw) return null;
    if (/work\s*(\/|and|&)\s*business|work.*business|business.*work/.test(raw)) return 'Work / business';
    if (/personal\s*life|personal/.test(raw)) return 'Personal life';
    if (/mix\s*(of)?\s*both|both/.test(raw)) return 'A mix of both';
    if (/i.?ll\s*tell\s*you|tell\s*you|something\s*specific|specific/.test(raw)) return "I'll tell you";
    return null;
  }

  async function sendChoiceToBrain(choice) {
    if (busy) return;
    busy = true;
    var state = window.state;
    var dom = window.dom;
    try {
      if (!state || !dom) throw new Error('Agentie UI is not ready yet. Please try again.');
      if (!state.activeAgentId && typeof window.createNewAgent === 'function') window.createNewAgent();
      var agent = state.agents.find(function(a) { return a.id === state.activeAgentId; });
      if (!agent) throw new Error('Unable to create the new agent. Please reopen New Agentie.');

      var specs = {
        'Work / business': { role: 'Work and Business Assistant', goal: 'Help the user with work and business. Understand their business or professional needs, identify the most useful specialization, and begin helping immediately.' },
        'Personal life': { role: 'Personal Life Assistant', goal: 'Help the user with personal life, planning, organization, routines, learning, and everyday priorities. Understand the user needs and begin helping immediately.' },
        'A mix of both': { role: 'Work and Personal Life Assistant', goal: 'Help the user across both work/business and personal life. Balance priorities and determine the most useful specialization from the user needs.' },
        "I'll tell you": { role: 'General Assistant', goal: 'The user wants to describe their specific needs. Ask them what they want this agent to help with and do not invent their needs.' }
      };
      var spec = specs[choice];
      agent.choiceAnswered = true;
      agent.isWorking = true;
      agent.messages = agent.messages || [];
      agent.messages.push({ sender: 'user', text: choice });
      if (dom.chatInput) dom.chatInput.value = '';
      if (typeof window.updateSendButtonState === 'function') window.updateSendButtonState();
      if (typeof window.renderSidebar === 'function') window.renderSidebar();
      if (typeof window.renderMainWorkspace === 'function') window.renderMainWorkspace(agent);

      var createRes = await window.authedFetch(window.agentieApiUrl('api/agents'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: spec.role, goal: spec.goal, allowed_plugins: agent.allowed_plugins || [] }) });
      var created = await createRes.json();
      if (!createRes.ok || !created.agent) throw new Error(created.error || created.detail || 'Brain agent creation failed');

      agent.backend_id = created.agent.id;
      agent.name = created.agent.name || agent.name;
      agent.name_source = created.agent.name_source || 'auto';
      agent.role = created.agent.role || spec.role;
      agent.goal = created.agent.goal || spec.goal;
      agent.system_prompt = created.agent.system_prompt || agent.system_prompt;
      agent.tags = created.agent.tags || [];
      if (dom.topAgentTitle) dom.topAgentTitle.textContent = agent.name;
      if (dom.chatInput) dom.chatInput.placeholder = 'Message ' + agent.name;
      if (dom.screenCaptionText) dom.screenCaptionText.textContent = agent.name + "'s screen";

      var instruction = choice === "I'll tell you"
        ? "The user selected 'I'll tell you'. Ask them what they want this agent to help with. Do not invent their requirements."
        : "The user selected '" + choice + "'. Start the agent-creation conversation immediately. Do not ask them to select this category again. Ask only the most useful next question if needed.";
      var taskRes = await window.authedFetch(window.agentieApiUrl('api/tasks'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_id: agent.backend_id, instruction: instruction }) });
      var taskData = await taskRes.json();
      if (!taskRes.ok || !taskData.task) throw new Error(taskData.error || taskData.detail || 'Brain task submission failed');
      if (typeof window.applyTaskResultToAgent === 'function') window.applyTaskResultToAgent(agent, taskData.task);
      else {
        agent.isWorking = false;
        agent.messages.push({ sender: 'agent', task_id: taskData.task.id, result_type: taskData.task.result_type || 'fact', result_payload: taskData.task.result_payload || {}, text: taskData.task.result || taskData.task.result_payload?.text || '' });
        if (typeof window.renderMainWorkspace === 'function') window.renderMainWorkspace(agent);
      }
    } catch (err) {
      if (state && state.activeAgentId) {
        var failed = state.agents.find(function(a) { return a.id === state.activeAgentId; });
        if (failed) {
          failed.isWorking = false;
          failed.messages = failed.messages || [];
          failed.messages.push({ sender: 'agent', result_type: 'failure', result_payload: { error: err.message }, text: 'Unable to start the Brain: ' + err.message });
          if (typeof window.renderSidebar === 'function') window.renderSidebar();
          if (typeof window.renderMainWorkspace === 'function') window.renderMainWorkspace(failed);
        }
      }
      console.error('[Agentie] first-choice Brain flow failed:', err);
    } finally {
      busy = false;
    }
  }

  document.addEventListener('click', function(event) {
    var node = event.target;
    var choice = null;
    for (var i = 0; node && i < 5; i++, node = node.parentElement) {
      choice = getChoiceFromElement(node);
      if (choice) break;
    }
    if (!choice) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    sendChoiceToBrain(choice);
  }, true);
})();
