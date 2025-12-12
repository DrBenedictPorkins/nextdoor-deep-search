/**
 * Nextdoor Deep Search - Popup Script
 *
 * Handles:
 * 1. Status display and updates
 * 2. Deep Search button action
 * 3. Progress updates during search
 * 4. Result display
 */

(function() {
  'use strict';

  // DOM Elements
  const elements = {
    utiStatus: document.getElementById('uti-status'),
    searchTemplateStatus: document.getElementById('search-template-status'),
    threadTemplateStatus: document.getElementById('thread-template-status'),
    pageStatus: document.getElementById('page-status'),
    queryRow: document.getElementById('query-row'),
    queryValue: document.getElementById('query-value'),
    message: document.getElementById('message'),
    progressSection: document.getElementById('progress-section'),
    progressBar: document.getElementById('progress-bar'),
    progressText: document.getElementById('progress-text'),
    errorCount: document.getElementById('error-count'),
    searchBtn: document.getElementById('search-btn'),
    settingsBtn: document.getElementById('settings-btn'),
    resultSection: document.getElementById('result-section'),
    resultQuery: document.getElementById('result-query'),
    resultThreads: document.getElementById('result-threads'),
    resultComments: document.getElementById('result-comments'),
    resultErrors: document.getElementById('result-errors'),
    sessionCount: document.getElementById('session-count'),
    viewResultsLink: document.getElementById('view-results-link')
  };

  // State
  let isRunning = false;
  let port = null;

  // ============================================================================
  // Initialization
  // ============================================================================

  async function init() {
    // Set up button click handlers
    elements.searchBtn.addEventListener('click', startSearch);
    elements.settingsBtn.addEventListener('click', openSettings);
    elements.viewResultsLink.addEventListener('click', viewResults);

    // Connect to background for progress updates
    port = browser.runtime.connect({ name: 'popup' });
    port.onMessage.addListener(handleBackgroundMessage);

    // Get initial status
    await refreshStatus();
  }

  // ============================================================================
  // Status Management
  // ============================================================================

  async function refreshStatus() {
    try {
      const response = await browser.runtime.sendMessage({ type: 'GET_STATUS' });
      updateUI(response.data);
    } catch (e) {
      console.error('[NDS Popup] Error getting status:', e);
      showMessage('error', 'Failed to connect to extension');
    }
  }

  function updateUI(status) {
    // UTI Status
    if (status.hasUti) {
      elements.utiStatus.textContent = 'Ready';
      elements.utiStatus.className = 'status-value ready';
    } else {
      elements.utiStatus.textContent = 'Pending';
      elements.utiStatus.className = 'status-value error';
    }

    // Search Template Status
    if (status.hasSearchPostTemplate) {
      elements.searchTemplateStatus.textContent = 'Ready';
      elements.searchTemplateStatus.className = 'status-value ready';
    } else {
      elements.searchTemplateStatus.textContent = 'Pending';
      elements.searchTemplateStatus.className = 'status-value warning';
    }

    // Thread Template Status
    if (status.hasFeedItemTemplate) {
      elements.threadTemplateStatus.textContent = 'Ready';
      elements.threadTemplateStatus.className = 'status-value ready';
    } else {
      elements.threadTemplateStatus.textContent = 'Pending';
      elements.threadTemplateStatus.className = 'status-value warning';
    }

    // Page Status
    if (status.isOnNextdoor) {
      if (status.isOnSearchPage) {
        elements.pageStatus.textContent = 'Search page';
        elements.queryRow.style.display = 'flex';
        elements.queryValue.textContent = status.query || '--';
      } else {
        elements.pageStatus.textContent = 'Nextdoor';
        elements.queryRow.style.display = 'none';
      }
      elements.pageStatus.className = 'status-value ready';
    } else {
      elements.pageStatus.textContent = 'Not on Nextdoor';
      elements.pageStatus.className = 'status-value warning';
      elements.queryRow.style.display = 'none';
    }

    // Session stats
    elements.sessionCount.textContent = status.sessionSearchCount || 0;

    // View Last Results link
    if (status.hasLastResult) {
      elements.viewResultsLink.style.display = 'block';
    } else {
      elements.viewResultsLink.style.display = 'none';
    }

    // Running state
    isRunning = status.isRunning;

    if (isRunning) {
      elements.searchBtn.textContent = 'Searching...';
      elements.searchBtn.disabled = true;
      elements.searchBtn.classList.add('running');
      elements.progressSection.style.display = 'block';
      updateProgress(status.progress);
    } else {
      elements.searchBtn.classList.remove('running');
      elements.progressSection.style.display = 'none';
    }

    // Message and button state
    updateMessageAndButton(status);

    // Last result
    if (status.lastResult) {
      showResult(status.lastResult);
    }
  }

  function updateMessageAndButton(status) {
    if (isRunning) {
      showMessage('info', 'Deep search in progress...');
      return;
    }

    // Check readiness: need UTI, searchPost template, FeedItem template, and be on nextdoor.com
    if (!status.hasUti) {
      showMessage('warning', 'Browse Nextdoor to capture authentication');
      elements.searchBtn.disabled = true;
    } else if (!status.hasSearchPostTemplate) {
      showMessage('warning', 'Search on Nextdoor first, then click Deep Search');
      elements.searchBtn.disabled = true;
    } else if (!status.hasFeedItemTemplate) {
      showMessage('warning', 'Click on a post to capture thread template');
      elements.searchBtn.disabled = true;
    } else if (!status.isOnNextdoor) {
      showMessage('info', 'Navigate to nextdoor.com to use Deep Search');
      elements.searchBtn.disabled = true;
    } else {
      // Ready to search - check if we have a query available
      if (status.lastQuery) {
        showMessage('info', `Ready to search: "${status.lastQuery}"`);
        elements.searchBtn.disabled = false;
      } else {
        showMessage('info', 'Perform a search on Nextdoor first');
        elements.searchBtn.disabled = true;
      }
    }
    elements.searchBtn.textContent = 'Deep Search';
  }

  // ============================================================================
  // Message Display
  // ============================================================================

  function showMessage(type, text) {
    elements.message.textContent = text;
    elements.message.className = `message ${type}`;
  }

  function hideMessage() {
    elements.message.className = 'message';
  }

  // ============================================================================
  // Progress Updates
  // ============================================================================

  function updateProgress(progress) {
    if (!progress) return;

    const { current, total, errors } = progress;
    const percent = total > 0 ? (current / total) * 100 : 0;

    elements.progressBar.style.width = `${percent}%`;
    elements.progressText.textContent = `${current} / ${total}`;
    elements.errorCount.textContent = errors > 0 ? `(${errors} errors)` : '';
  }

  // ============================================================================
  // Result Display
  // ============================================================================

  function showResult(result) {
    elements.resultSection.style.display = 'block';
    elements.resultQuery.textContent = result.query || '--';
    elements.resultThreads.textContent = result.threads || 0;
    elements.resultComments.textContent = result.comments || 0;
    elements.resultErrors.textContent = result.errors || 0;
  }

  // ============================================================================
  // Search Action
  // ============================================================================

  async function startSearch() {
    if (isRunning) return;

    try {
      isRunning = true;
      elements.searchBtn.textContent = 'Searching...';
      elements.searchBtn.disabled = true;
      elements.searchBtn.classList.add('running');
      elements.progressSection.style.display = 'block';
      elements.progressBar.style.width = '0%';
      elements.progressText.textContent = 'Starting...';
      elements.errorCount.textContent = '';
      showMessage('info', 'Deep search in progress...');

      await browser.runtime.sendMessage({ type: 'START_SEARCH' });
    } catch (e) {
      console.error('[NDS Popup] Error starting search:', e);
      showMessage('error', 'Failed to start search: ' + e.message);
      isRunning = false;
      elements.searchBtn.textContent = 'Deep Search';
      elements.searchBtn.disabled = false;
      elements.searchBtn.classList.remove('running');
      elements.progressSection.style.display = 'none';
    }
  }

  // ============================================================================
  // Background Message Handling
  // ============================================================================

  function handleBackgroundMessage(message) {
    console.log('[NDS Popup] Received message:', message.type);

    switch (message.type) {
      case 'PROGRESS':
        updateProgress(message.data);
        break;

      case 'COMPLETE':
        isRunning = false;
        elements.searchBtn.textContent = 'Deep Search';
        elements.searchBtn.disabled = false;
        elements.searchBtn.classList.remove('running');
        showMessage('success', 'Search complete! Results opened in new tab.');
        showResult(message.data);
        refreshStatus(); // Update session count
        window.close(); // Close popup after search completes
        break;

      case 'ERROR':
        isRunning = false;
        elements.searchBtn.textContent = 'Deep Search';
        elements.searchBtn.disabled = false;
        elements.searchBtn.classList.remove('running');
        elements.progressSection.style.display = 'none';
        showMessage('error', message.data.message);
        break;
    }
  }

  // ============================================================================
  // Settings
  // ============================================================================

  function openSettings() {
    browser.runtime.openOptionsPage();
  }

  // ============================================================================
  // View Results
  // ============================================================================

  async function viewResults() {
    try {
      await browser.runtime.sendMessage({ type: 'VIEW_RESULTS' });
      window.close();
    } catch (e) {
      console.error('[NDS Popup] Error viewing results:', e);
      showMessage('error', 'Failed to open results page');
    }
  }

  // ============================================================================
  // Start
  // ============================================================================

  init();

})();
