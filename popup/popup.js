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
    setupSection: document.getElementById('setup-section'),
    stepBrowse: document.getElementById('step-browse'),
    stepBrowseIcon: document.getElementById('step-browse-icon'),
    stepBrowseHint: document.getElementById('step-browse-hint'),
    stepSearch: document.getElementById('step-search'),
    stepSearchIcon: document.getElementById('step-search-icon'),
    stepSearchHint: document.getElementById('step-search-hint'),
    stepThread: document.getElementById('step-thread'),
    stepThreadIcon: document.getElementById('step-thread-icon'),
    stepThreadHint: document.getElementById('step-thread-hint'),
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
    // Update stepper
    updateStepper(status);

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

  function updateStepper(status) {
    const steps = [
      { done: status.hasUti, el: elements.stepBrowse, icon: elements.stepBrowseIcon, hint: elements.stepBrowseHint, num: '1', hintText: 'Go to nextdoor.com' },
      { done: status.hasSearchPostTemplate, el: elements.stepSearch, icon: elements.stepSearchIcon, hint: elements.stepSearchHint, num: '2', hintText: 'Search for anything on Nextdoor' },
      { done: status.hasFeedItemTemplate, el: elements.stepThread, icon: elements.stepThreadIcon, hint: elements.stepThreadHint, num: '3', hintText: 'Click any post on Nextdoor' },
    ];

    let firstIncomplete = -1;
    const allDone = steps.every(s => s.done);

    steps.forEach((step, i) => {
      step.icon.setAttribute('data-step', step.num);
      step.hint.textContent = '';
      step.hint.classList.remove('visible');
      step.el.classList.remove('done', 'active');

      if (step.done) {
        step.icon.className = 'step-icon done';
        step.el.classList.add('done');
      } else if (firstIncomplete === -1) {
        firstIncomplete = i;
        step.icon.className = 'step-icon active';
        step.el.classList.add('active');
        step.hint.textContent = step.hintText;
        step.hint.classList.add('visible');
      } else {
        step.icon.className = 'step-icon pending';
      }
    });

    if (allDone) {
      elements.setupSection.classList.add('all-done');
    } else {
      elements.setupSection.classList.remove('all-done');
    }
  }

  function updateMessageAndButton(status) {
    if (isRunning) {
      showMessage('info', 'Deep search in progress...');
      return;
    }

    const allCaptured = status.hasUti && status.hasSearchPostTemplate && status.hasFeedItemTemplate;

    if (!allCaptured) {
      // Stepper handles the instructions; hide the message
      hideMessage();
      elements.searchBtn.disabled = true;
    } else if (!status.isOnNextdoor) {
      showMessage('info', 'Navigate to nextdoor.com to use Deep Search');
      elements.searchBtn.disabled = true;
    } else if (status.query || status.lastQuery) {
      const q = status.query || status.lastQuery;
      showMessage('info', `"${q}" — extract all comments and details`);
      elements.searchBtn.disabled = false;
    } else {
      showMessage('info', 'Search on Nextdoor first, then click Deep Search to extract full details');
      elements.searchBtn.disabled = true;
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
      elements.resultSection.style.display = 'none';
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
