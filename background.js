/**
 * background.js — Service Worker
 *
 * Queue processor, export engine, IndexedDB manager, message router.
 */

importScripts('db.js');

// ============================================================================
// State
// ============================================================================

let scrapingState = 'idle'; // idle | scraping | paused
let isProcessingQueue = false;
let currentScrapingTabId = null;
let scrapeTimeout = null;
let sessionScrapeCount = 0;
let cooldownUntil = 0; // timestamp

// ============================================================================
// Alarms for Auto-Resume
// ============================================================================

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'RESUME_SCRAPING') {
    console.log('[BG] Alarm: RESUME_SCRAPING triggered');
    handleStartScraping();
  }
});

// ============================================================================
// Side Panel Setup
// ============================================================================

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch(err => console.log('sidePanel behavior error:', err));

// ============================================================================
// Message Router
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    // --- Collection Phase ---
    case 'COLLECTION_UPDATE':
      broadcastToSidepanel({ type: 'COLLECTION_UPDATE', data: message.data });
      break;

    case 'COLLECTION_COMPLETE':
      broadcastToSidepanel({ type: 'COLLECTION_COMPLETE', data: message.data });
      break;

    case 'TWEET_URLS_FOUND':
      handleTweetUrlsFound(message.data, sendResponse);
      return true;

    // --- Scraping Phase ---
    case 'START_SCRAPING':
      handleStartScraping();
      sendResponse({ success: true });
      break;

    case 'PAUSE_SCRAPING':
      handlePauseScraping();
      sendResponse({ success: true });
      break;

    case 'RESUME_SCRAPING':
      handleResumeScraping();
      sendResponse({ success: true });
      break;

    case 'STOP_SCRAPING':
      handleStopScraping();
      sendResponse({ success: true });
      break;

    case 'SCRAPE_COMPLETE':
      handleScrapeComplete(message.data);
      break;

    case 'RATE_LIMIT_EXCEEDED':
      handleRateLimitExceeded();
      break;

    // --- Collection from sidepanel ---
    case 'START_COLLECTING':
      forwardToActiveTab(message);
      break;

    case 'STOP_COLLECTING':
      forwardToActiveTab(message);
      break;

    // --- Queue Operations ---
    case 'GET_QUEUE':
      handleGetQueue(sendResponse);
      return true;

    case 'GET_QUEUE_COUNTS':
      handleGetQueueCounts(sendResponse);
      return true;

    case 'DELETE_QUEUE_ITEMS':
      handleDeleteQueueItems(message.data, sendResponse);
      return true;

    case 'CLEAR_QUEUE':
      handleClearQueue(message.data, sendResponse);
      return true;

    case 'RETRY_FAILED':
      handleRetryFailed(sendResponse);
      return true;

    // --- Export ---
    case 'EXPORT_CSV':
      handleExportCSV(message.data, sendResponse);
      return true;

    case 'EXPORT_JSONL':
      handleExportJSONL(message.data, sendResponse);
      return true;

    case 'EXPORT_API':
      handleExportAPI(message.data, sendResponse);
      return true;

    // --- Settings ---
    case 'GET_SETTINGS':
      handleGetSettings(sendResponse);
      return true;

    case 'SAVE_SETTINGS':
      handleSaveSettings(message.data, sendResponse);
      return true;

    case 'RESET_SETTINGS':
      handleResetSettings(sendResponse);
      return true;

    // --- Projects ---
    case 'GET_PROJECTS':
      handleGetProjects(sendResponse);
      return true;

    case 'CREATE_PROJECT':
      handleCreateProject(message.data, sendResponse);
      return true;

    case 'DELETE_PROJECT':
      handleDeleteProject(message.data, sendResponse);
      return true;

    // --- Status ---
    case 'GET_STATUS':
      sendResponse({
        scrapingState,
        isProcessingQueue
      });
      break;

    default:
      console.log('[BG] Unknown message:', message.type);
  }

  return false;
});

// ============================================================================
// Scraping Queue Processor
// ============================================================================

async function handleStartScraping() {
  if (scrapingState === 'scraping') return;

  // Check cooldown
  if (Date.now() < cooldownUntil) {
    const remaining = Math.ceil((cooldownUntil - Date.now()) / 60000);
    broadcastToSidepanel({ type: 'STATUS_UPDATE', data: { scrapingState: 'rate-limited', cooldownRemaining: remaining } });
    return;
  }

  scrapingState = 'scraping';
  sessionScrapeCount = 0; // Reset session count on explicit start
  broadcastStatus();
  processQueue();
}

async function handleRateLimitExceeded() {
  console.warn('[BG] Rate limit exceeded — pausing all activity');
  
  const settings = await TwitterScraperDB.getAllSettings();
  const minutes = settings.cooldown_minutes || 15;
  
  cooldownUntil = Date.now() + (minutes * 60 * 1000);
  scrapingState = 'paused';
  
  if (scrapeTimeout) {
    clearTimeout(scrapeTimeout);
    scrapeTimeout = null;
  }

  if (currentScrapingTabId) {
    try { await chrome.tabs.remove(currentScrapingTabId); } catch (e) {}
    currentScrapingTabId = null;
  }

  // Set Auto-Resume Alarm
  chrome.alarms.create('RESUME_SCRAPING', { delayInMinutes: minutes });
  console.log('[BG] Set auto-resume alarm for', minutes, 'minutes');

  broadcastToSidepanel({ 
    type: 'STATUS_UPDATE', 
    data: { 
      scrapingState: 'rate-limited', 
      cooldownRemaining: minutes,
      autoResume: true
    } 
  });
}

function handlePauseScraping() {
  scrapingState = 'paused';
  chrome.alarms.clear('RESUME_SCRAPING');
  broadcastStatus();
}

function handleResumeScraping() {
  if (scrapingState !== 'paused') return;
  scrapingState = 'scraping';
  broadcastStatus();
  processQueue();
}

async function handleStopScraping() {
  scrapingState = 'idle';
  isProcessingQueue = false;

  if (scrapeTimeout) {
    clearTimeout(scrapeTimeout);
    scrapeTimeout = null;
  }

  // Close any open scraping tab
  if (currentScrapingTabId) {
    try { await chrome.tabs.remove(currentScrapingTabId); } catch (e) {}
    currentScrapingTabId = null;
  }

  chrome.alarms.clear('RESUME_SCRAPING');
  broadcastStatus();
}

async function processQueue() {
  if (isProcessingQueue) return;
  if (scrapingState !== 'scraping') return;
  isProcessingQueue = true;

  try {
    while (scrapingState === 'scraping') {
      // Check cooldown again
      if (Date.now() < cooldownUntil) {
        handleRateLimitExceeded();
        break;
      }

      // Check session limit
      const settings = await TwitterScraperDB.getAllSettings();
      const activeProjectId = settings.active_project_id || 'default';
      if (sessionScrapeCount >= (settings.session_limit || 50)) {
        console.log('[BG] Session limit reached:', sessionScrapeCount);
        scrapingState = 'paused';
        broadcastToSidepanel({ type: 'STATUS_UPDATE', data: { scrapingState: 'session-limit-reached' } });
        break;
      }

      // Get next queued tweet
      const next = await TwitterScraperDB.getNextQueued(activeProjectId);

      if (!next) {
        console.log('[BG] Queue empty — scraping complete');
        scrapingState = 'idle';
        broadcastToSidepanel({ type: 'SCRAPING_COMPLETE' });
        break;
      }

      // Update status to scraping
      await TwitterScraperDB.updateStatus(activeProjectId, next.url, 'scraping');
      broadcastToSidepanel({
        type: 'QUEUE_ITEM_UPDATE',
        data: { url: next.url, status: 'scraping' }
      });

      // Open tweet in new tab
      const success = await scrapeSingleTweet(next);

      if (success) {
        sessionScrapeCount++;
        broadcastToSidepanel({
          type: 'QUEUE_ITEM_UPDATE',
          data: { url: next.url, status: 'scraped' }
        });
      } else {
        // Check if we should retry
        const maxRetries = settings.max_retries || 2;
        if (next.retry_count < maxRetries) {
          await TwitterScraperDB.updateStatus(activeProjectId, next.url, 'queued');
        }
        broadcastToSidepanel({
          type: 'QUEUE_ITEM_UPDATE',
          data: { url: next.url, status: 'failed' }
        });
      }

      // Check if paused/stopped
      if (scrapingState !== 'scraping') break;

      // Random delay between scrapes
      const minDelay = settings.scrape_delay_min || 2000;
      const maxDelay = settings.scrape_delay_max || 6000;
      const delay = minDelay + Math.random() * (maxDelay - minDelay);

      await new Promise(resolve => {
        scrapeTimeout = setTimeout(resolve, delay);
      });
      scrapeTimeout = null;
    }
  } catch (err) {
    console.error('[BG] Queue processing error:', err);
  } finally {
    isProcessingQueue = false;
    broadcastStatus();
  }
}

function scrapeSingleTweet(queueItem) {
  return new Promise(async (resolve) => {
    const TIMEOUT = 30000;
    let resolved = false;
    let tabId = null;
    const activeProjectId = queueItem.project_id || 'default';

    // Timeout handler
    const timer = setTimeout(async () => {
      if (resolved) return;
      resolved = true;
      console.log('[BG] Scrape timeout for:', queueItem.url);

      await TwitterScraperDB.markFailed(activeProjectId, queueItem.url, 'Timeout — no TweetDetail response received');

      if (tabId) {
        try { await chrome.tabs.remove(tabId); } catch (e) {}
      }
      currentScrapingTabId = null;
      resolve(false);
    }, TIMEOUT);

    // Listen for SCRAPE_COMPLETE from content script
    const listener = async (message, sender) => {
      if (message.type !== 'SCRAPE_COMPLETE') return;
      if (resolved) return;

      const tweetUrl = message.data?.url || message.data?.tweet?.url;
      // Accept if from our tab or if URL matches
      if (sender?.tab?.id !== tabId && tweetUrl !== queueItem.url) return;

      resolved = true;
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);

      const { tweet, replies } = message.data;

      if (tweet) {
        await TwitterScraperDB.saveScrapedData(activeProjectId, queueItem.url, tweet, replies);
        console.log('[BG] Scraped:', tweet.id, '| Replies:', replies?.length || 0);
      } else {
        await TwitterScraperDB.markFailed(activeProjectId, queueItem.url, 'No tweet data in response');
      }

      // Close tab after optional randomized delay
      if (tabId) {
        const settings = await TwitterScraperDB.getAllSettings();
        const minCloseDelay = settings.close_delay_min || 2000;
        const maxCloseDelay = settings.close_delay_max || 5000;
        const closeDelay = minCloseDelay + Math.random() * (maxCloseDelay - minCloseDelay);
        
        console.log(`[BG] Waiting ${Math.round(closeDelay)}ms before closing tab...`);
        await new Promise(resolveClose => setTimeout(resolveClose, closeDelay));

        try { await chrome.tabs.remove(tabId); } catch (e) {}
      }
      currentScrapingTabId = null;
      resolve(!!tweet);
    };

    chrome.runtime.onMessage.addListener(listener);

    // Open the tweet URL
    try {
      // Opening as active: true is often required for Twitter to fire all GraphQL requests
      const tab = await chrome.tabs.create({ url: queueItem.url, active: false });
      tabId = tab.id;
      currentScrapingTabId = tabId;
    } catch (err) {
      resolved = true;
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);

      await TwitterScraperDB.markFailed(activeProjectId, queueItem.url, `Tab creation error: ${err.message}`);
      currentScrapingTabId = null;
      resolve(false);
    }
  });
}

// ============================================================================
// Queue & DB Operations (Background uses chrome.storage-free IndexedDB via helpers)
// ============================================================================

// ============================================================================
// Queue & DB Operations — Active Project Helper
// ============================================================================

async function getActiveProjectId() {
  return await TwitterScraperDB.getSetting('active_project_id') || 'default';
}

async function handleTweetUrlsFound(data, sendResponse) {
  try {
    const activeProjectId = await getActiveProjectId();
    const added = await TwitterScraperDB.addUrlsToQueue(activeProjectId, data.urls, data.sourcePage);
    
    // Notify sidepanel about the new count
    broadcastToSidepanel({
      type: 'COLLECTION_UPDATE',
      data: { count: data.count, newUrls: added }
    });
    
    sendResponse({ success: true, added });
  } catch (err) {
    console.error('[BG] Error adding URLs to queue:', err);
    sendResponse({ success: false, error: err.message });
  }
}

// ============================================================================
// Message Handlers — Queue
// ============================================================================

async function handleGetQueue(sendResponse) {
  try {
    const activeProjectId = await getActiveProjectId();
    const items = await TwitterScraperDB.getAllQueue(activeProjectId);
    sendResponse({ success: true, items });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

async function handleGetQueueCounts(sendResponse) {
  try {
    const activeProjectId = await getActiveProjectId();
    const counts = await TwitterScraperDB.getQueueCounts(activeProjectId);
    sendResponse({ success: true, counts });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

async function handleDeleteQueueItems(data, sendResponse) {
  try {
    const activeProjectId = await getActiveProjectId();
    for (const url of (data.urls || [])) {
      await TwitterScraperDB.deleteFromQueue(activeProjectId, url);
    }
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

async function handleClearQueue(data, sendResponse) {
  try {
    const activeProjectId = await getActiveProjectId();
    if (data?.statusOnly) {
      await TwitterScraperDB.deleteByStatus(activeProjectId, data.statusOnly);
    } else {
      await TwitterScraperDB.clearQueue(activeProjectId);
    }
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

async function handleRetryFailed(sendResponse) {
  try {
    const activeProjectId = await getActiveProjectId();
    const settings = await TwitterScraperDB.getAllSettings();
    const retried = await TwitterScraperDB.retryFailed(activeProjectId, settings.max_retries || 2);
    sendResponse({ success: true, retried });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ============================================================================
// Export — CSV
// ============================================================================

async function handleExportCSV(data, sendResponse) {
  try {
    const activeProjectId = await getActiveProjectId();
    let items;

    if (data?.urls?.length) {
      const all = await TwitterScraperDB.getAllQueue(activeProjectId);
      items = all.filter(i => data.urls.includes(i.url));
    } else {
      items = await TwitterScraperDB.getByStatus(activeProjectId, 'scraped');
    }

    const includeReplies = data?.includeReplies !== false;
    const rows = [];

    for (const item of items) {
      if (item.data) rows.push(tweetToCSVRow(item.data));
      if (includeReplies && item.replies) {
        for (const reply of item.replies) {
          rows.push(tweetToCSVRow(reply));
        }
      }
    }

    const headers = CSV_COLUMNS.map(c => c.header);
    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(escapeCSV).join(','))
    ].join('\n');

    broadcastToSidepanel({
      type: 'CSV_READY',
      data: { csv: csvContent, count: rows.length }
    });

    for (const item of items) {
      if (item.status === 'scraped') {
        await TwitterScraperDB.updateStatus(activeProjectId, item.url, 'exported');
      }
    }

    sendResponse({ success: true, count: rows.length });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

async function handleExportJSONL(data, sendResponse) {
  try {
    const activeProjectId = await getActiveProjectId();
    let items;

    if (data?.urls?.length) {
      const all = await TwitterScraperDB.getAllQueue(activeProjectId);
      items = all.filter(i => data.urls.includes(i.url));
    } else {
      items = await TwitterScraperDB.getByStatus(activeProjectId, 'scraped');
    }

    const includeReplies = data?.includeReplies !== false;
    const jsonlLines = [];

    for (const item of items) {
      if (item.data) jsonlLines.push(JSON.stringify(item.data));
      if (includeReplies && item.replies) {
        for (const reply of item.replies) {
          jsonlLines.push(JSON.stringify(reply));
        }
      }
    }

    const jsonlContent = jsonlLines.length > 0 ? jsonlLines.join('\n') + '\n' : '';

    broadcastToSidepanel({
      type: 'JSONL_READY',
      data: { jsonl: jsonlContent, count: jsonlLines.length }
    });

    for (const item of items) {
      if (item.status === 'scraped') {
        await TwitterScraperDB.updateStatus(activeProjectId, item.url, 'exported');
      }
    }

    sendResponse({ success: true, count: jsonlLines.length });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

const CSV_COLUMNS = [
  { header: 'tweet_id', path: d => d.id },
  { header: 'tweet_url', path: d => d.url },
  { header: 'tweet_text', path: d => d.text },
  { header: 'tweet_lang', path: d => d.lang },
  { header: 'tweet_created_at', path: d => d.created_at },
  { header: 'tweet_source', path: d => d.source },
  { header: 'conversation_id', path: d => d.conversation_id },
  { header: 'author_id', path: d => d.author?.id },
  { header: 'author_username', path: d => d.author?.username },
  { header: 'author_display_name', path: d => d.author?.display_name },
  { header: 'author_bio', path: d => d.author?.bio },
  { header: 'author_location', path: d => d.author?.location },
  { header: 'author_followers', path: d => d.author?.followers_count },
  { header: 'author_following', path: d => d.author?.following_count },
  { header: 'author_tweets', path: d => d.author?.tweet_count },
  { header: 'author_verified', path: d => d.author?.verified },
  { header: 'author_join_date', path: d => d.author?.join_date },
  { header: 'author_website', path: d => d.author?.website_url },
  { header: 'author_avatar', path: d => d.author?.profile_image_url },
  { header: 'views', path: d => d.engagement?.views },
  { header: 'likes', path: d => d.engagement?.likes },
  { header: 'retweets', path: d => d.engagement?.retweets },
  { header: 'replies', path: d => d.engagement?.replies },
  { header: 'quotes', path: d => d.engagement?.quotes },
  { header: 'bookmarks', path: d => d.engagement?.bookmarks },
  { header: 'is_reply', path: d => d.is_reply },
  { header: 'is_retweet', path: d => d.is_retweet },
  { header: 'is_quote', path: d => d.is_quote },
  { header: 'reply_to_tweet_id', path: d => d.in_reply_to_status_id },
  { header: 'reply_to_username', path: d => d.in_reply_to_username },
  { header: 'media_count', path: d => d.media?.length || 0 },
  { header: 'media_types', path: d => (d.media || []).map(m => m.type).join(';') },
  { header: 'media_urls', path: d => (d.media || []).map(m => m.url).join(';') },
  { header: 'hashtags', path: d => (d.hashtags || []).join(';') },
  { header: 'mentions', path: d => (d.mentions || []).map(m => m.username).join(';') },
  { header: 'extracted_at', path: d => d.extracted_at }
];

function tweetToCSVRow(tweet) {
  return CSV_COLUMNS.map(col => {
    const val = col.path(tweet);
    return val === undefined || val === null ? '' : String(val);
  });
}

function escapeCSV(value) {
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// ============================================================================
// Export — API POST
// ============================================================================

async function handleExportAPI(data, sendResponse) {
  try {
    const activeProjectId = await getActiveProjectId();
    const settings = await TwitterScraperDB.getAllSettings();
    const endpoint = settings.api_endpoint;

    if (!endpoint) {
      sendResponse({ success: false, error: 'No API endpoint configured' });
      return;
    }

    let items;
    if (data?.urls?.length) {
      const all = await TwitterScraperDB.getAllQueue(activeProjectId);
      items = all.filter(i => data.urls.includes(i.url));
    } else {
      items = await TwitterScraperDB.getByStatus(activeProjectId, 'scraped');
    }

    const includeReplies = data?.includeReplies !== false;

    const posts = [];
    for (const item of items) {
      if (item.data) posts.push(item.data);
      if (includeReplies && item.replies) {
        posts.push(...item.replies);
      }
    }

    if (posts.length === 0) {
      sendResponse({ success: false, error: 'No posts to export' });
      return;
    }

    const batchSize = settings.api_batch_size || 25;
    const batches = [];
    for (let i = 0; i < posts.length; i += batchSize) {
      batches.push(posts.slice(i, i + batchSize));
    }

    const batchId = generateUUID();
    let successCount = 0;

    for (let i = 0; i < batches.length; i++) {
      broadcastToSidepanel({
        type: 'API_PROGRESS',
        data: { batchNumber: i + 1, totalBatches: batches.length }
      });

      const body = {
        batch_id: batchId,
        batch_number: i + 1,
        total_in_batch: batches[i].length,
        posts: batches[i]
      };

      try {
        const headers = { 'Content-Type': 'application/json' };
        if (settings.api_key) {
          headers['Authorization'] = `Bearer ${settings.api_key}`;
        }

        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body)
        });

        if (response.ok) {
          successCount += batches[i].length;
        } else {
          const errorText = await response.text().catch(() => 'Unknown error');
          broadcastToSidepanel({
            type: 'API_ERROR',
            data: { batch: i + 1, status: response.status, error: errorText }
          });
        }
      } catch (fetchErr) {
        broadcastToSidepanel({
          type: 'API_ERROR',
          data: { batch: i + 1, error: fetchErr.message }
        });
      }
    }

    if (successCount > 0) {
      for (const item of items) {
        if (item.status === 'scraped') {
          await TwitterScraperDB.updateStatus(activeProjectId, item.url, 'exported');
        }
      }
    }

    broadcastToSidepanel({
      type: 'API_COMPLETE',
      data: { successCount, totalPosts: posts.length, batches: batches.length }
    });

    sendResponse({ success: true, sent: successCount });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ============================================================================
// Settings
// ============================================================================

async function handleGetSettings(sendResponse) {
  try {
    const settings = await TwitterScraperDB.getAllSettings();
    sendResponse(settings);
  } catch (err) {
    sendResponse({
      api_endpoint: '', api_key: '', api_batch_size: 25,
      scrape_delay_min: 2000, scrape_delay_max: 6000,
      scroll_interval: 2000, max_scroll_cycles: 100,
      max_retries: 2, include_replies: true
    });
  }
}

async function handleSaveSettings(data, sendResponse) {
  try {
    await TwitterScraperDB.saveAllSettings(data);
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

async function handleResetSettings(sendResponse) {
  try {
    await TwitterScraperDB.resetSettings();
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ============================================================================
// Project Message Handlers
// ============================================================================

async function handleGetProjects(sendResponse) {
  try {
    const projects = await TwitterScraperDB.getProjects();
    sendResponse({ success: true, projects });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

async function handleCreateProject(data, sendResponse) {
  try {
    const project = await TwitterScraperDB.createProject(data.name);
    await TwitterScraperDB.saveSetting('active_project_id', project.id);
    sendResponse({ success: true, project });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

async function handleDeleteProject(data, sendResponse) {
  try {
    await TwitterScraperDB.deleteProject(data.id);
    const active = await getActiveProjectId();
    if (active === data.id) {
      await TwitterScraperDB.saveSetting('active_project_id', 'default');
    }
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ============================================================================
// Communication Helpers
// ============================================================================

function broadcastToSidepanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Side panel may not be open
  });
}

function broadcastStatus() {
  broadcastToSidepanel({
    type: 'STATUS_UPDATE',
    data: { scrapingState, isProcessingQueue }
  });
}

async function forwardToActiveTab(message) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  } catch (e) {}
}

// ============================================================================
// Utility
// ============================================================================

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ============================================================================
// Initialization
// ============================================================================

console.log('[TwitterScraper] Background service worker initialized');
