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
  const DB_VERSION = 3;

  const STORES = {
    QUEUE: 'tweet_queue',
    BLOBS: 'intercepted_blobs',
    SETTINGS: 'settings',
    PROJECTS: 'projects'
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
    close_delay_max: 5000,
    active_project_id: 'default'
  };

  let dbInstance = null;

  // ============================================================================
  // Database Connection
  // ============================================================================

  function open() {
    if (dbInstance) return Promise.resolve(dbInstance);
    return new Promise((resolve, reject) => {
      // First, open without version to check the current version and read legacy data if needed
      const checkRequest = indexedDB.open(DB_NAME);

      checkRequest.onupgradeneeded = (event) => {
        // If the database didn't exist yet, it will create version 1 by default.
        // We don't create any stores here.
      };

      checkRequest.onsuccess = (event) => {
        const db = event.target.result;
        const currentVersion = db.version;

        if (currentVersion < 3 && db.objectStoreNames.contains(STORES.QUEUE)) {
          // Read legacy items for migration
          try {
            const tx = db.transaction(STORES.QUEUE, 'readonly');
            const store = tx.objectStore(STORES.QUEUE);
            const getReq = store.getAll();

            getReq.onsuccess = () => {
              const legacyItems = getReq.result || [];
              db.close();
              openVersion3(legacyItems).then(resolve).catch(reject);
            };

            getReq.onerror = () => {
              db.close();
              openVersion3([]).then(resolve).catch(reject);
            };
          } catch (err) {
            db.close();
            openVersion3([]).then(resolve).catch(reject);
          }
        } else {
          db.close();
          openVersion3([]).then(resolve).catch(reject);
        }
      };

      checkRequest.onerror = (event) => {
        openVersion3([]).then(resolve).catch(reject);
      };
    });
  }

  function openVersion3(legacyItems = []) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // intercepted_blobs store
        if (!db.objectStoreNames.contains(STORES.BLOBS)) {
          db.createObjectStore(STORES.BLOBS, { keyPath: 'id' });
        }

        // settings store
        if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
          db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
        }

        // projects store
        if (!db.objectStoreNames.contains(STORES.PROJECTS)) {
          db.createObjectStore(STORES.PROJECTS, { keyPath: 'id' });
        }

        // Always recreate queue store on upgrade to v3 to guarantee correct compound key schema
        if (db.objectStoreNames.contains(STORES.QUEUE)) {
          db.deleteObjectStore(STORES.QUEUE);
        }

        const queueStore = db.createObjectStore(STORES.QUEUE, { keyPath: ['project_id', 'url'] });
        queueStore.createIndex('by_url', 'url', { unique: false });
        queueStore.createIndex('by_project', 'project_id', { unique: false });
        queueStore.createIndex('by_status', 'status', { unique: false });
        queueStore.createIndex('by_project_status', ['project_id', 'status'], { unique: false });
        queueStore.createIndex('by_discovered', 'discovered_at', { unique: false });
        queueStore.createIndex('by_tweet_id', 'tweet_id', { unique: false });
      };

      request.onsuccess = async (event) => {
        dbInstance = event.target.result;

        try {
          // Seed default project
          await seedDefaultProject(dbInstance);

          // If there are legacy items to migrate, write them in a transaction
          if (legacyItems.length > 0) {
            const tx = dbInstance.transaction(STORES.QUEUE, 'readwrite');
            const store = tx.objectStore(STORES.QUEUE);
            for (const item of legacyItems) {
              if (!item.project_id) {
                item.project_id = 'default';
              }
              store.put(item);
            }
            await new Promise((res) => {
              tx.oncomplete = () => res();
              tx.onerror = () => res();
            });
          }
          resolve(dbInstance);
        } catch (err) {
          reject(err);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  async function seedDefaultProject(db) {
    return new Promise((resolve) => {
      const tx = db.transaction([STORES.PROJECTS], 'readwrite');
      const store = tx.objectStore(STORES.PROJECTS);
      const req = store.get('default');
      req.onsuccess = () => {
        if (!req.result) {
          store.put({
            id: 'default',
            name: 'Default Project',
            created_at: new Date().toISOString()
          });
        }
        resolve();
      };
      req.onerror = () => resolve();
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

  async function addToQueue(projectId, url, tweetId, sourcePage) {
    const store = await _tx(STORES.QUEUE, 'readwrite');
    const existing = await _request(store.get([projectId, url]));
    if (existing) return false; // duplicate

    // Check if this URL is already scraped in another project
    const urlIndex = store.index('by_url');
    const crossMatches = await _request(urlIndex.getAll(url));
    const scrapedMatch = crossMatches.find(m => m.status === 'scraped' || m.status === 'exported');

    const entry = {
      project_id: projectId,
      url,
      tweet_id: tweetId,
      status: scrapedMatch ? scrapedMatch.status : 'queued',
      discovered_at: new Date().toISOString(),
      scraped_at: scrapedMatch ? scrapedMatch.scraped_at : null,
      exported_at: scrapedMatch ? scrapedMatch.exported_at : null,
      error: scrapedMatch ? scrapedMatch.error : null,
      retry_count: scrapedMatch ? scrapedMatch.retry_count : 0,
      data: scrapedMatch ? scrapedMatch.data : null,
      replies: scrapedMatch ? scrapedMatch.replies : null,
      source_page: sourcePage
    };

    const writeStore = await _tx(STORES.QUEUE, 'readwrite');
    await _request(writeStore.put(entry));
    return true;
  }

  async function addUrlsToQueue(projectId, urls, sourcePage) {
    const db = await open();
    const tx = db.transaction(STORES.QUEUE, 'readwrite');
    const store = tx.objectStore(STORES.QUEUE);
    const urlIndex = store.index('by_url');
    let added = 0;

    for (const { url, tweetId } of urls) {
      const existing = await _request(store.get([projectId, url]));
      if (!existing) {
        // Check if this URL is already scraped in another project
        const crossMatches = await _request(urlIndex.getAll(url));
        const scrapedMatch = crossMatches.find(m => m.status === 'scraped' || m.status === 'exported');

        store.put({
          project_id: projectId,
          url,
          tweet_id: tweetId,
          status: scrapedMatch ? scrapedMatch.status : 'queued',
          discovered_at: new Date().toISOString(),
          scraped_at: scrapedMatch ? scrapedMatch.scraped_at : null,
          exported_at: scrapedMatch ? scrapedMatch.exported_at : null,
          error: scrapedMatch ? scrapedMatch.error : null,
          retry_count: scrapedMatch ? scrapedMatch.retry_count : 0,
          data: scrapedMatch ? scrapedMatch.data : null,
          replies: scrapedMatch ? scrapedMatch.replies : null,
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

  async function getByStatus(projectId, status) {
    const store = await _tx(STORES.QUEUE);
    const index = store.index('by_project_status');
    return _request(index.getAll([projectId, status]));
  }

  async function getNextQueued(projectId) {
    const store = await _tx(STORES.QUEUE);
    const index = store.index('by_project_status');
    return new Promise((resolve, reject) => {
      const request = index.openCursor(IDBKeyRange.only([projectId, 'queued']));
      request.onsuccess = () => {
        const cursor = request.result;
        resolve(cursor ? cursor.value : null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function updateStatus(projectId, url, status, extra = {}) {
    const store = await _tx(STORES.QUEUE, 'readwrite');
    const entry = await _request(store.get([projectId, url]));
    if (!entry) return false;

    entry.status = status;
    Object.assign(entry, extra);

    if (status === 'scraped') entry.scraped_at = new Date().toISOString();
    if (status === 'exported') entry.exported_at = new Date().toISOString();

    await _request(store.put(entry));
    return true;
  }

  async function saveScrapedData(projectId, url, data, replies) {
    const store = await _tx(STORES.QUEUE, 'readwrite');
    const entry = await _request(store.get([projectId, url]));
    if (!entry) return false;

    entry.status = 'scraped';
    entry.scraped_at = new Date().toISOString();
    entry.data = data;
    entry.replies = replies || [];
    entry.error = null;

    await _request(store.put(entry));

    // CRITICAL: Propagate this scraped data to all other projects that have this URL queued!
    const urlIndex = store.index('by_url');
    const allMatches = await _request(urlIndex.getAll(url));
    const writeStore = await _tx(STORES.QUEUE, 'readwrite');

    for (const match of allMatches) {
      if (match.project_id !== projectId && match.status === 'queued') {
        match.status = 'scraped';
        match.scraped_at = entry.scraped_at;
        match.data = data;
        match.replies = replies || [];
        match.error = null;
        await _request(writeStore.put(match));
      }
    }

    return true;
  }

  async function markFailed(projectId, url, error) {
    const store = await _tx(STORES.QUEUE, 'readwrite');
    const entry = await _request(store.get([projectId, url]));
    if (!entry) return false;

    entry.status = 'failed';
    entry.error = error;
    entry.retry_count = (entry.retry_count || 0) + 1;

    await _request(store.put(entry));
    return true;
  }

  async function retryFailed(projectId, maxRetries = 2) {
    const failed = await getByStatus(projectId, 'failed');
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

  async function deleteFromQueue(projectId, url) {
    const store = await _tx(STORES.QUEUE, 'readwrite');
    return _request(store.delete([projectId, url]));
  }

  async function deleteByStatus(projectId, status) {
    const items = await getByStatus(projectId, status);
    const db = await open();
    const tx = db.transaction(STORES.QUEUE, 'readwrite');
    const store = tx.objectStore(STORES.QUEUE);

    for (const item of items) {
      store.delete([projectId, item.url]);
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(items.length);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function clearQueue(projectId) {
    const db = await open();
    const tx = db.transaction(STORES.QUEUE, 'readwrite');
    const store = tx.objectStore(STORES.QUEUE);
    const index = store.index('by_project');
    const req = index.openKeyCursor(IDBKeyRange.only(projectId));
    let deleted = 0;

    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        deleted++;
        cursor.continue();
      }
    };

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(deleted);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getAllQueue(projectId) {
    const store = await _tx(STORES.QUEUE);
    const index = store.index('by_project');
    return _request(index.getAll(projectId));
  }

  async function getQueueCounts(projectId) {
    const all = await getAllQueue(projectId);
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
  // Project Operations
  // ============================================================================

  async function getProjects() {
    const store = await _tx(STORES.PROJECTS);
    return _request(store.getAll());
  }

  async function createProject(name) {
    const store = await _tx(STORES.PROJECTS, 'readwrite');
    const id = 'proj_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
    const project = {
      id,
      name,
      created_at: new Date().toISOString()
    };
    await _request(store.put(project));
    return project;
  }

  async function deleteProject(id) {
    if (id === 'default') return false; // Cannot delete default project

    const db = await open();
    const tx = db.transaction([STORES.QUEUE, STORES.PROJECTS], 'readwrite');

    // 1. Delete the project entry
    tx.objectStore(STORES.PROJECTS).delete(id);

    // 2. Delete all items in queue for this project
    const queueStore = tx.objectStore(STORES.QUEUE);
    const index = queueStore.index('by_project');
    const req = index.openKeyCursor(IDBKeyRange.only(id));

    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        queueStore.delete(cursor.primaryKey);
        cursor.continue();
      }
    };

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
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
    resetSettings,

    // Projects
    getProjects,
    createProject,
    deleteProject
  };
})();
