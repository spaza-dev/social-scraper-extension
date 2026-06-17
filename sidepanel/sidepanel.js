/**
 * sidepanel.js — Side Panel Logic
 *
 * Tab navigation, queue rendering, data table, export controls,
 * settings management, and real-time message handling.
 */

// ============================================================================
// State
// ============================================================================

let currentTab = 'queue';
let queueItems = [];
let selectedUrls = new Set();
let dataSelectedUrls = new Set();
let scrapingState = 'idle'; // idle | scraping | paused
let currentPage = 1;
const PAGE_SIZE = 50;
let expandedRow = null;

// ============================================================================
// DOM Elements
// ============================================================================

const $ = id => document.getElementById(id);

const els = {
  // Tabs
  queueTabCount: $('queueTabCount'),
  dataTabCount: $('dataTabCount'),
  // Stats
  countQueued: $('countQueued'),
  countScraping: $('countScraping'),
  countScraped: $('countScraped'),
  countExported: $('countExported'),
  countFailed: $('countFailed'),
  // Projects
  projectSelect: $('projectSelect'),
  createProjectBtn: $('createProjectBtn'),
  deleteProjectBtn: $('deleteProjectBtn'),
  createProjectModal: $('createProjectModal'),
  newProjectNameInput: $('newProjectNameInput'),
  newProjectError: $('newProjectError'),
  cancelCreateProjectBtn: $('cancelCreateProjectBtn'),
  saveCreateProjectBtn: $('saveCreateProjectBtn'),
  // Queue actions
  collectBtn: $('collectBtn'),
  scrapeBtn: $('scrapeBtn'),
  selectAll: $('selectAll'),
  retryFailedBtn: $('retryFailedBtn'),
  deleteSelectedBtn: $('deleteSelectedBtn'),
  clearQueuedBtn: $('clearQueuedBtn'),
  clearAllBtn: $('clearAllBtn'),
  queueList: $('queueList'),
  pagination: $('pagination'),
  prevPage: $('prevPage'),
  nextPage: $('nextPage'),
  pageInfo: $('pageInfo'),
  // Data
  searchInput: $('searchInput'),
  filterStatus: $('filterStatus'),
  filterMedia: $('filterMedia'),
  filterReply: $('filterReply'),
  downloadCSVBtn: $('downloadCSVBtn'),
  downloadSelectedCSVBtn: $('downloadSelectedCSVBtn'),
  downloadJSONLBtn: $('downloadJSONLBtn'),
  downloadSelectedJSONLBtn: $('downloadSelectedJSONLBtn'),
  sendApiBtn: $('sendApiBtn'),
  exportIncludeReplies: $('exportIncludeReplies'),
  dataSelectAll: $('dataSelectAll'),
  dataTableBody: $('dataTableBody'),
  dataEmpty: $('dataEmpty'),
  apiProgress: $('apiProgress'),
  apiProgressFill: $('apiProgressFill'),
  apiProgressText: $('apiProgressText'),
  // Settings
  settingApiEndpoint: $('settingApiEndpoint'),
  settingApiKey: $('settingApiKey'),
  settingBatchSize: $('settingBatchSize'),
  settingDelayMin: $('settingDelayMin'),
  settingDelayMax: $('settingDelayMax'),
  settingScrollDelayMin: $('settingScrollDelayMin'),
  settingScrollDelayMax: $('settingScrollDelayMax'),
  settingCloseDelayMin: $('settingCloseDelayMin'),
  settingCloseDelayMax: $('settingCloseDelayMax'),
  settingMaxScrolls: $('settingMaxScrolls'),
  settingMaxRetries: $('settingMaxRetries'),
  settingIncludeReplies: $('settingIncludeReplies'),
  settingStaleThreshold: $('settingStaleThreshold'),
  settingSessionLimit: $('settingSessionLimit'),
  settingCooldown: $('settingCooldown'),
  saveSettingsBtn: $('saveSettingsBtn'),
  resetSettingsBtn: $('resetSettingsBtn'),
};

// ============================================================================
// Initialization
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  setupTabNavigation();
  setupEventListeners();
  setupMessageListener();
  setupProjectHandlers();
  await refreshProjects();
  await loadSettings();
  await refreshQueue();
});

// ============================================================================
// Tab Navigation
// ============================================================================

function setupTabNavigation() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabId = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tabId + 'Tab').classList.add('active');
      currentTab = tabId;

      if (tabId === 'data') renderDataTable();
    });
  });
}

// ============================================================================
// Event Listeners
// ============================================================================

function setupEventListeners() {
  // Collection
  els.collectBtn.addEventListener('click', handleCollectClick);
  els.scrapeBtn.addEventListener('click', handleScrapeClick);

  // Bulk actions
  els.selectAll.addEventListener('change', handleSelectAll);
  els.retryFailedBtn.addEventListener('click', handleRetryFailed);
  els.deleteSelectedBtn.addEventListener('click', handleDeleteSelected);
  els.clearQueuedBtn.addEventListener('click', () => handleClearQueue('queued'));
  els.clearAllBtn.addEventListener('click', handleClearAll);

  // Pagination
  els.prevPage.addEventListener('click', () => { if (currentPage > 1) { currentPage--; renderQueue(); } });
  els.nextPage.addEventListener('click', () => { const pages = Math.ceil(queueItems.length / PAGE_SIZE); if (currentPage < pages) { currentPage++; renderQueue(); } });

  // Data tab
  els.searchInput.addEventListener('input', debounce(renderDataTable, 300));
  els.filterStatus.addEventListener('change', renderDataTable);
  els.filterMedia.addEventListener('change', renderDataTable);
  els.filterReply.addEventListener('change', renderDataTable);
  els.downloadCSVBtn.addEventListener('click', () => handleExportCSV(false));
  els.downloadSelectedCSVBtn.addEventListener('click', () => handleExportCSV(true));
  els.downloadJSONLBtn.addEventListener('click', () => handleExportJSONL(false));
  els.downloadSelectedJSONLBtn.addEventListener('click', () => handleExportJSONL(true));
  els.sendApiBtn.addEventListener('click', handleSendToAPI);
  els.dataSelectAll.addEventListener('change', handleDataSelectAll);

  // Settings
  els.saveSettingsBtn.addEventListener('click', saveSettings);
  els.resetSettingsBtn.addEventListener('click', resetSettings);
}

// ============================================================================
// Message Listener — from background.js
// ============================================================================

function setupMessageListener() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'COLLECTION_UPDATE':
        showToast('info', `Collected ${message.data.count} tweet URLs`);
        refreshQueue();
        break;

      case 'COLLECTION_COMPLETE':
        showToast('success', `Collection complete: ${message.data.totalCollected} tweets`);
        els.collectBtn.innerHTML = collectBtnHTML('idle');
        refreshQueue();
        break;

      case 'STATUS_UPDATE':
        scrapingState = message.data.scrapingState;
        if (scrapingState === 'rate-limited') {
          const msg = message.data.autoResume 
            ? `Rate limited! Automatically resuming in ${message.data.cooldownRemaining} minutes.`
            : `Rate limited! Cooling down for ${message.data.cooldownRemaining} minutes.`;
          showToast('error', msg);
        } else if (scrapingState === 'session-limit-reached') {
          showToast('info', 'Session limit reached. Take a break!');
        }
        updateScrapeButton();
        break;

      case 'QUEUE_ITEM_UPDATE':
        refreshQueue();
        break;

      case 'SCRAPING_COMPLETE':
        scrapingState = 'idle';
        updateScrapeButton();
        showToast('success', 'Scraping complete!');
        refreshQueue();
        break;

      case 'CSV_READY':
        downloadCSVFile(message.data.csv, message.data.count);
        break;

      case 'JSONL_READY':
        downloadJSONLFile(message.data.jsonl, message.data.count);
        break;

      case 'API_PROGRESS':
        showApiProgress(message.data);
        break;

      case 'API_ERROR':
        showToast('error', `API batch ${message.data.batch} failed: ${message.data.error || message.data.status}`);
        break;

      case 'API_COMPLETE':
        hideApiProgress();
        showToast('success', `API export complete: ${message.data.successCount}/${message.data.totalPosts} posts sent`);
        refreshQueue();
        break;
    }
  });
}

// ============================================================================
// Queue Management
// ============================================================================

async function refreshQueue() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_QUEUE' }, (response) => {
      if (response?.success) {
        queueItems = response.items || [];
        renderQueue();
        updateCounts();
      }
      resolve();
    });
  });
}

function renderQueue() {
  const total = queueItems.length;

  if (total === 0) {
    els.queueList.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
          <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/>
        </svg>
        <p>No tweets in queue</p>
        <p class="muted">Click "Collect Tweets" on a Twitter page to start</p>
      </div>`;
    els.pagination.style.display = 'none';
    return;
  }

  // Sort: scraping first, then queued, then failed, then scraped, then exported
  const statusOrder = { scraping: 0, queued: 1, failed: 2, scraped: 3, exporting: 4, exported: 5 };
  const sorted = [...queueItems].sort((a, b) =>
    (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9)
  );

  const pages = Math.ceil(sorted.length / PAGE_SIZE);
  if (currentPage > pages) currentPage = pages;
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = sorted.slice(start, start + PAGE_SIZE);

  els.queueList.innerHTML = pageItems.map(item => {
    const shortUrl = item.url.replace('https://x.com/', '@');
    const time = item.discovered_at ? new Date(item.discovered_at).toLocaleTimeString() : '';
    const checked = selectedUrls.has(item.url) ? 'checked' : '';

    return `
      <div class="queue-card" data-url="${escapeAttr(item.url)}">
        <input type="checkbox" ${checked} data-url="${escapeAttr(item.url)}"/>
        <div class="queue-card-content">
          <a class="queue-card-url" href="${escapeAttr(item.url)}" target="_blank" title="${escapeAttr(item.url)}">${escapeHtml(shortUrl)}</a>
          <div class="queue-card-meta">${time}</div>
          ${item.error ? `<div class="queue-card-error">⚠ ${escapeHtml(item.error)}</div>` : ''}
        </div>
        <span class="status-badge ${item.status}">${item.status}</span>
      </div>`;
  }).join('');

  // Attach checkbox listeners
  els.queueList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const url = e.target.dataset.url;
      if (e.target.checked) selectedUrls.add(url);
      else selectedUrls.delete(url);
    });
  });

  // Pagination
  if (pages > 1) {
    els.pagination.style.display = 'flex';
    els.pageInfo.textContent = `Page ${currentPage} of ${pages}`;
    els.prevPage.disabled = currentPage <= 1;
    els.nextPage.disabled = currentPage >= pages;
  } else {
    els.pagination.style.display = 'none';
  }
}

function updateCounts() {
  const counts = { queued: 0, scraping: 0, scraped: 0, exporting: 0, exported: 0, failed: 0 };
  for (const item of queueItems) {
    if (counts[item.status] !== undefined) counts[item.status]++;
  }

  els.countQueued.textContent = counts.queued;
  els.countScraping.textContent = counts.scraping;
  els.countScraped.textContent = counts.scraped;
  els.countExported.textContent = counts.exported;
  els.countFailed.textContent = counts.failed;
  els.queueTabCount.textContent = queueItems.length;
  els.dataTabCount.textContent = counts.scraped + counts.exported;
}

// ============================================================================
// Queue Action Handlers
// ============================================================================

let isCollecting = false;

function handleCollectClick() {
  if (isCollecting) {
    chrome.runtime.sendMessage({ type: 'STOP_COLLECTING' });
    isCollecting = false;
    els.collectBtn.innerHTML = collectBtnHTML('idle');
  } else {
    chrome.runtime.sendMessage({ type: 'START_COLLECTING' });
    isCollecting = true;
    els.collectBtn.innerHTML = collectBtnHTML('collecting');
  }
}

function collectBtnHTML(state) {
  if (state === 'collecting') {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg> Stop Collecting`;
  }
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg> Collect Tweets`;
}

function handleScrapeClick() {
  switch (scrapingState) {
    case 'idle':
      chrome.runtime.sendMessage({ type: 'START_SCRAPING' });
      scrapingState = 'scraping';
      break;
    case 'scraping':
      chrome.runtime.sendMessage({ type: 'PAUSE_SCRAPING' });
      scrapingState = 'paused';
      break;
    case 'paused':
      chrome.runtime.sendMessage({ type: 'RESUME_SCRAPING' });
      scrapingState = 'scraping';
      break;
  }
  updateScrapeButton();
}

function updateScrapeButton() {
  const btn = els.scrapeBtn;
  btn.className = 'btn';

  switch (scrapingState) {
    case 'scraping':
      btn.classList.add('btn-pause');
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause`;
      break;
    case 'paused':
      btn.classList.add('btn-resume');
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Resume`;
      break;
    case 'rate-limited':
      btn.classList.add('btn-danger');
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg> Rate Limited`;
      break;
    case 'session-limit-reached':
      btn.classList.add('btn-warning');
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg> Session Limit`;
      break;
    default:
      btn.classList.add('btn-accent');
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start Scraping`;
  }
}

function handleSelectAll(e) {
  if (e.target.checked) {
    queueItems.forEach(i => selectedUrls.add(i.url));
  } else {
    selectedUrls.clear();
  }
  renderQueue();
}

function handleRetryFailed() {
  chrome.runtime.sendMessage({ type: 'RETRY_FAILED' }, (res) => {
    if (res?.success) {
      showToast('info', `${res.retried} items re-queued`);
      refreshQueue();
    }
  });
}

function handleDeleteSelected() {
  if (selectedUrls.size === 0) { showToast('info', 'No items selected'); return; }
  chrome.runtime.sendMessage({ type: 'DELETE_QUEUE_ITEMS', data: { urls: [...selectedUrls] } }, () => {
    selectedUrls.clear();
    refreshQueue();
    showToast('success', 'Deleted selected items');
  });
}

function handleClearQueue(status) {
  chrome.runtime.sendMessage({ type: 'CLEAR_QUEUE', data: { statusOnly: status } }, () => {
    refreshQueue();
    showToast('success', `Cleared ${status} items`);
  });
}

function handleClearAll() {
  if (!confirm('Clear ALL items from the queue? This cannot be undone.')) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_QUEUE', data: {} }, () => {
    selectedUrls.clear();
    refreshQueue();
    showToast('success', 'Queue cleared');
  });
}

// ============================================================================
// Data Table
// ============================================================================

function renderDataTable() {
  const scraped = queueItems.filter(i => i.status === 'scraped' || i.status === 'exported');
  const search = (els.searchInput.value || '').toLowerCase();
  const statusFilter = els.filterStatus.value;
  const mediaFilter = els.filterMedia.value;
  const replyFilter = els.filterReply.value;

  let rows = [];
  for (const item of scraped) {
    if (statusFilter && item.status !== statusFilter) continue;
    if (item.data) rows.push({ item, tweet: item.data, isReply: false });
    if (item.replies) {
      for (const reply of item.replies) {
        rows.push({ item, tweet: reply, isReply: true });
      }
    }
  }

  // Apply filters
  rows = rows.filter(r => {
    if (search && !r.tweet.text?.toLowerCase().includes(search) &&
        !r.tweet.author?.username?.toLowerCase().includes(search)) return false;
    if (mediaFilter === 'has-media' && (!r.tweet.media || r.tweet.media.length === 0)) return false;
    if (mediaFilter === 'no-media' && r.tweet.media?.length > 0) return false;
    if (replyFilter === 'reply' && !r.tweet.is_reply) return false;
    if (replyFilter === 'original' && r.tweet.is_reply) return false;
    return true;
  });

  if (rows.length === 0) {
    els.dataTableBody.innerHTML = '';
    els.dataEmpty.style.display = 'flex';
    return;
  }

  els.dataEmpty.style.display = 'none';

  els.dataTableBody.innerHTML = rows.map((r, idx) => {
    const t = r.tweet;
    const author = t.author || {};
    const eng = t.engagement || {};
    const checked = dataSelectedUrls.has(t.url) ? 'checked' : '';
    const dateStr = t.created_at ? new Date(t.created_at).toLocaleDateString() : '';
    const textPreview = (t.text || '').substring(0, 80);

    return `
      <tr data-idx="${idx}" data-url="${escapeAttr(t.url)}">
        <td class="col-check"><input type="checkbox" ${checked} data-url="${escapeAttr(t.url)}"/></td>
        <td class="col-author">
          <div class="author-name">${escapeHtml(author.display_name || '')}</div>
          <div class="author-handle">@${escapeHtml(author.username || '')}</div>
        </td>
        <td class="col-text"><div class="text-preview">${escapeHtml(textPreview)}</div></td>
        <td class="col-num">${formatNum(eng.likes)}</td>
        <td class="col-num">${formatNum(eng.retweets)}</td>
        <td class="col-num">${formatNum(eng.replies)}</td>
        <td class="col-num">${formatNum(eng.views)}</td>
        <td class="col-date">${dateStr}</td>
      </tr>`;
  }).join('');

  // Click handlers
  els.dataTableBody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.type === 'checkbox') return;
      const idx = parseInt(tr.dataset.idx);
      toggleExpandedRow(idx, rows[idx], tr);
    });
    tr.querySelector('input[type="checkbox"]')?.addEventListener('change', (e) => {
      const url = e.target.dataset.url;
      if (e.target.checked) dataSelectedUrls.add(url);
      else dataSelectedUrls.delete(url);
    });
  });
}

function toggleExpandedRow(idx, rowData, trElement) {
  // Remove any existing expanded row
  const existing = document.querySelector('.expanded-row');
  if (existing) {
    const existingIdx = existing.dataset.expandedIdx;
    existing.remove();
    if (parseInt(existingIdx) === idx) { expandedRow = null; return; }
  }

  expandedRow = idx;
  const t = rowData.tweet;
  const author = t.author || {};
  const eng = t.engagement || {};

  const detailHTML = `
    <tr class="expanded-row" data-expanded-idx="${idx}">
      <td colspan="8">
        <div class="expanded-details">
          <div class="detail-row">
            <span class="detail-label">Full Text</span>
            <span class="detail-value">${escapeHtml(t.text || '')}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">URL</span>
            <span class="detail-value"><a href="${escapeAttr(t.url)}" target="_blank" style="color:var(--accent)">${escapeHtml(t.url)}</a></span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Author Bio</span>
            <span class="detail-value">${escapeHtml(author.bio || '—')}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Followers</span>
            <span class="detail-value">${formatNum(author.followers_count)} followers · ${formatNum(author.following_count)} following</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Engagement</span>
            <span class="detail-value">👁 ${formatNum(eng.views)} · ❤️ ${formatNum(eng.likes)} · 🔁 ${formatNum(eng.retweets)} · 💬 ${formatNum(eng.replies)} · 💭 ${formatNum(eng.quotes)} · 🔖 ${formatNum(eng.bookmarks)}</span>
          </div>
          ${t.media?.length ? `<div class="detail-row"><span class="detail-label">Media</span><span class="detail-value">${t.media.map(m => `${m.type}: ${m.url}`).join('<br/>')}</span></div>` : ''}
          ${t.hashtags?.length ? `<div class="detail-row"><span class="detail-label">Hashtags</span><span class="detail-value">${t.hashtags.map(h => '#' + h).join(' ')}</span></div>` : ''}
          ${t.is_reply ? `<div class="detail-row"><span class="detail-label">Reply to</span><span class="detail-value">@${escapeHtml(t.in_reply_to_username || '')} (${t.in_reply_to_status_id || ''})</span></div>` : ''}
        </div>
      </td>
    </tr>`;

  trElement.insertAdjacentHTML('afterend', detailHTML);
}

function handleDataSelectAll(e) {
  if (e.target.checked) {
    els.dataTableBody.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = true;
      dataSelectedUrls.add(cb.dataset.url);
    });
  } else {
    dataSelectedUrls.clear();
    els.dataTableBody.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
  }
}

// ============================================================================
// Export Handlers
// ============================================================================

function handleExportCSV(selectedOnly) {
  const includeReplies = els.exportIncludeReplies.checked;
  const data = { includeReplies };
  if (selectedOnly) {
    data.urls = [...dataSelectedUrls];
    if (data.urls.length === 0) { showToast('info', 'No rows selected'); return; }
  }
  chrome.runtime.sendMessage({ type: 'EXPORT_CSV', data });
}

function downloadCSVFile(csv, count) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tweets_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('success', `CSV downloaded: ${count} rows`);
  refreshQueue();
}

function handleExportJSONL(selectedOnly) {
  const includeReplies = els.exportIncludeReplies.checked;
  const data = { includeReplies };
  if (selectedOnly) {
    data.urls = [...dataSelectedUrls];
    if (data.urls.length === 0) { showToast('info', 'No rows selected'); return; }
  }
  chrome.runtime.sendMessage({ type: 'EXPORT_JSONL', data });
}

function downloadJSONLFile(jsonl, count) {
  const blob = new Blob([jsonl], { type: 'application/x-jsonlines;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tweets_${new Date().toISOString().slice(0,10)}.jsonl`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('success', `JSONL downloaded: ${count} rows`);
  refreshQueue();
}

function handleSendToAPI() {
  const includeReplies = els.exportIncludeReplies.checked;
  const data = { includeReplies };
  if (dataSelectedUrls.size > 0) {
    data.urls = [...dataSelectedUrls];
  }
  chrome.runtime.sendMessage({ type: 'EXPORT_API', data });
}

function showApiProgress(data) {
  els.apiProgress.style.display = 'block';
  const pct = (data.batchNumber / data.totalBatches) * 100;
  els.apiProgressFill.style.width = `${pct}%`;
  els.apiProgressText.textContent = `Sending batch ${data.batchNumber}/${data.totalBatches}...`;
}

function hideApiProgress() {
  setTimeout(() => { els.apiProgress.style.display = 'none'; }, 2000);
}

// ============================================================================
// Settings
// ============================================================================

async function loadSettings() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (settings) => {
      if (settings) {
        els.settingApiEndpoint.value = settings.api_endpoint || '';
        els.settingApiKey.value = settings.api_key || '';
        els.settingBatchSize.value = settings.api_batch_size || 25;
        els.settingDelayMin.value = settings.scrape_delay_min || 2000;
        els.settingDelayMax.value = settings.scrape_delay_max || 6000;
        els.settingScrollDelayMin.value = settings.scroll_delay_min || 1000;
        els.settingScrollDelayMax.value = settings.scroll_delay_max || 3000;
        els.settingCloseDelayMin.value = settings.close_delay_min || 2000;
        els.settingCloseDelayMax.value = settings.close_delay_max || 5000;
        els.settingMaxScrolls.value = settings.max_scroll_cycles || 100;
        els.settingMaxRetries.value = settings.max_retries || 2;
        els.settingIncludeReplies.checked = settings.include_replies !== false;
        els.settingStaleThreshold.value = settings.stale_threshold || 3;
        els.settingSessionLimit.value = settings.session_limit || 50;
        els.settingCooldown.value = settings.cooldown_minutes || 15;
      }
      resolve();
    });
  });
}

function saveSettings() {
  const data = {
    api_endpoint: els.settingApiEndpoint.value.trim(),
    api_key: els.settingApiKey.value,
    api_batch_size: parseInt(els.settingBatchSize.value) || 25,
    scrape_delay_min: parseInt(els.settingDelayMin.value) || 2000,
    scrape_delay_max: parseInt(els.settingDelayMax.value) || 6000,
    scroll_delay_min: parseInt(els.settingScrollDelayMin.value) || 1000,
    scroll_delay_max: parseInt(els.settingScrollDelayMax.value) || 3000,
    close_delay_min: parseInt(els.settingCloseDelayMin.value) || 2000,
    close_delay_max: parseInt(els.settingCloseDelayMax.value) || 5000,
    max_scroll_cycles: parseInt(els.settingMaxScrolls.value) || 100,
    max_retries: parseInt(els.settingMaxRetries.value) || 2,
    stale_threshold: parseInt(els.settingStaleThreshold.value) || 3,
    session_limit: parseInt(els.settingSessionLimit.value) || 50,
    cooldown_minutes: parseInt(els.settingCooldown.value) || 15,
    include_replies: els.settingIncludeReplies.checked
  };

  chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', data }, (res) => {
    if (res?.success) showToast('success', 'Settings saved');
    else showToast('error', 'Failed to save settings');
  });
}

function resetSettings() {
  chrome.runtime.sendMessage({ type: 'RESET_SETTINGS' }, (res) => {
    if (res?.success) {
      loadSettings();
      showToast('info', 'Settings reset to defaults');
    }
  });
}

// ============================================================================
// Toast
// ============================================================================

let toastTimer = null;

function showToast(type, message) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }

  toast.className = `toast ${type}`;
  toast.textContent = message;

  requestAnimationFrame(() => {
    toast.classList.add('visible');
  });

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3000);
}

// ============================================================================
// Helpers
// ============================================================================

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatNum(n) {
  if (n === undefined || n === null) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ============================================================================
// Project Management
// ============================================================================

let currentProjectId = 'default';

async function refreshProjects() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_PROJECTS' }, async (response) => {
      if (response?.success) {
        const projects = response.projects || [];
        
        // Ensure default project is in list
        if (!projects.some(p => p.id === 'default')) {
          projects.unshift({ id: 'default', name: 'Default Project' });
        }
        
        // Populate Select Dropdown
        els.projectSelect.innerHTML = projects.map(p => 
          `<option value="${escapeAttr(p.id)}">${escapeHtml(p.name)}</option>`
        ).join('');
        
        // Set the active selection
        chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (settings) => {
          currentProjectId = settings?.active_project_id || 'default';
          els.projectSelect.value = currentProjectId;
          
          // Toggle Delete Button (don't allow deleting default)
          if (currentProjectId === 'default') {
            els.deleteProjectBtn.disabled = true;
          } else {
            els.deleteProjectBtn.disabled = false;
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  });
}

function setupProjectHandlers() {
  // Select active project change
  els.projectSelect.addEventListener('change', async (e) => {
    const projId = e.target.value;
    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', data: { active_project_id: projId } }, async () => {
      currentProjectId = projId;
      if (currentProjectId === 'default') {
        els.deleteProjectBtn.disabled = true;
      } else {
        els.deleteProjectBtn.disabled = false;
      }
      showToast('info', `Switched project`);
      // Reset selections
      selectedUrls.clear();
      dataSelectedUrls.clear();
      currentPage = 1;
      await refreshQueue();
      if (currentTab === 'data') renderDataTable();
    });
  });

  // Open Create Project Modal
  els.createProjectBtn.addEventListener('click', () => {
    els.newProjectNameInput.value = '';
    els.newProjectError.classList.add('hidden');
    els.newProjectError.textContent = '';
    els.createProjectModal.classList.remove('hidden');
    els.newProjectNameInput.focus();
  });

  // Close Modal
  els.cancelCreateProjectBtn.addEventListener('click', () => {
    els.createProjectModal.classList.add('hidden');
  });

  // Save New Project
  els.saveCreateProjectBtn.addEventListener('click', handleSaveNewProject);
  
  // Enter key in input
  els.newProjectNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      handleSaveNewProject();
    }
  });

  // Delete Project
  els.deleteProjectBtn.addEventListener('click', async () => {
    if (currentProjectId === 'default') return;
    
    const projName = els.projectSelect.options[els.projectSelect.selectedIndex].text;
    if (!confirm(`Delete project "${projName}"? This will delete all collected tweets and scraped data in this project. This cannot be undone.`)) {
      return;
    }
    
    chrome.runtime.sendMessage({ type: 'DELETE_PROJECT', data: { id: currentProjectId } }, async (response) => {
      if (response?.success) {
        showToast('success', 'Project deleted');
        selectedUrls.clear();
        dataSelectedUrls.clear();
        currentPage = 1;
        await refreshProjects();
        await refreshQueue();
        if (currentTab === 'data') renderDataTable();
      } else {
        showToast('error', `Failed to delete project: ${response?.error}`);
      }
    });
  });
}

async function handleSaveNewProject() {
  const name = els.newProjectNameInput.value.trim();
  if (!name) {
    els.newProjectError.textContent = 'Project name is required';
    els.newProjectError.classList.remove('hidden');
    return;
  }
  
  chrome.runtime.sendMessage({ type: 'CREATE_PROJECT', data: { name } }, async (response) => {
    if (response?.success) {
      els.createProjectModal.classList.add('hidden');
      showToast('success', `Created project "${name}"`);
      selectedUrls.clear();
      dataSelectedUrls.clear();
      currentPage = 1;
      await refreshProjects();
      await refreshQueue();
      if (currentTab === 'data') renderDataTable();
    } else {
      els.newProjectError.textContent = response?.error || 'Failed to create project';
      els.newProjectError.classList.remove('hidden');
    }
  });
}
