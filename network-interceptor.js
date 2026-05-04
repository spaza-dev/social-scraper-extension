/**
 * Network Interceptor — MAIN WORLD
 *
 * Runs in the page's JavaScript context (world: "MAIN") to monkey-patch
 * window.fetch and intercept TweetDetail GraphQL responses.
 *
 * Cannot use chrome.* APIs — communicates via window.postMessage + IndexedDB.
 */

(function () {
  'use strict';

  const CHANNEL = '__twitter_scraper_intercepted__';

  // ============================================================================
  // Intercept fetch
  // ============================================================================

  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const request = args[0];
    const url = typeof request === 'string' ? request : request?.url || '';

    try {
      const response = await originalFetch.apply(window, args);

      if (response.status === 429) {
        console.warn('[NetworkInterceptor] Rate limit hit (429)!');
        window.postMessage({ type: CHANNEL, payload: { type: 'RATE_LIMIT_EXCEEDED', timestamp: Date.now() } }, '*');
      }

      if (url.includes('/i/api/graphql/')) {
        console.log('[NetworkInterceptor] GraphQL Fetch:', url);
        if (shouldIntercept(url)) {
          console.log('[NetworkInterceptor] Intercepting:', url);
          const cloned = response.clone();
          cloned.text().then(text => {
            try {
              const json = JSON.parse(text);
              safePostMessage(url, json);
            } catch (e) { /* not JSON — ignore */ }
          }).catch(() => {});
        }
      }

      return response;
    } catch (error) {
      throw error;
    }
  };

  // ============================================================================
  // Intercept XHR (Fallback for some scenarios)
  // ============================================================================

  const originalXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new originalXHR();
    const originalOpen = xhr.open;
    let requestUrl = '';

    xhr.open = function(method, url) {
      requestUrl = url;
      return originalOpen.apply(this, arguments);
    };

    xhr.addEventListener('load', function() {
      if (xhr.status === 429) {
        console.warn('[NetworkInterceptor] Rate limit hit (429) via XHR!');
        window.postMessage({ type: CHANNEL, payload: { type: 'RATE_LIMIT_EXCEEDED', timestamp: Date.now() } }, '*');
      }
      if (shouldIntercept(requestUrl)) {
        console.log('[NetworkInterceptor] GraphQL XHR captured:', requestUrl);
        try {
          const json = JSON.parse(xhr.responseText);
          safePostMessage(requestUrl, json);
        } catch (e) {}
      }
    });

    return xhr;
  }
  window.XMLHttpRequest = PatchedXHR;

  // ============================================================================
  // URL Matching
  // ============================================================================

  function shouldIntercept(url) {
    if (!url || typeof url !== 'string') return false;
    if (!url.includes('/i/api/graphql/')) return false;
    
    // Intercept multiple tweet detail endpoints
    return url.includes('TweetDetail') || 
           url.includes('TweetResultByRestId') ||
           url.includes('TweetDetailWithInjections');
  }

  // ============================================================================
  // Safe Post Message
  // ============================================================================

  /**
   * Send the intercepted data to the ISOLATED world (content.js) via postMessage.
   */
  function safePostMessage(url, data) {
    try {
      window.postMessage({
        type: CHANNEL,
        payload: { 
          url, 
          data,
          timestamp: Date.now()
        }
      }, '*');
      console.log('[NetworkInterceptor] Captured data sent to bridge:', url);
    } catch (e) {
      console.error('[NetworkInterceptor] postMessage error:', e);
    }
  }

  console.log('[NetworkInterceptor] Installed (v1.2.1) — intercepting GraphQL (Fetch & XHR)');
})();
