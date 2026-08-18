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

// The legacy frontend sends every message to Supabase's tasks surface. Route
// that single write through /api/tasks so its existing classifier can send
// normal conversation to fastChat without creating a task row. Real task
// reads and explicit task inserts remain backed by Supabase.
(function installConversationBridge() {
  var installed = false, originalGetClient, chatResults = new Map();
  function headers() {
    var h={'Content-Type':'application/json'};
    try { var token=window.AgentieAuth&&window.AgentieAuth.getToken?window.AgentieAuth.getToken():null; if(token) h.Authorization='Bearer '+token; } catch(_){}
    return h;
  }
  function chatChain(payload, realClient) {
    var chain={}, promise=null, id='chat_'+Date.now()+'_'+Math.random().toString(36).slice(2,8);
    function execute() {
      if(promise) return promise;
      promise=(async function(){
        var res=await fetch(window.agentieApiUrl('api/tasks'),{method:'POST',headers:headers(),body:JSON.stringify({agent_id:payload.agent_id,instruction:payload.instruction,history:[]})});
        var data=await res.json().catch(function(){return {};});
        if(!res.ok) throw new Error(data.error||data.detail||('Chat request failed ('+res.status+')'));
        if(data.task) return {data:data.task,error:null};
        var chat=data.chat||{}, task={id:id,status:'done',instruction:payload.instruction||'',result_type:chat.result_type||'chat_response',result_payload:{text:chat.result||''}};
        chatResults.set(id,task);
        return {data:task,error:null};
      })();
      return promise;
    }
    chain.insert=function(){return chain;}; chain.select=function(){return chain;}; chain.single=function(){return execute();};
    return chain;
  }
  function wrap(client) {
    if(!client) return client;
    return new Proxy(client,{get:function(target,prop,receiver){
      if(prop!=='from') return Reflect.get(target,prop,receiver);
      return function(table){
        if(table!=='tasks') return target.from(table);
        return {
          insert:function(payload){return chatChain(payload||{},target);},
          select:function(){
            var realQuery=target.from('tasks').select.apply(target.from('tasks'),arguments), q={id:null};
            q.eq=function(column,id){q.id=id; return q;};
            q.single=async function(){
              if(q.id && chatResults.has(q.id)) return {data:chatResults.get(q.id),error:null};
              return realQuery.eq.apply(realQuery,['id',q.id]).single();
            };
            return q;
          }
        };
      };
    }});
  }
  var timer=setInterval(function(){
    try {
      if(!installed && typeof window.getSupabaseClient==='function') { originalGetClient=window.getSupabaseClient; window.getSupabaseClient=function(){return wrap(originalGetClient());}; installed=true; console.log('[Agentie] normal-chat/task routing bridge installed'); }
      if(installed) clearInterval(timer);
    } catch(e){ console.warn('[Agentie] routing bridge:',e.message); }
  },50);
  setTimeout(function(){clearInterval(timer);},20000);
})();

// Load the response-only presentation normalizer without changing the UI.
(function loadResponseFormatter() {
  var script = document.createElement('script');
  script.src = '/response-format.js?v=1';
  script.async = true;
  document.head.appendChild(script);
})();
