// Agentie response presentation normalizer.
// Keeps model output conversational when raw Markdown markers leak into the DOM.
(function installCleanAgentResponses() {
  function cleanText(value) {
    return String(value || '')
      .replace(/(^|\n)\s*#{1,6}\s+/g, '$1')
      .replace(/\*{2,3}/g, '')
      .replace(/(^|\n)\s*_{2,3}(?=\s|$)/g, '$1')
      .replace(/[ \t]{2,}/g, ' ');
  }

  function cleanResponseRoot(root) {
    if (!root || root.nodeType !== 1) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var nodes = [];
    var node;
    while ((node = walker.nextNode())) nodes.push(node);
    nodes.forEach(function(textNode) {
      var parent = textNode.parentElement;
      if (!parent || /^(CODE|PRE|SCRIPT|STYLE|TEXTAREA|INPUT)$/.test(parent.tagName)) return;
      var cleaned = cleanText(textNode.nodeValue);
      if (cleaned !== textNode.nodeValue) textNode.nodeValue = cleaned;
    });
  }

  function scan() {
    var stream = document.getElementById('chat-stream-container');
    if (!stream) return;
    stream.querySelectorAll('[id$="-body"]').forEach(cleanResponseRoot);
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
