(function installAgentieLocalBridge() {
  'use strict';

  const pending = new Map();

  function nativeBridge() {
    return window.flutter_inappwebview;
  }

  function makeRequestId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `local_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  window.__agentieLocalChunk = function receiveLocalChunk(requestId, token) {
    const request = pending.get(String(requestId));
    if (!request || typeof request.onChunk !== 'function') return;
    request.onChunk(String(token || ''));
  };

  window.AgentieLocal = Object.freeze({
    isAvailable() {
      const bridge = nativeBridge();
      return !!bridge && typeof bridge.callHandler === 'function';
    },

    async status() {
      if (!this.isAvailable()) return { available: false, ready: false };
      return nativeBridge().callHandler('agentieLocal', { action: 'status' });
    },

    async chat(payload, onChunk) {
      if (!this.isAvailable()) {
        throw new Error('The Agentie local runtime is not available in this browser.');
      }
      const requestId = makeRequestId();
      pending.set(requestId, { onChunk });
      try {
        const response = await nativeBridge().callHandler('agentieLocal', {
          action: 'chat',
          requestId,
          payload: payload || {}
        });
        if (response && response.error) throw new Error(response.error);
        return response || {};
      } finally {
        pending.delete(requestId);
      }
    },

    async stop() {
      if (!this.isAvailable()) return;
      return nativeBridge().callHandler('agentieLocal', { action: 'stop' });
    },

    async resetConversation() {
      if (!this.isAvailable()) return;
      return nativeBridge().callHandler('agentieLocal', { action: 'reset' });
    }
  });
})();
