/**
 * content.js — Content Script (ISOLATED WORLD)
 *
 * Phase 1: DOM Tweet URL Discovery + Auto-Scroll
 * Phase 2: Interceptor Bridge (receives TweetDetail from MAIN world)
 * FAB Button for user interaction
 */

(() => {
  'use strict';

  const CHANNEL = '__twitter_scraper_intercepted__';

  // ============================================================================
  // State
  // ============================================================================

  let isCollecting = false;
  let collectedCount = 0;
  let scrollController = null;

  // ============================================================================
  // DOM Tweet URL Discovery
  // ============================================================================

  function discoverTweetUrls() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    const found = [];
    const urlPattern = /^\/([^\/]+)\/status\/(\d+)$/;

    articles.forEach(article => {
      const links = article.querySelectorAll('a[href*="/status/"]');
      links.forEach(link => {
        const href = link.getAttribute('href');
        const match = href?.match(urlPattern);
        if (match) {
          const url = `https://x.com${match[0]}`;
          const tweetId = match[2];
          found.push({ url, tweetId });
        }
      });
    });

    // De-duplicate within this scan
    const unique = [];
    const seen = new Set();
    for (const item of found) {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        unique.push(item);
      }
    }
    return unique;
  }

  // ============================================================================
  // Auto-Scroll Controller
  // ============================================================================

  class AutoScrollController {
    constructor(options = {}) {
      this.isScrolling = false;
      this.scrollDelayMin = options.scrollDelayMin || 1000;
      this.scrollDelayMax = options.scrollDelayMax || 3000;
      this.maxCycles = options.maxCycles || 100;
      this.staleThreshold = options.staleThreshold || 3;
      this.currentCycle = 0;
      this.staleCycles = 0;
      this.lastCount = 0;
      this._aborted = false;
    }

    async start(onNewUrls) {
      this.isScrolling = true;
      this._aborted = false;
      this.currentCycle = 0;
      this.staleCycles = 0;
      this.lastCount = 0;

      while (this.isScrolling && !this._aborted) {
        if (this.currentCycle >= this.maxCycles) {
          console.log('[AutoScroll] Max cycles reached:', this.maxCycles);
          break;
        }

        // Scan DOM for tweet URLs
        const urls = discoverTweetUrls();

        if (urls.length > this.lastCount) {
          this.staleCycles = 0;
        } else {
          this.staleCycles++;
        }

        if (this.staleCycles >= this.staleThreshold) {
          console.log('[AutoScroll] Stale threshold reached — no new tweets for', this.staleThreshold, 'cycles');
          break;
        }

        this.lastCount = urls.length;

        // Notify about discovered URLs
        if (urls.length > 0 && onNewUrls) {
          await onNewUrls(urls);
        }

        // Scroll down
        const scrollAmount = window.innerHeight * 0.8;
        window.scrollBy({
          top: scrollAmount,
          behavior: 'smooth'
        });

        this.currentCycle++;

        // Wait for content to render (Randomized)
        const delay = this.scrollDelayMin + Math.random() * (this.scrollDelayMax - this.scrollDelayMin);
        await this._sleep(delay);
      }

      this.isScrolling = false;
    }

    stop() {
      this._aborted = true;
      this.isScrolling = false;
    }

    _sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }
  }

  // ============================================================================
  // Collection Controller
  // ============================================================================

  async function startCollecting() {
    if (isCollecting) return;
    isCollecting = true;
    collectedCount = 0;

    updateFAB('collecting', 0);

    const settings = await getSettingsFromBackground();
    const sourcePage = window.location.href;

    scrollController = new AutoScrollController({
      scrollDelayMin: settings.scroll_delay_min || 1000,
      scrollDelayMax: settings.scroll_delay_max || 3000,
      maxCycles: settings.max_scroll_cycles || 100,
      staleThreshold: settings.stale_threshold || 3
    });

    const seenUrls = new Set();

    await scrollController.start(async (urls) => {
      const newUrls = urls.filter(u => !seenUrls.has(u.url));
      newUrls.forEach(u => seenUrls.add(u.url));

      if (newUrls.length > 0) {
        // Send to background for storage (since background has the extension-origin IndexedDB)
        chrome.runtime.sendMessage({
          type: 'TWEET_URLS_FOUND',
          data: { urls: newUrls, sourcePage, count: seenUrls.size }
        }, (response) => {
          const added = response?.added || 0;
          collectedCount += added;
          updateFAB('collecting', collectedCount);
        });
      }
    });

    // Collection finished
    isCollecting = false;
    updateFAB('idle', collectedCount);

    chrome.runtime.sendMessage({
      type: 'COLLECTION_COMPLETE',
      data: { totalCollected: collectedCount }
    }).catch(() => {});
  }

  function stopCollecting() {
    if (scrollController) {
      scrollController.stop();
    }
    isCollecting = false;
    updateFAB('idle', collectedCount);
  }

  // ============================================================================
  // Interceptor Bridge — Receives data from MAIN world
  // ============================================================================

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== CHANNEL) return;

    const { url, blobId, data: directData, type: payloadType } = event.data.payload || {};

    if (payloadType === 'RATE_LIMIT_EXCEEDED') {
      chrome.runtime.sendMessage({ type: 'RATE_LIMIT_EXCEEDED' }).catch(() => {});
      return;
    }

    let jsonData = directData;

    // Retrieve from IndexedDB blob store if blobId provided (Legacy/External)
    if (blobId && !jsonData) {
      try {
        // NOTE: This usually fails if the blob was stored in the MAIN world's partition
        jsonData = await TwitterScraperDB.getBlob(blobId);
        if (jsonData) {
          await TwitterScraperDB.deleteBlob(blobId);
        }
      } catch (e) {
        console.error('[Bridge] Failed to retrieve blob:', e);
      }
    }

    if (!jsonData) {
      console.warn('[Bridge] Received intercept message but no data found (Direct or Blob)');
      return;
    }

    if (jsonData._error === 'SerializationFailed') {
      console.error('[Bridge] Network Interceptor failed to serialize response. Keys:', jsonData.keys);
      return;
    }

    // Parse the TweetDetail response
    const { tweet, replies } = TweetParser.parseTweetDetailResponse(jsonData);

    if (tweet) {
      // Send scraped data to background service worker
      chrome.runtime.sendMessage({
        type: 'SCRAPE_COMPLETE',
        data: {
          url: tweet.url || url,
          tweet,
          replies
        }
      }).catch(err => {
        console.error('[Bridge] Failed to send SCRAPE_COMPLETE:', err);
      });

      console.log('[Bridge] TweetDetail parsed:', tweet.id, '| Replies:', replies.length);
    } else {
      console.log('[Bridge] TweetDetail received but no root tweet found in response');
    }
  });

  // ============================================================================
  // FAB (Floating Action Button)
  // ============================================================================

  let fabElement = null;

  function createFAB() {
    if (fabElement) return;

    fabElement = document.createElement('div');
    fabElement.id = 'tweet-scraper-fab';
    fabElement.innerHTML = `
      <button id="fab-btn" title="Collect Tweets">
        <svg class="fab-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/>
          <path d="M21 21l-4.35-4.35"/>
        </svg>
        <span class="fab-label">Collect</span>
      </button>
      <div class="fab-badge" id="fab-badge" style="display:none">0</div>
    `;
    document.body.appendChild(fabElement);

    document.getElementById('fab-btn').addEventListener('click', () => {
      if (isCollecting) {
        stopCollecting();
      } else {
        startCollecting();
      }
    });
  }

  function updateFAB(state, count = 0) {
    if (!fabElement) return;

    const btn = fabElement.querySelector('#fab-btn');
    const badge = fabElement.querySelector('#fab-badge');
    const label = fabElement.querySelector('.fab-label');

    fabElement.className = '';

    switch (state) {
      case 'collecting':
        fabElement.classList.add('fab-collecting');
        label.textContent = 'Stop';
        badge.textContent = `${count} found`;
        badge.style.display = 'block';
        break;
      case 'scraping':
        fabElement.classList.add('fab-scraping');
        label.textContent = 'Scraping';
        badge.textContent = count;
        badge.style.display = 'block';
        break;
      default:
        fabElement.classList.add('fab-idle');
        label.textContent = 'Collect';
        if (count > 0) {
          badge.textContent = `${count} collected`;
          badge.style.display = 'block';
        } else {
          badge.style.display = 'none';
        }
    }
  }

  // ============================================================================
  // Message Handler — receives commands from sidepanel/background
  // ============================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'START_COLLECTING':
        startCollecting();
        sendResponse({ success: true });
        break;

      case 'STOP_COLLECTING':
        stopCollecting();
        sendResponse({ success: true });
        break;

      case 'GET_COLLECTION_STATUS':
        sendResponse({
          isCollecting,
          count: collectedCount
        });
        break;

      case 'PING':
        sendResponse({ pong: true });
        break;

      default:
        break;
    }
    return false;
  });

  // ============================================================================
  // Helpers
  // ============================================================================

  function getSettingsFromBackground() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (response) => {
        resolve(response || TwitterScraperDB.DEFAULT_SETTINGS);
      });
    });
  }

  // ============================================================================
  // Initialize
  // ============================================================================

  function init() {
    // Only init on Twitter/X pages
    if (!window.location.hostname.match(/(twitter\.com|x\.com)$/)) return;

    createFAB();

    // Clean up old blobs periodically
    setInterval(() => TwitterScraperDB.clearOldBlobs(60000), 30000);

    console.log('[TwitterScraper] Content script initialized');
  }

  // Wait for DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
