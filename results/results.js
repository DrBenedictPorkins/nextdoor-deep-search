/**
 * Nextdoor Deep Search - Results Page Script
 *
 * Handles:
 * 1. Loading and rendering search results
 * 2. AI configuration modal
 * 3. AI analysis streaming
 * 4. Follow-up questions
 */

(function() {
  'use strict';

  // DOM Elements
  const elements = {
    queryText: document.getElementById('query-text'),
    threadCount: document.getElementById('thread-count'),
    commentCount: document.getElementById('comment-count'),
    timestamp: document.getElementById('timestamp'),
    analyzeBtn: document.getElementById('analyze-btn'),
    resultsContainer: document.getElementById('results-container'),
    aiSection: document.getElementById('ai-section'),
    aiMessages: document.getElementById('ai-messages'),
    aiLoading: document.getElementById('ai-loading'),
    followupInput: document.getElementById('followup-input'),
    sendBtn: document.getElementById('send-btn'),
    clearChatBtn: document.getElementById('clear-chat-btn'),
    configModal: document.getElementById('config-modal'),
    closeModalBtn: document.getElementById('close-modal-btn'),
    cancelModalBtn: document.getElementById('cancel-modal-btn'),
    saveConfigBtn: document.getElementById('save-config-btn'),
    claudeConfig: document.getElementById('claude-config'),
    validationStatus: document.getElementById('validation-status'),
    debugLogs: document.getElementById('debug-logs'),
    refreshLogsBtn: document.getElementById('refresh-logs-btn'),
    imageOverlay: document.getElementById('image-overlay'),
    imageOverlayImg: document.getElementById('image-overlay-img'),
    aiProviderBadge: document.getElementById('ai-provider-badge')
  };

  // State
  let searchData = null;
  let hasAIConfig = false;
  let currentAIConfig = null;
  let isAnalyzing = false;
  let port = null;
  let currentAssistantMessage = null;
  let accumulatedResponse = ''; // Accumulate full response for cleaning
  let currentToolUsage = []; // Track tool usage for current response
  let toolStartTime = null; // Track timing for tool execution

  // ============================================================================
  // URL/Image Helpers
  // ============================================================================

  /**
   * Check if a URL points to an image
   */
  function isImageUrl(url) {
    return /\.(jpg|jpeg|png|gif|webp|svg|bmp)(\?.*)?$/i.test(url);
  }

  /**
   * Escape HTML special characters to prevent XSS
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Convert URLs in text to clickable links
   * Image URLs get special handling (shown in overlay on click)
   */
  function linkifyText(text) {
    if (!text) return '';

    // Escape HTML first
    const escaped = escapeHtml(text);

    // URL regex pattern
    const urlPattern = /(https?:\/\/[^\s<]+)/g;

    return escaped.replace(urlPattern, (url) => {
      const isImage = isImageUrl(url);
      const className = isImage ? 'image-link' : '';
      const dataAttr = isImage ? `data-image-url="${url}"` : '';
      const target = isImage ? '' : 'target="_blank" rel="noopener noreferrer"';

      return `<a href="${url}" class="${className}" ${dataAttr} ${target}>${url}</a>`;
    });
  }

  /**
   * Show image in overlay
   */
  function showImageOverlay(url) {
    elements.imageOverlayImg.src = url;
    elements.imageOverlay.style.display = 'flex';
    document.body.style.overflow = 'hidden'; // Prevent scrolling
  }

  /**
   * Hide image overlay
   */
  function hideImageOverlay() {
    elements.imageOverlay.style.display = 'none';
    elements.imageOverlayImg.src = '';
    document.body.style.overflow = ''; // Restore scrolling
  }

  /**
   * Handle clicks on linkified content
   */
  function handleLinkClick(e) {
    const link = e.target.closest('a.image-link');
    if (link) {
      e.preventDefault();
      const imageUrl = link.dataset.imageUrl || link.href;
      showImageOverlay(imageUrl);
    }
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  async function init() {
    // Load search data
    await loadSearchData();

    // Check AI configuration
    await checkAIConfig();

    // Load existing chat history (if returning to results)
    await loadChatHistory();

    // Set up event listeners
    elements.analyzeBtn.addEventListener('click', handleAnalyzeClick);
    elements.sendBtn.addEventListener('click', handleSendClick);
    elements.followupInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendClick();
      }
    });
    elements.clearChatBtn.addEventListener('click', handleClearChat);

    // Modal event listeners
    elements.closeModalBtn.addEventListener('click', closeModal);
    elements.cancelModalBtn.addEventListener('click', closeModal);
    elements.saveConfigBtn.addEventListener('click', handleSaveConfig);

    // Connect to background for streaming
    port = browser.runtime.connect({ name: 'analysis' });
    port.onMessage.addListener(handleBackgroundMessage);

    // Image overlay event listeners
    elements.imageOverlay.querySelector('.image-overlay-backdrop').addEventListener('click', hideImageOverlay);
    elements.imageOverlay.querySelector('.image-overlay-close').addEventListener('click', hideImageOverlay);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && elements.imageOverlay.style.display !== 'none') {
        hideImageOverlay();
      }
    });

    // Delegate click handling for image links in results
    elements.resultsContainer.addEventListener('click', handleLinkClick);
  }

  // ============================================================================
  // Debug Logs
  // ============================================================================

  async function loadDebugLogs() {
    try {
      const response = await browser.runtime.sendMessage({ type: 'GET_DEBUG_LOGS' });
      if (response.type === 'DEBUG_LOGS' && response.data) {
        const logs = response.data;
        if (logs.length === 0) {
          elements.debugLogs.textContent = 'No logs yet. Perform a search to generate logs.';
        } else {
          elements.debugLogs.textContent = logs.map(l =>
            `[${l.timestamp}] ${l.level}: ${l.message}`
          ).join('\n');
          // Scroll to bottom
          elements.debugLogs.scrollTop = elements.debugLogs.scrollHeight;
        }
      } else {
        elements.debugLogs.textContent = 'Failed to load logs';
      }
    } catch (e) {
      elements.debugLogs.textContent = `Error: ${e.message}`;
    }
  }

  // ============================================================================
  // Load and Render Search Data
  // ============================================================================

  async function loadSearchData() {
    try {
      const data = await browser.storage.local.get(['lastSearchData']);
      if (!data.lastSearchData || !data.lastSearchData.threads) {
        showError('No search data found. Please run a Deep Search first.');
        return;
      }

      searchData = data.lastSearchData;
      renderHeader();
      renderResults();
    } catch (e) {
      console.error('[NDS Results] Error loading search data:', e);
      showError('Failed to load search data: ' + e.message);
    }
  }

  /**
   * Recursively counts all comments including nested replies
   */
  function countAllComments(comments) {
    let count = 0;
    for (const comment of comments) {
      count++; // Count this comment
      if (comment.replies && comment.replies.length > 0) {
        count += countAllComments(comment.replies); // Recursively count replies
      }
    }
    return count;
  }

  function renderHeader() {
    elements.queryText.textContent = `"${searchData.query}"`;

    // Count all comments including nested replies
    const totalComments = searchData.threads.reduce((sum, thread) => {
      return sum + countAllComments(thread.comments);
    }, 0);

    elements.threadCount.textContent = `${searchData.threads.length} thread${searchData.threads.length !== 1 ? 's' : ''}`;
    elements.commentCount.textContent = `${totalComments} comment${totalComments !== 1 ? 's' : ''}`;

    const date = new Date(searchData.timestamp);
    elements.timestamp.textContent = date.toLocaleString();
  }

  function renderResults() {
    elements.resultsContainer.innerHTML = '';

    for (const thread of searchData.threads) {
      const card = createThreadCard(thread);
      elements.resultsContainer.appendChild(card);
    }
  }

  function createThreadCard(thread) {
    const card = document.createElement('div');
    card.className = 'thread-card';

    const header = document.createElement('div');
    header.className = 'thread-header';

    const title = document.createElement('h3');
    title.className = 'thread-title';
    title.textContent = thread.op.subject || '(No subject)';

    const link = document.createElement('a');
    link.className = 'thread-link';
    link.href = thread.url;
    link.target = '_blank';
    link.textContent = 'View on Nextdoor';

    header.appendChild(title);
    header.appendChild(link);

    const meta = document.createElement('div');
    meta.className = 'thread-meta';

    const author = document.createElement('span');
    author.className = 'author';
    author.textContent = thread.op.author;

    const location = document.createElement('span');
    location.className = 'location';
    location.textContent = thread.op.location;

    const date = document.createElement('span');
    date.className = 'date';
    date.textContent = thread.op.createdAt;

    meta.appendChild(author);
    meta.appendChild(document.createTextNode(' • '));
    meta.appendChild(location);
    meta.appendChild(document.createTextNode(' • '));
    meta.appendChild(date);

    const body = document.createElement('div');
    body.className = 'thread-body';
    body.innerHTML = linkifyText(thread.op.body) || '(empty)';

    card.appendChild(header);
    card.appendChild(meta);
    card.appendChild(body);

    if (thread.comments.length > 0) {
      const commentsSection = createCommentsSection(thread.comments);
      card.appendChild(commentsSection);
    }

    return card;
  }

  function createCommentsSection(comments) {
    const section = document.createElement('div');
    section.className = 'comments-section';

    const totalCount = countAllComments(comments);
    const heading = document.createElement('h4');
    heading.textContent = `Comments (${totalCount} total, ${comments.length} top-level)`;
    section.appendChild(heading);

    for (const comment of comments) {
      const commentCard = createCommentCard(comment, 0);
      section.appendChild(commentCard);
    }

    return section;
  }

  function createCommentCard(comment, level = 0) {
    const card = document.createElement('div');
    card.className = 'comment-card';

    // Add indentation for nested replies
    if (level > 0) {
      card.style.marginLeft = `${level * 20}px`;
      card.style.borderLeft = '3px solid #E0E0E0';
      card.style.paddingLeft = '12px';
    }

    const header = document.createElement('div');
    header.className = 'comment-header';

    const author = document.createElement('span');
    author.className = 'comment-author';
    author.textContent = comment.author;

    const location = document.createElement('span');
    location.className = 'comment-location';
    location.textContent = `(${comment.location})`;

    const date = document.createElement('span');
    date.className = 'comment-date';
    date.textContent = comment.createdAt;

    header.appendChild(author);
    header.appendChild(document.createTextNode(' '));
    header.appendChild(location);
    header.appendChild(date);

    // Add level indicator for nested replies
    if (level > 0) {
      const levelBadge = document.createElement('span');
      levelBadge.className = 'comment-level';
      levelBadge.textContent = `Reply level ${level}`;
      levelBadge.style.fontSize = '11px';
      levelBadge.style.color = '#757575';
      levelBadge.style.marginLeft = '8px';
      levelBadge.style.fontStyle = 'italic';
      header.appendChild(levelBadge);
    }

    const body = document.createElement('div');
    body.className = 'comment-body';
    body.innerHTML = linkifyText(comment.body) || '(empty)';

    card.appendChild(header);
    card.appendChild(body);

    if (comment.phone || comment.business) {
      const meta = document.createElement('div');
      meta.className = 'comment-meta';

      if (comment.phone) {
        const phone = document.createElement('span');
        phone.className = 'comment-phone';
        phone.textContent = comment.phone;
        meta.appendChild(phone);
      }

      if (comment.business) {
        const business = document.createElement('div');
        business.className = 'comment-business';

        const name = document.createElement('span');
        name.className = 'business-name';
        name.textContent = comment.business.name;
        business.appendChild(name);

        if (comment.business.category) {
          const category = document.createElement('span');
          category.className = 'business-category';
          category.textContent = ` - ${comment.business.category}`;
          business.appendChild(category);
        }

        if (comment.business.faves) {
          const faves = document.createElement('span');
          faves.className = 'business-faves';
          faves.textContent = `${comment.business.faves} faves`;
          business.appendChild(faves);
        }

        if (comment.business.address) {
          const address = document.createElement('div');
          address.className = 'business-address';
          address.textContent = comment.business.address;
          business.appendChild(address);
        }

        meta.appendChild(business);
      }

      card.appendChild(meta);
    }

    // Recursively render nested replies
    if (comment.replies && comment.replies.length > 0) {
      const repliesContainer = document.createElement('div');
      repliesContainer.className = 'replies-container';

      for (const reply of comment.replies) {
        const replyCard = createCommentCard(reply, level + 1);
        repliesContainer.appendChild(replyCard);
      }

      card.appendChild(repliesContainer);
    }

    return card;
  }

  function showError(message) {
    elements.resultsContainer.innerHTML = `
      <div style="padding: 40px; text-align: center; color: #C62828;">
        <h2>Error</h2>
        <p>${message}</p>
      </div>
    `;
  }

  // ============================================================================
  // AI Configuration
  // ============================================================================

  async function checkAIConfig() {
    try {
      const data = await browser.storage.local.get(['aiConfig']);
      hasAIConfig = !!(data.aiConfig && data.aiConfig.provider);
      currentAIConfig = data.aiConfig || null;
      updateProviderBadge();
    } catch (e) {
      console.error('[NDS Results] Error checking AI config:', e);
      hasAIConfig = false;
      currentAIConfig = null;
    }
  }

  function updateProviderBadge() {
    if (!currentAIConfig || !currentAIConfig.claude) {
      elements.aiProviderBadge.textContent = '';
      return;
    }

    elements.aiProviderBadge.textContent = `Claude • ${currentAIConfig.claude.model}`;
  }

  async function loadChatHistory() {
    try {
      const response = await browser.runtime.sendMessage({ type: 'GET_CHAT_HISTORY' });
      console.log('[NDS Results] GET_CHAT_HISTORY response:', response);
      const chatHistory = response?.data || [];
      console.log('[NDS Results] Chat history length:', chatHistory.length);

      if (chatHistory.length > 0) {
        // Show AI section and activate split layout
        elements.aiSection.style.display = 'flex';
        document.querySelector('.results-page').classList.add('ai-active');

        // Hide the analyze button since we already have analysis
        elements.analyzeBtn.style.display = 'none';

        // Render all chat messages
        elements.aiMessages.innerHTML = '';
        for (const msg of chatHistory) {
          const bubble = createMessageBubble(msg.role, msg.role === 'assistant' ? cleanLLMResponse(msg.content) : msg.content);
          elements.aiMessages.appendChild(bubble);
        }

        // Scroll to bottom
        scrollToBottom();
      }
    } catch (e) {
      console.error('[NDS Results] Error loading chat history:', e);
    }
  }

  async function handleAnalyzeClick() {
    if (isAnalyzing) return;

    if (!hasAIConfig) {
      // Show config modal
      showConfigModal();
    } else {
      // Start analysis
      startAnalysis();
    }
  }

  function showConfigModal() {
    elements.configModal.style.display = 'flex';
  }

  function closeModal() {
    elements.configModal.style.display = 'none';
    elements.validationStatus.style.display = 'none';
  }

  async function handleSaveConfig() {
    const apiKey = document.getElementById('claude-key').value.trim();
    const model = document.getElementById('claude-model').value;

    if (!apiKey) {
      showValidationStatus('invalid', 'Please enter an API key');
      return;
    }

    const config = {
      provider: 'claude',
      claude: { apiKey, model }
    };

    // Validate config
    showValidationStatus('validating', 'Validating configuration...');

    try {
      await validateConfig(config);
      showValidationStatus('valid', 'Configuration valid!');

      // Save config
      await browser.storage.local.set({ aiConfig: config });
      hasAIConfig = true;

      // Close modal and start analysis
      setTimeout(() => {
        closeModal();
        startAnalysis();
      }, 500);
    } catch (e) {
      showValidationStatus('invalid', e.message);
    }
  }

  function showValidationStatus(type, message) {
    elements.validationStatus.className = `validation-status ${type}`;
    elements.validationStatus.textContent = message;
    elements.validationStatus.style.display = 'block';
  }

  async function validateConfig(config) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.claude.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'test' }]
      })
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Invalid API key');
      }
      throw new Error(`API error: ${response.status}`);
    }
  }

  // ============================================================================
  // AI Analysis
  // ============================================================================

  async function startAnalysis() {
    if (isAnalyzing) return;

    isAnalyzing = true;
    elements.analyzeBtn.disabled = true;
    elements.analyzeBtn.textContent = 'Analyzing...';

    // Refresh AI config and update provider badge
    await checkAIConfig();

    // Clear chat history in background
    try {
      await browser.runtime.sendMessage({ type: 'CLEAR_CHAT' });
    } catch (e) {
      console.warn('[NDS Results] Could not clear chat history:', e);
    }

    // Show AI section and activate split layout
    elements.aiSection.style.display = 'flex';
    document.querySelector('.results-page').classList.add('ai-active');

    // Clear previous messages
    elements.aiMessages.innerHTML = '';

    // Show loading
    elements.aiLoading.style.display = 'block';

    // Create new assistant message bubble for streaming
    currentAssistantMessage = createMessageBubble('assistant', '');
    elements.aiMessages.appendChild(currentAssistantMessage);
    accumulatedResponse = ''; // Reset accumulated response

    try {
      await browser.runtime.sendMessage({ type: 'START_ANALYSIS' });
    } catch (e) {
      console.error('[NDS Results] Error starting analysis:', e);
      showAnalysisError(e.message);
      isAnalyzing = false;
      elements.analyzeBtn.disabled = false;
      elements.analyzeBtn.textContent = 'Analyze with AI';
    }
  }

  function handleSendClick() {
    const message = elements.followupInput.value.trim();
    if (!message || isAnalyzing) return;

    sendFollowupQuestion(message);
  }

  async function sendFollowupQuestion(message) {
    isAnalyzing = true;
    elements.followupInput.value = '';
    elements.sendBtn.disabled = true;
    elements.followupInput.disabled = true;

    // Add user message bubble
    const userBubble = createMessageBubble('user', message);
    elements.aiMessages.appendChild(userBubble);

    // Show loading
    elements.aiLoading.style.display = 'block';

    // Create new assistant message bubble for streaming
    currentAssistantMessage = createMessageBubble('assistant', '');
    elements.aiMessages.appendChild(currentAssistantMessage);
    accumulatedResponse = ''; // Reset accumulated response

    // Scroll after all elements are added (use setTimeout to ensure DOM is updated)
    setTimeout(scrollToBottom, 0);

    try {
      await browser.runtime.sendMessage({
        type: 'SEND_CHAT_MESSAGE',
        data: { message }
      });
    } catch (e) {
      console.error('[NDS Results] Error sending chat message:', e);
      showAnalysisError(e.message);
      isAnalyzing = false;
      elements.sendBtn.disabled = false;
      elements.followupInput.disabled = false;
    }
  }

  function handleClearChat() {
    if (confirm('Clear chat history?')) {
      elements.aiMessages.innerHTML = '';
      browser.runtime.sendMessage({ type: 'CLEAR_CHAT' });
    }
  }

  // ============================================================================
  // Message Handling
  // ============================================================================

  function handleBackgroundMessage(message) {
    console.log('[NDS Results] Received message:', message.type);

    switch (message.type) {
      case 'ANALYSIS_START':
        // Analysis started
        break;

      case 'ANALYSIS_CHUNK':
        appendToCurrentMessage(message.data.chunk);
        break;

      case 'ANALYSIS_COMPLETE':
        elements.aiLoading.style.display = 'none';
        isAnalyzing = false;
        elements.analyzeBtn.style.display = 'none'; // Hide the button after initial analysis
        elements.sendBtn.disabled = false;
        elements.followupInput.disabled = false;
        scrollToBottom();
        break;

      case 'ANALYSIS_ERROR':
        elements.aiLoading.style.display = 'none';
        showAnalysisError(message.data.message);
        isAnalyzing = false;
        elements.analyzeBtn.disabled = false;
        elements.analyzeBtn.textContent = 'Analyze with AI';
        elements.sendBtn.disabled = false;
        elements.followupInput.disabled = false;
        break;

      case 'CHAT_START':
        // Chat started - reset tool usage tracking
        currentToolUsage = [];
        break;

      case 'CHAT_CHUNK':
        hideLLMThinking();
        appendToCurrentMessage(message.data.chunk);
        break;

      case 'CHAT_COMPLETE':
        elements.aiLoading.style.display = 'none';
        isAnalyzing = false;
        elements.sendBtn.disabled = false;
        elements.followupInput.disabled = false;
        // Add tool usage badge if tools were used
        if (currentToolUsage.length > 0 && currentAssistantMessage) {
          addToolUsageBadge(currentAssistantMessage, currentToolUsage);
        }
        currentToolUsage = [];
        scrollToBottom();
        break;

      case 'CHAT_ERROR':
        elements.aiLoading.style.display = 'none';
        showAnalysisError(message.data.message);
        isAnalyzing = false;
        elements.sendBtn.disabled = false;
        elements.followupInput.disabled = false;
        currentToolUsage = [];
        break;

      case 'TOOL_EXECUTING':
        toolStartTime = Date.now();
        showToolIndicator(message.query, 'searching');
        // Track this tool execution
        currentToolUsage.push({
          query: message.query,
          resultCount: null,
          duration: null
        });
        break;

      case 'TOOL_PROGRESS':
        updateToolIndicator(message.status, message.message, message.current, message.total);
        break;

      case 'TOOL_COMPLETE':
        updateToolIndicator('complete', `Found ${message.resultCount} thread${message.resultCount !== 1 ? 's' : ''}`);
        // Update the last tool execution with results
        if (currentToolUsage.length > 0) {
          const lastTool = currentToolUsage[currentToolUsage.length - 1];
          lastTool.resultCount = message.resultCount;
          lastTool.duration = toolStartTime ? Date.now() - toolStartTime : null;
        }
        toolStartTime = null;
        break;

      case 'LLM_THINKING':
        showLLMThinking(message.message);
        break;
    }
  }

  function createMessageBubble(role, content) {
    const bubble = document.createElement('div');
    bubble.className = `message-bubble ${role}`;

    if (role === 'assistant') {
      // For assistant, content will be HTML
      bubble.innerHTML = content;
    } else {
      // For user, plain text
      bubble.textContent = content;
    }

    return bubble;
  }

  function appendToCurrentMessage(chunk) {
    if (!currentAssistantMessage) return;

    // Accumulate the response
    accumulatedResponse += chunk;

    // Clean and render the accumulated response
    currentAssistantMessage.innerHTML = cleanLLMResponse(accumulatedResponse);
    scrollToBottom();
  }

  function cleanLLMResponse(text) {
    // Detect format from code fence: ```html, ```markdown, ```md, or none
    const htmlMatch = text.match(/^```html\s*\n?([\s\S]*?)(?:\n?```\s*$|$)/i);
    const mdMatch = text.match(/^```(?:markdown|md)\s*\n?([\s\S]*?)(?:\n?```\s*$|$)/i);

    let content;
    let isMarkdown = false;

    if (htmlMatch) {
      // Explicitly marked as HTML
      content = htmlMatch[1];
    } else if (mdMatch) {
      // Explicitly marked as markdown
      content = mdMatch[1];
      isMarkdown = true;
    } else {
      // No fence or unknown fence - check if it looks like HTML or markdown
      // Strip any code fences first
      content = text.replace(/^```\w*\s*\n?/gm, '').replace(/\n?```\s*$/gm, '').replace(/```/g, '');

      // If it doesn't start with HTML tag, assume markdown
      if (!content.trim().match(/^<[a-z]/i)) {
        isMarkdown = true;
      }
    }

    content = content.trim();

    // Convert markdown to HTML if needed
    if (isMarkdown) {
      content = markdownToHtml(content);
    }

    return content;
  }

  function markdownToHtml(text) {
    let html = text;

    // Escape HTML entities first (but preserve any existing HTML tags for hybrid content)
    // Only escape if it looks like pure markdown (no HTML tags)
    if (!html.match(/<[a-z][^>]*>/i)) {
      html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Headers (must be at start of line)
    html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^##\s+(.+)$/gm, '<h2 style="color:green;">$1</h2>');
    html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

    // Bold and italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Blockquotes
    html = html.replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>');
    // Merge consecutive blockquotes
    html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');

    // Unordered lists
    html = html.replace(/^[-*+]\s+(.+)$/gm, '<li>$1</li>');
    // Wrap consecutive <li> in <ul>
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    // Ordered lists
    html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

    // Horizontal rules
    html = html.replace(/^---+$/gm, '<hr>');
    html = html.replace(/^\*\*\*+$/gm, '<hr>');

    // Paragraphs - wrap lines that aren't already wrapped in tags
    html = html.replace(/^(?!<[a-z]|$)(.+)$/gm, '<p>$1</p>');

    // Clean up empty paragraphs and extra whitespace
    html = html.replace(/<p>\s*<\/p>/g, '');
    html = html.replace(/\n{3,}/g, '\n\n');

    return html;
  }

  function resetAccumulatedResponse() {
    accumulatedResponse = '';
  }

  function showAnalysisError(message) {
    if (currentAssistantMessage) {
      currentAssistantMessage.style.background = '#FFEBEE';
      currentAssistantMessage.style.color = '#C62828';
      currentAssistantMessage.innerHTML = `<strong>Error:</strong> ${message}`;
    }
  }

  function scrollToBottom() {
    elements.aiMessages.scrollTop = elements.aiMessages.scrollHeight;
  }

  let currentToolQuery = '';

  function showToolIndicator(query, status) {
    currentToolQuery = query;
    // Create or show the tool indicator
    let indicator = document.getElementById('tool-indicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'tool-indicator';
      indicator.className = 'tool-indicator';
      // Insert in the ai-messages area
      elements.aiMessages.appendChild(indicator);
    }
    indicator.innerHTML = `
      <div class="tool-indicator-content">
        <div class="tool-spinner"></div>
        <div class="tool-status">
          <span class="tool-query">Searching "<strong>${escapeHtml(query)}</strong>"</span>
          <span class="tool-message">Searching Nextdoor...</span>
        </div>
      </div>
    `;
    indicator.style.display = 'flex';

    // Scroll to bottom
    scrollToBottom();
  }

  function updateToolIndicator(status, message, current, total) {
    const indicator = document.getElementById('tool-indicator');
    if (!indicator) return;

    if (status === 'complete') {
      indicator.innerHTML = `
        <div class="tool-indicator-content tool-complete">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 6L9 17l-5-5"/>
          </svg>
          <div class="tool-status">
            <span class="tool-query">"${escapeHtml(currentToolQuery)}"</span>
            <span class="tool-message">${escapeHtml(message)}</span>
          </div>
        </div>
      `;
      // Hide after delay
      setTimeout(() => {
        indicator.style.display = 'none';
      }, 1500);
    } else if (status === 'fetching_thread') {
      // Show progress bar for thread fetching
      const percent = total > 0 ? (current / total) * 100 : 0;
      indicator.innerHTML = `
        <div class="tool-indicator-content">
          <div class="tool-spinner"></div>
          <div class="tool-status">
            <span class="tool-query">"${escapeHtml(currentToolQuery)}"</span>
            <span class="tool-message">${escapeHtml(message)}</span>
            <div class="tool-progress-bar">
              <div class="tool-progress-fill" style="width: ${percent}%"></div>
            </div>
          </div>
        </div>
      `;
    } else {
      // Generic status update
      const statusEl = indicator.querySelector('.tool-message');
      if (statusEl) {
        statusEl.textContent = message;
      }
    }
    scrollToBottom();
  }

  function showLLMThinking(message) {
    // Hide tool indicator if visible
    const toolIndicator = document.getElementById('tool-indicator');
    if (toolIndicator) {
      toolIndicator.style.display = 'none';
    }

    // Show LLM thinking indicator
    let indicator = document.getElementById('llm-indicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'llm-indicator';
      indicator.className = 'tool-indicator llm-thinking';
      elements.aiMessages.appendChild(indicator);
    }
    indicator.innerHTML = `
      <div class="tool-indicator-content">
        <div class="tool-spinner"></div>
        <span>${escapeHtml(message)}</span>
      </div>
    `;
    indicator.style.display = 'flex';
    scrollToBottom();
  }

  function hideLLMThinking() {
    const indicator = document.getElementById('llm-indicator');
    if (indicator) {
      indicator.style.display = 'none';
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function addToolUsageBadge(messageBubble, toolUsage) {
    // Create badge container
    const badge = document.createElement('div');
    badge.className = 'tool-usage-badge';

    // Create the badge icon and label
    const totalResults = toolUsage.reduce((sum, t) => sum + (t.resultCount || 0), 0);
    badge.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8"/>
        <path d="M21 21l-4.35-4.35"/>
      </svg>
      <span>${toolUsage.length} search${toolUsage.length !== 1 ? 'es' : ''}</span>
    `;

    // Create tooltip
    const tooltip = document.createElement('div');
    tooltip.className = 'tool-usage-tooltip';

    let tooltipContent = '<div class="tooltip-title">Nextdoor Searches</div>';
    for (const tool of toolUsage) {
      const duration = tool.duration ? `${(tool.duration / 1000).toFixed(1)}s` : '—';
      const results = tool.resultCount !== null ? `${tool.resultCount} thread${tool.resultCount !== 1 ? 's' : ''}` : '—';
      tooltipContent += `
        <div class="tooltip-item">
          <div class="tooltip-query">"${escapeHtml(tool.query)}"</div>
          <div class="tooltip-stats">
            <span class="tooltip-results">${results}</span>
            <span class="tooltip-duration">${duration}</span>
          </div>
        </div>
      `;
    }
    tooltip.innerHTML = tooltipContent;

    badge.appendChild(tooltip);

    // Make the message bubble position relative for badge positioning
    messageBubble.style.position = 'relative';
    messageBubble.appendChild(badge);
  }

  // ============================================================================
  // Start
  // ============================================================================

  init();

})();
