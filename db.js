/**
 * db.js — IndexedDB Helper for TwitterScraperDB
 *
 * Stores:
 *   tweet_queue       — pipeline items (keyPath: url)
 *   intercepted_blobs — ephemeral MAIN→ISOLATED transfer (keyPath: id)
 *   settings          — user preferences (keyPath: key)
 */

const TwitterScraperDB = (() => {
  const DB_NAME = 'TwitterScraperDB';
  const DB_VERSION = 1;

  const STORES = {
    QUEUE: 'tweet_queue',
    BLOBS: 'intercepted_blobs',
    SETTINGS: 'settings'
  };

  const DEFAULT_SETTINGS = {
    api_endpoint: '',
    api_key: '',
    api_batch_size: 25,
    scrape_delay_min: 2000,
    scrape_delay_max: 6000,
    scroll_delay_min: 1000,
    scroll_delay_max: 3000,
    max_scroll_cycles: 100,
    max_retries: 2,
    include_replies: true,
    stale_threshold: 3,
    session_limit: 50,
    cooldown_minutes: 15,
    close_delay_min: 2000,
    close_delay_max: 5000
  };

  let dbInstance = null;

  // ============================================================================
  // Database Connection
  // ============================================================================

  function open() {
    if (dbInstance) return Promise.resolve(dbInstance);
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // tweet_queue store
        if (!db.objectStoreNames.contains(STORES.QUEUE)) {
          const queueStore = db.createObjectStore(STORES.QUEUE, { keyPath: 'url' });
          queueStore.createIndex('by_status', 'status', { unique: false });
          queueStore.createIndex('by_discovered', 'discovered_at', { unique: false });
          queueStore.createIndex('by_tweet_id', 'tweet_id', { unique: false });
        }

        // intercepted_blobs store
        if (!db.objectStoreNames.contains(STORES.BLOBS)) {
          db.createObjectStore(STORES.BLOBS, { keyPath: 'id' });
        }

        // settings store
        if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
          db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
        }
      };

      request.onsuccess = () => {
        dbInstance = request.result;
        resolve(dbInstance);
      };

      request.onerror = () => reject(request.error);
    });
  }

  // ============================================================================
  // Generic Helpers
  // ============================================================================

  async function _tx(storeName, mode = 'readonly') {
    const db = await open();
    const tx = db.transaction(storeName, mode);
    return tx.objectStore(storeName);
  }

  function _request(idbRequest) {
    return new Promise((resolve, reject) => {
      idbRequest.onsuccess = () => resolve(idbRequest.result);
      idbRequest.onerror = () => reject(idbRequest.error);
    });
  }

  // ============================================================================
  // Tweet Queue Operations
  // ============================================================================

  async function addToQueue(url, tweetId, sourcePage) {
    const store = await _tx(STORES.QUEUE, 'readwrite');
    const existing = await _request(store.get(url));
    if (existing) return false; // duplicate

    const entry = {
      url,
      tweet_id: tweetId,
      status: 'queued',
      discovered_at: new Date().toISOString(),
      scraped_at: null,
      exported_at: null,
      error: null,
      retry_count: 0,
      data: null,
      replies: null,
      source_page: sourcePage
    };

    // Need a fresh transaction since previous one may have committed
    const writeStore = await _tx(STORES.QUEUE, 'readwrite');
    await _request(writeStore.put(entry));
    return true;
  }

  async function addUrlsToQueue(urls, sourcePage) {
    const db = await open();
    const tx = db.transaction(STORES.QUEUE, 'readwrite');
    const store = tx.objectStore(STORES.QUEUE);
    let added = 0;

    for (const { url, tweetId } of urls) {
      const existing = await _request(store.get(url));
      if (!existing) {
        store.put({
          url,
          tweet_id: tweetId,
          status: 'queued',
          discovered_at: new Date().toISOString(),
          scraped_at: null,
          exported_at: null,
          error: null,
          retry_count: 0,
          data: null,
          replies: null,
          source_page: sourcePage
        });
        added++;
      }
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(added);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getByStatus(status) {
    const store = await _tx(STORES.QUEUE);
    const index = store.index('by_status');
    return _request(index.getAll(status));
  }

  async function getNextQueued() {
    const store = await _tx(STORES.QUEUE);
    const index = store.index('by_status');
    return new Promise((resolve, reject) => {
      const request = index.openCursor('queued');
      request.onsuccess = () => {
        const cursor = request.result;
        resolve(cursor ? cursor.value : null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function updateStatus(url, status, extra = {}) {
    const store = await _tx(STORES.QUEUE, 'readwrite');
    const entry = await _request(store.get(url));
    if (!entry) return false;

    entry.status = status;
    Object.assign(entry, extra);

    if (status === 'scraped') entry.scraped_at = new Date().toISOString();
    if (status === 'exported') entry.exported_at = new Date().toISOString();

    await _request(store.put(entry));
    return true;
  }

  async function saveScrapedData(url, data, replies) {
    const store = await _tx(STORES.QUEUE, 'readwrite');
    const entry = await _request(store.get(url));
    if (!entry) return false;

    entry.status = 'scraped';
    entry.scraped_at = new Date().toISOString();
    entry.data = data;
    entry.replies = replies || [];
    entry.error = null;

    await _request(store.put(entry));
    return true;
  }

  async function markFailed(url, error) {
    const store = await _tx(STORES.QUEUE, 'readwrite');
    const entry = await _request(store.get(url));
    if (!entry) return false;

    entry.status = 'failed';
    entry.error = error;
    entry.retry_count = (entry.retry_count || 0) + 1;

    await _request(store.put(entry));
    return true;
  }

  async function retryFailed(maxRetries = 2) {
    const failed = await getByStatus('failed');
    const db = await open();
    const tx = db.transaction(STORES.QUEUE, 'readwrite');
    const store = tx.objectStore(STORES.QUEUE);
    let retried = 0;

    for (const entry of failed) {
      if (entry.retry_count < maxRetries) {
        entry.status = 'queued';
        entry.error = null;
        store.put(entry);
        retried++;
      }
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(retried);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function deleteFromQueue(url) {
    const store = await _tx(STORES.QUEUE, 'readwrite');
    return _request(store.delete(url));
  }

  async function deleteByStatus(status) {
    const items = await getByStatus(status);
    const db = await open();
    const tx = db.transaction(STORES.QUEUE, 'readwrite');
    const store = tx.objectStore(STORES.QUEUE);

    for (const item of items) {
      store.delete(item.url);
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(items.length);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function clearQueue() {
    const store = await _tx(STORES.QUEUE, 'readwrite');
    return _request(store.clear());
  }

  async function getAllQueue() {
    const store = await _tx(STORES.QUEUE);
    return _request(store.getAll());
  }

  async function getQueueCounts() {
    const all = await getAllQueue();
    const counts = { queued: 0, scraping: 0, scraped: 0, exporting: 0, exported: 0, failed: 0, total: all.length };
    for (const item of all) {
      if (counts[item.status] !== undefined) counts[item.status]++;
    }
    return counts;
  }

  // ============================================================================
  // Blob Operations (Ephemeral MAIN→ISOLATED transfer)
  // ============================================================================

  async function storeBlob(data) {
    const id = Math.random().toString(36).substring(2) + Date.now().toString(36);
    const store = await _tx(STORES.BLOBS, 'readwrite');
    await _request(store.put({ id, data, timestamp: Date.now() }));
    return id;
  }

  async function getBlob(id) {
    const store = await _tx(STORES.BLOBS);
    const blob = await _request(store.get(id));
    return blob ? blob.data : null;
  }

  async function deleteBlob(id) {
    const store = await _tx(STORES.BLOBS, 'readwrite');
    return _request(store.delete(id));
  }

  async function clearOldBlobs(maxAgeMs = 60000) {
    const store = await _tx(STORES.BLOBS, 'readwrite');
    const all = await _request(store.getAll());
    const cutoff = Date.now() - maxAgeMs;
    let cleared = 0;

    for (const blob of all) {
      if (blob.timestamp < cutoff) {
        store.delete(blob.id);
        cleared++;
      }
    }
    return cleared;
  }

  // ============================================================================
  // Settings Operations
  // ============================================================================

  async function getSetting(key) {
    const store = await _tx(STORES.SETTINGS);
    const entry = await _request(store.get(key));
    return entry ? entry.value : DEFAULT_SETTINGS[key];
  }

  async function getAllSettings() {
    const store = await _tx(STORES.SETTINGS);
    const entries = await _request(store.getAll());
    const settings = { ...DEFAULT_SETTINGS };
    for (const entry of entries) {
      settings[entry.key] = entry.value;
    }
    return settings;
  }

  async function saveSetting(key, value) {
    const store = await _tx(STORES.SETTINGS, 'readwrite');
    return _request(store.put({ key, value }));
  }

  async function saveAllSettings(settings) {
    const db = await open();
    const tx = db.transaction(STORES.SETTINGS, 'readwrite');
    const store = tx.objectStore(STORES.SETTINGS);

    for (const [key, value] of Object.entries(settings)) {
      store.put({ key, value });
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function resetSettings() {
    const store = await _tx(STORES.SETTINGS, 'readwrite');
    await _request(store.clear());
  }

  // ============================================================================
  // Public API
  // ============================================================================

  return {
    STORES,
    DEFAULT_SETTINGS,
    open,

    // Queue
    addToQueue,
    addUrlsToQueue,
    getByStatus,
    getNextQueued,
    updateStatus,
    saveScrapedData,
    markFailed,
    retryFailed,
    deleteFromQueue,
    deleteByStatus,
    clearQueue,
    getAllQueue,
    getQueueCounts,

    // Blobs
    storeBlob,
    getBlob,
    deleteBlob,
    clearOldBlobs,

    // Settings
    getSetting,
    getAllSettings,
    saveSetting,
    saveAllSettings,
    resetSettings
  };
})();
