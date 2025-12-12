/**
 * Nextdoor Deep Search - Background Script
 *
 * Responsibilities:
 * 1. Network monitoring - capture UTI from API requests
 * 2. Tab monitoring - detect search pages, update badge
 * 3. API orchestration - fetch threads via GraphQL
 * 4. Download handling - format markdown and trigger download
 */

// ============================================================================
// Debug Logging - persisted to storage for debugging
// ============================================================================

const debugLogs = [];
const MAX_LOGS = 500;

function log(level, ...args) {
  const timestamp = new Date().toISOString();
  const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  const entry = { timestamp, level, message };

  debugLogs.push(entry);
  if (debugLogs.length > MAX_LOGS) {
    debugLogs.shift();
  }

  // Also log to console
  const prefix = `[NDS ${level}]`;
  if (level === 'ERROR') {
    console.error(prefix, ...args);
  } else if (level === 'WARN') {
    console.warn(prefix, ...args);
  } else {
    console.log(prefix, ...args);
  }

  // Persist to storage immediately for debugging
  browser.storage.local.set({ debugLogs: debugLogs.slice(-200) });
}

// Expose log retrieval for popup/options
async function getDebugLogs() {
  const data = await browser.storage.local.get('debugLogs');
  return data.debugLogs || debugLogs;
}

// ============================================================================
// State Management
// ============================================================================

const state = {
  uti: null,
  utiCapturedAt: null,
  currentTabId: null,
  isOnSearchPage: false,
  isOnNextdoor: false,  // New: track if on nextdoor.com domain
  currentQuery: null,
  lastQuery: null,  // Persist captured queries from search page for use from non-search pages
  isRunning: false,
  progress: { current: 0, total: 0, errors: 0 },
  lastResult: null,
  resultsTabId: null,  // Track the results tab for reuse
  sessionSearchCount: 0,
  chatHistory: [],
  isAnalyzing: false,
  credentials: {
    csrf: null,
    train: null,
    uti: null
  },
  // Captured request templates - captured fresh each session from browser requests
  // NEVER persisted to storage - must be captured fresh from user's browser activity
  captured: {
    searchPost: null,  // { hash, headers, payload } - captured when user searches
    feedItem: null     // { hash, headers, payload } - captured when user clicks a thread
  },
  accumulatedSearches: [] // for tool call context accumulation
};

// Load persisted state on startup
async function initializeState() {
  const data = await browser.storage.local.get(['uti', 'utiCapturedAt', 'capturedTemplates']);

  if (data.uti) {
    state.uti = data.uti;
    state.utiCapturedAt = data.utiCapturedAt;
    console.log('[NDS] Loaded UTI from storage, captured at:', new Date(data.utiCapturedAt).toLocaleString());
  }

  if (data.capturedTemplates) {
    const { searchPost, feedItem } = data.capturedTemplates;
    if (searchPost) {
      state.captured.searchPost = searchPost;
      console.log('[NDS] Loaded searchPost template from storage');
    }
    if (feedItem) {
      state.captured.feedItem = feedItem;
      console.log('[NDS] Loaded FeedItem template from storage');
    }
    updateBadge();
  }
}

// Persist templates to storage
function persistTemplates() {
  const templates = {
    searchPost: state.captured.searchPost,
    feedItem: state.captured.feedItem
  };
  browser.storage.local.set({ capturedTemplates: templates });
  console.log('[NDS] Templates persisted to storage');
}

// Initialize on startup
initializeState();

// Clean up any old stored hashes from previous versions
browser.storage.local.remove(['searchPostHash', 'feedItemHash', 'capturedHeaders']);

// ============================================================================
// Network Monitoring - Capture request templates from browser
// ============================================================================

// Temporary storage for request bodies (onBeforeRequest fires before onSendHeaders)
const pendingRequestBodies = new Map();

// Step 1: Capture request body (payload) - fires first
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Only capture from actual browser tabs, NOT from extension's own fetch() calls
    if (details.tabId === -1) return;
    if (!details.requestBody?.raw) return;

    const isSearchPost = details.url.includes('/api/gql/searchPost');
    const isFeedItem = details.url.includes('/api/gql/FeedItem');
    if (!isSearchPost && !isFeedItem) return;

    try {
      const decoder = new TextDecoder();
      const payload = JSON.parse(decoder.decode(details.requestBody.raw[0].bytes));

      // Skip requests made by the extension itself during deep search
      if (state.isRunning) {
        return;
      }

      // Store temporarily for onSendHeaders to pick up
      pendingRequestBodies.set(details.requestId, {
        type: isSearchPost ? 'searchPost' : 'feedItem',
        payload
      });

      // Clean up old entries after 5 seconds
      setTimeout(() => pendingRequestBodies.delete(details.requestId), 5000);
    } catch (e) { /* ignore parse errors */ }
  },
  { urls: ['*://nextdoor.com/api/gql/*'] },
  ['requestBody']
);

// Step 2: Capture headers and combine with payload - fires second
browser.webRequest.onSendHeaders.addListener(
  (details) => {
    // Only capture from actual browser tabs, NOT from extension's own fetch() calls
    if (details.tabId === -1) return;

    // Capture UTI from any Nextdoor API request
    const utiHeader = details.requestHeaders.find(h => h.name.toLowerCase() === 'x-nd-uti');
    if (utiHeader && utiHeader.value) {
      const newUti = utiHeader.value;
      if (newUti !== state.uti) {
        state.uti = newUti;
        state.utiCapturedAt = Date.now();
        browser.storage.local.set({ uti: newUti, utiCapturedAt: state.utiCapturedAt });
        console.log('[NDS] Captured new UTI:', newUti.substring(0, 8) + '...');
        updateBadge();
      }
    }

    // Check if we have a pending payload for this request
    const pending = pendingRequestBodies.get(details.requestId);
    if (!pending) return;
    pendingRequestBodies.delete(details.requestId);

    // Build headers object - capture ALL headers exactly as browser sends them
    const headers = {};
    for (const header of details.requestHeaders) {
      headers[header.name] = header.value;
    }

    // Extract hash from payload
    const hash = pending.payload?.extensions?.persistedQuery?.sha256Hash;

    // Store complete request template
    const template = {
      hash,
      headers,
      payload: pending.payload,
      capturedAt: Date.now()
    };

    if (pending.type === 'searchPost') {
      state.captured.searchPost = template;
      log('INFO', '========== CAPTURED searchPost ==========');
      log('INFO', 'Hash:', hash);
      log('INFO', 'Header count:', Object.keys(headers).length);
      log('INFO', 'Headers:', JSON.stringify(headers, null, 2));
      log('INFO', 'Payload:', JSON.stringify(pending.payload, null, 2));
      log('INFO', '========================================');
    } else {
      state.captured.feedItem = template;
      log('INFO', '========== CAPTURED FeedItem ==========');
      log('INFO', 'Hash:', hash);
      log('INFO', 'Header count:', Object.keys(headers).length);
      log('INFO', 'Headers:', JSON.stringify(headers, null, 2));
      log('INFO', 'Payload:', JSON.stringify(pending.payload, null, 2));
      log('INFO', '========================================');
    }

    // Persist templates to storage for next session
    persistTemplates();
    updateBadge();
  },
  { urls: ['*://nextdoor.com/api/gql/*'] },
  ['requestHeaders']
);

// ============================================================================
// Tab Monitoring - Detect Search Pages
// ============================================================================

function checkPageStatus(url) {
  if (!url) return { isNextdoor: false, isSearch: false, query: null };
  try {
    const parsed = new URL(url);
    const isNextdoor = parsed.hostname === 'nextdoor.com' || parsed.hostname.endsWith('.nextdoor.com');
    const isSearch = isNextdoor && parsed.pathname.includes('/search/posts');
    const query = isSearch ? parsed.searchParams.get('query') : null;
    return { isNextdoor, isSearch, query };
  } catch (e) {
    // Invalid URL
  }
  return { isNextdoor: false, isSearch: false, query: null };
}

function updateTabState(tabId, url) {
  const { isNextdoor, isSearch, query } = checkPageStatus(url);
  state.currentTabId = tabId;
  state.isOnNextdoor = isNextdoor;
  state.isOnSearchPage = isSearch;
  state.currentQuery = query;

  // Persist captured query for use from non-search pages
  if (query) {
    state.lastQuery = query;
  }

  updateBadge();
}

browser.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await browser.tabs.get(activeInfo.tabId);
    updateTabState(activeInfo.tabId, tab.url);
  } catch (e) {
    console.error('[NDS] Error getting tab:', e);
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    if (tab.active) {
      updateTabState(tabId, tab.url);
    }
  }
});

// Clean up resultsTabId when the results tab is closed
browser.tabs.onRemoved.addListener((tabId) => {
  if (state.resultsTabId === tabId) {
    console.log('[NDS] Results tab closed');
    state.resultsTabId = null;
  }
});

// ============================================================================
// Badge Management
// ============================================================================

function updateBadge() {
  let text = '';
  let color = '#888888'; // Gray - not ready

  const hasAllTemplates = !!state.captured.searchPost && !!state.captured.feedItem;

  if (state.isRunning) {
    text = '...';
    color = '#0066CC'; // Blue - running
  } else if (!state.uti) {
    text = '!';
    color = '#CC0000'; // Red - no UTI
  } else if (!hasAllTemplates) {
    text = '!';
    color = '#FFAA00'; // Yellow - missing templates
  } else if (state.isOnNextdoor) {
    text = 'GO';
    color = '#00A859'; // Green - ready (on nextdoor.com with all templates)
  } else {
    text = '';
    color = '#888888'; // Gray - not on nextdoor.com
  }

  browser.browserAction.setBadgeText({ text });
  browser.browserAction.setBadgeBackgroundColor({ color });
}

// ============================================================================
// Message Handling
// ============================================================================

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[NDS] Received message:', message.type);

  switch (message.type) {
    case 'GET_STATUS':
      sendResponse({
        type: 'STATUS',
        data: {
          hasUti: !!state.uti,
          utiCapturedAt: state.utiCapturedAt,
          isOnNextdoor: state.isOnNextdoor,
          isOnSearchPage: state.isOnSearchPage,
          query: state.currentQuery,
          isRunning: state.isRunning,
          progress: state.progress,
          lastResult: state.lastResult,
          hasLastResult: !!state.lastResult,  // For popup to know if results exist
          sessionSearchCount: state.sessionSearchCount,
          isAnalyzing: state.isAnalyzing,
          // New: show capture status
          hasSearchPostTemplate: !!state.captured.searchPost,
          hasFeedItemTemplate: !!state.captured.feedItem,
          lastQuery: state.lastQuery  // Persisted query for non-search page triggering
        }
      });
      return true;

    case 'START_SEARCH':
      if (state.isRunning) {
        sendResponse({ type: 'ERROR', data: { message: 'Search already in progress' } });
        return true;
      }
      startSearch(sender);
      sendResponse({ type: 'ACKNOWLEDGED' });
      return true;

    case 'VIEW_RESULTS':
      (async () => {
        try {
          // Check if results tab exists and is still open
          if (state.resultsTabId) {
            try {
              const tab = await browser.tabs.get(state.resultsTabId);
              // Tab exists, focus it
              await browser.tabs.update(state.resultsTabId, { active: true });
              await browser.windows.update(tab.windowId, { focused: true });
              console.log('[NDS] Focused existing results tab');
              sendResponse({ type: 'ACKNOWLEDGED' });
              return;
            } catch (e) {
              // Tab doesn't exist anymore, clear the ID
              console.log('[NDS] Stored results tab no longer exists');
              state.resultsTabId = null;
            }
          }

          // Open new results tab and store the ID
          const newTab = await browser.tabs.create({
            url: browser.runtime.getURL('results/results.html')
          });
          state.resultsTabId = newTab.id;
          console.log('[NDS] Opened new results tab:', newTab.id);
          sendResponse({ type: 'ACKNOWLEDGED' });
        } catch (error) {
          console.error('[NDS] Error viewing results:', error);
          sendResponse({ type: 'ERROR', data: { message: error.message } });
        }
      })();
      return true;

    // EXTRACTED_DATA handler removed - no longer needed

    case 'START_ANALYSIS':
      startAnalysis().then(() => {
        sendResponse({ type: 'ACKNOWLEDGED' });
      }).catch(error => {
        sendResponse({ type: 'ERROR', data: { message: error.message } });
      });
      return true;

    case 'SEND_CHAT_MESSAGE':
      handleChatMessage(message.data.message).then(() => {
        sendResponse({ type: 'ACKNOWLEDGED' });
      }).catch(error => {
        sendResponse({ type: 'ERROR', data: { message: error.message } });
      });
      return true;

    case 'GET_CHAT_HISTORY':
      sendResponse({ type: 'CHAT_HISTORY', data: state.chatHistory });
      return true;

    case 'CLEAR_CHAT':
      state.chatHistory = [];
      state.accumulatedSearches = [];  // Also clear accumulated tool search results
      sendResponse({ type: 'ACKNOWLEDGED' });
      return true;

    case 'GET_DEBUG_LOGS':
      getDebugLogs().then(logs => {
        sendResponse({ type: 'DEBUG_LOGS', data: logs });
      });
      return true;

    case 'GET_DEFAULT_PROMPT':
      sendResponse({ type: 'DEFAULT_PROMPT', data: DEFAULT_ANALYSIS_PROMPT });
      return true;

    default:
      log('WARN', 'Unknown message type:', message.type);
      return false;
  }
});

// ============================================================================
// Comment Extraction - Recursive handling of nested replies
// ============================================================================

/**
 * Recursively extracts comments and their nested replies
 * @param {Object} commentNode - The comment node from the GraphQL response
 * @param {number} level - Nesting level (0 for top-level)
 * @returns {Object|null} - Extracted comment with replies array
 */
function extractCommentWithReplies(commentNode, level = 0) {
  const c = commentNode?.comment;
  if (!c) return null;

  // Extract basic comment data
  const phone = c.styledBody?.styles?.find(s => s.attributes?.action?.phoneNumber)?.attributes?.action?.phoneNumber;
  const biz = c.taggedContent?.[0]?.entityPage;

  const comment = {
    author: c.author?.displayName,
    location: c.author?.originationNeighborhood?.displayLocation,
    body: c.body,
    createdAt: c.createdAt?.asDateTime?.relativeTime,
    phone: phone || null,
    business: biz ? {
      name: biz.name,
      category: biz.categoryInfo?.displayCategory?.styledName?.text,
      faves: biz.faveCount?.value,
      address: biz.address?.fullAddress
    } : null,
    level: level,
    replies: []
  };

  // Check for nested replies - common field names in GraphQL schemas
  // Try multiple possible field names for nested comments
  const repliesData = c.replies?.pagedComments?.edges ||
                      c.replies?.edges ||
                      c.childComments?.pagedComments?.edges ||
                      c.childComments?.edges ||
                      c.responses?.pagedComments?.edges ||
                      c.responses?.edges ||
                      c.nestedComments?.pagedComments?.edges ||
                      c.nestedComments?.edges ||
                      [];

  // Debug logging: Log comment structure for first few comments to discover nested reply field
  if (level === 0 && Math.random() < 0.1) {
    // Log 10% of top-level comments to see structure without overwhelming logs
    log('DEBUG', 'Comment structure sample:', JSON.stringify({
      hasReplies: !!c.replies,
      hasChildComments: !!c.childComments,
      hasResponses: !!c.responses,
      hasNestedComments: !!c.nestedComments,
      commentKeys: Object.keys(c).filter(k => k.toLowerCase().includes('reply') || k.toLowerCase().includes('comment') || k.toLowerCase().includes('response'))
    }));
  }

  // Recursively extract nested replies
  if (repliesData.length > 0) {
    log('DEBUG', `Found ${repliesData.length} nested replies at level ${level}`);
    for (const replyEdge of repliesData) {
      const nestedComment = extractCommentWithReplies(replyEdge.node, level + 1);
      if (nestedComment) {
        comment.replies.push(nestedComment);
      }
    }
  }

  return comment;
}

/**
 * Extracts all comments (top-level and nested) from a post
 * @param {Object} post - The post object from GraphQL response
 * @returns {Array} - Array of comment objects with nested replies
 */
function extractAllComments(post) {
  const topLevelEdges = post.comments?.pagedComments?.edges || [];
  const comments = [];

  for (const edge of topLevelEdges) {
    const comment = extractCommentWithReplies(edge.node, 0);
    if (comment) {
      comments.push(comment);
    }
  }

  return comments;
}

/**
 * Counts total comments including all nested replies
 * @param {Array} comments - Array of comment objects
 * @returns {number} - Total count of all comments
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

// ============================================================================
// Search Orchestration
// ============================================================================

let popupPort = null;
let analysisPort = null;

// Listen for popup and analysis connections to send progress updates
browser.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    popupPort = port;
    port.onDisconnect.addListener(() => {
      popupPort = null;
    });
  } else if (port.name === 'analysis') {
    analysisPort = port;
    port.onDisconnect.addListener(() => {
      analysisPort = null;
    });
  }
});

function sendToPopup(message) {
  if (popupPort) {
    try {
      popupPort.postMessage(message);
    } catch (e) {
      console.error('[NDS] Error sending to popup:', e);
    }
  }
}

function sendToAnalysis(message) {
  if (analysisPort) {
    try {
      analysisPort.postMessage(message);
    } catch (e) {
      console.error('[NDS] Error sending to analysis:', e);
    }
  }
}

async function startSearch(sender) {
  log('INFO', 'startSearch: Beginning search...');
  state.isRunning = true;
  state.progress = { current: 0, total: 0, errors: 0 };

  // Clear chat history at the START of a new search (not just when analysis starts)
  // This ensures the results page doesn't load stale chat from previous searches
  state.chatHistory = [];
  state.accumulatedSearches = [];

  updateBadge();

  // Check templates
  if (!state.captured.searchPost) {
    log('ERROR', 'startSearch: No searchPost template captured');
    state.isRunning = false;
    updateBadge();
    sendToPopup({ type: 'ERROR', data: { message: 'No searchPost template. Perform a search on Nextdoor first.' } });
    return;
  }

  if (!state.captured.feedItem) {
    log('ERROR', 'startSearch: No FeedItem template captured');
    state.isRunning = false;
    updateBadge();
    sendToPopup({ type: 'ERROR', data: { message: 'No FeedItem template. Click on a post on Nextdoor first.' } });
    return;
  }

  try {
    // Get active tab to send message to content script
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) {
      throw new Error('No active tab found');
    }
    const tabId = tabs[0].id;

    // Step 1: Execute search to get post IDs
    const searchTemplate = state.captured.searchPost;

    // Determine query: prefer current (from URL) > last captured > template payload
    const query = state.currentQuery || state.lastQuery || searchTemplate.payload?.variables?.postSearchArgs?.query;
    if (!query) {
      throw new Error('No search query available. Perform a search on Nextdoor first.');
    }

    // Clone payload and update query
    const searchPayload = JSON.parse(JSON.stringify(searchTemplate.payload));
    if (searchPayload.variables?.postSearchArgs) {
      searchPayload.variables.postSearchArgs.query = query;
    }

    log('INFO', 'startSearch: Sending searchPost for query:', query);

    const searchResponse = await browser.tabs.sendMessage(tabId, {
      type: 'FETCH_SEARCH',
      headers: searchTemplate.headers,
      payload: searchPayload
    });

    if (!searchResponse.success) {
      throw new Error('Search failed: ' + searchResponse.error);
    }

    // Extract post IDs from search results
    const searchResultView = searchResponse.data?.data?.searchPostFeed?.searchResultView || [];
    const postView = searchResultView.find(v => v.type === 'POST') || searchResultView[0];
    const edges = postView?.searchResultItems?.edges || [];

    const postIds = [];
    for (const edge of edges) {
      const url = edge?.node?.url;
      if (url) {
        const match = url.match(/\/p\/([^?/]+)/);
        if (match) {
          postIds.push(match[1]);
        }
      }
    }

    log('INFO', 'startSearch: Found', postIds.length, 'posts');

    if (postIds.length === 0) {
      sendToPopup({ type: 'COMPLETE', data: { query, threads: 0, comments: 0, errors: 0 } });
      state.isRunning = false;
      updateBadge();
      return;
    }

    // Step 2: Fetch each thread's details
    const feedItemTemplate = state.captured.feedItem;
    const threads = [];
    const errors = [];
    let totalComments = 0;

    state.progress.total = postIds.length;
    sendToPopup({ type: 'PROGRESS', data: state.progress });

    for (let i = 0; i < postIds.length; i++) {
      const postId = postIds[i];

      try {
        // Clone payload and update feedItemId
        const payload = JSON.parse(JSON.stringify(feedItemTemplate.payload));
        payload.variables.feedItemId = `sharedPost_${postId}`;

        const response = await browser.tabs.sendMessage(tabId, {
          type: 'FETCH_FEEDITEM',
          postId: postId,
          headers: feedItemTemplate.headers,
          payload: payload
        });

        if (!response.success) {
          log('ERROR', 'Failed to fetch post', postId, '-', response.error);
          errors.push({ postId, error: response.error });
          state.progress.errors++;
        } else {
          const post = response.data?.data?.feedItem?.post;
          if (post) {
            const comments = extractAllComments(post);
            const commentCount = countAllComments(comments);
            totalComments += commentCount;

            threads.push({
              postId,
              url: `https://nextdoor.com/p/${postId}?view=detail`,
              op: {
                author: post.author?.displayName,
                location: post.author?.originationNeighborhood?.displayLocation,
                subject: post.subject,
                body: post.body,
                createdAt: post.createdAt?.asDateTime?.relativeTime
              },
              comments
            });
          }
        }
      } catch (err) {
        errors.push({ postId, error: err.message });
        state.progress.errors++;
      }

      state.progress.current = i + 1;
      sendToPopup({ type: 'PROGRESS', data: state.progress });

      // Rate limit
      if (i < postIds.length - 1) {
        await new Promise(r => setTimeout(r, 150));
      }
    }

    // Update state
    state.sessionSearchCount++;
    state.lastResult = {
      query,
      threads: threads.length,
      comments: totalComments,
      errors: errors.length,
      completedAt: Date.now()
    };

    // Save for results page
    await browser.storage.local.set({
      lastSearchData: { query, timestamp: Date.now(), threads }
    });

    sendToPopup({ type: 'COMPLETE', data: state.lastResult });
    log('INFO', 'startSearch: Complete -', threads.length, 'threads,', totalComments, 'comments');

    // Open results page and store tab ID
    const resultsTab = await browser.tabs.create({
      url: browser.runtime.getURL('results/results.html')
    });
    state.resultsTabId = resultsTab.id;

  } catch (e) {
    log('ERROR', 'startSearch error:', e.message);
    sendToPopup({ type: 'ERROR', data: { message: 'Error: ' + e.message } });
  }

  state.isRunning = false;
  updateBadge();
}

// handleExtractedData and fetchAllThreads removed - startSearch now handles everything

// ============================================================================
// Tool-based Search (for LLM agent use)
// ============================================================================

async function executeSearch(query) {
  return executeSearchWithProgress(query, null);
}

async function executeSearchWithProgress(query, onProgress) {
  log('INFO', 'Executing tool search for:', query);

  if (!state.captured.searchPost) {
    throw new Error('Missing searchPost template. Please perform a search on Nextdoor first.');
  }

  // Find a nextdoor.com tab (not necessarily active - could be on results page)
  const nextdoorTabs = await browser.tabs.query({ url: 'https://nextdoor.com/*' });
  if (nextdoorTabs.length === 0) {
    throw new Error('No Nextdoor tab found. Please keep a nextdoor.com tab open.');
  }
  const tabId = nextdoorTabs[0].id;
  log('DEBUG', 'executeSearch: Using nextdoor tab:', tabId);

  const template = state.captured.searchPost;
  log('DEBUG', 'Using captured searchPost template from', new Date(template.capturedAt).toLocaleTimeString());

  // Clone payload and update query
  const payload = JSON.parse(JSON.stringify(template.payload));
  payload.variables.postSearchArgs.query = query;
  payload.variables.postSearchArgs.requestId = crypto.randomUUID();
  payload.variables.postSearchArgs.clientContextId = crypto.randomUUID();

  // Notify: searching
  if (onProgress) onProgress({ status: 'searching', message: 'Searching Nextdoor...' });

  // Send to content script (main world fetch)
  const response = await browser.tabs.sendMessage(tabId, {
    type: 'FETCH_SEARCH',
    headers: template.headers,
    payload: payload
  });

  if (!response.success) {
    throw new Error(`Search failed: ${response.error}`);
  }

  const searchData = response.data;

  // Debug: log the full response structure
  log('DEBUG', 'searchPost response:', JSON.stringify(searchData, null, 2).substring(0, 2000));

  // Check for GraphQL errors
  if (searchData.errors) {
    log('ERROR', 'GraphQL errors:', searchData.errors);
    throw new Error(`GraphQL error: ${searchData.errors[0]?.message || 'Unknown error'}`);
  }

  // Extract post IDs from searchPostFeed response
  const postIds = [];
  const searchResultView = searchData?.data?.searchPostFeed?.searchResultView || [];
  const postView = searchResultView.find(v => v.type === 'POST') || searchResultView[0];
  const edges = postView?.searchResultItems?.edges || [];

  log('INFO', 'Number of search results:', edges.length);
  if (edges.length > 0) {
    log('DEBUG', 'First result:', JSON.stringify(edges[0]?.node, null, 2).substring(0, 500));
  }

  for (const edge of edges) {
    const node = edge?.node;
    const url = node?.url;
    if (url) {
      const match = url.match(/\/p\/([^?/]+)/);
      if (match) {
        postIds.push(match[1]);
      }
    }
  }

  log('INFO', 'Found', postIds.length, 'posts for query:', query);

  // Notify: found posts
  if (onProgress) onProgress({ status: 'found_posts', message: `Found ${postIds.length} posts`, count: postIds.length });

  // Step 2: Fetch details for each post (limit to first 10 to avoid too many requests)
  const limitedIds = postIds.slice(0, 10);
  const threads = await fetchThreadDetailsWithProgress(limitedIds, tabId, onProgress);

  // Notify: complete
  if (onProgress) onProgress({ status: 'complete', message: 'Search complete', threadCount: threads.length });

  return {
    query,
    threadCount: threads.length,
    threads,
    timestamp: Date.now()
  };
}

async function fetchThreadDetails(postIds, tabId) {
  return fetchThreadDetailsWithProgress(postIds, tabId, null);
}

async function fetchThreadDetailsWithProgress(postIds, tabId, onProgress) {
  if (!state.captured.feedItem) {
    throw new Error('Missing FeedItem template. Please click on a post on Nextdoor first.');
  }

  // If tabId not provided, find a nextdoor.com tab
  if (!tabId) {
    const nextdoorTabs = await browser.tabs.query({ url: 'https://nextdoor.com/*' });
    if (nextdoorTabs.length === 0) {
      throw new Error('No Nextdoor tab found. Please keep a nextdoor.com tab open.');
    }
    tabId = nextdoorTabs[0].id;
  }

  const template = state.captured.feedItem;
  const threads = [];
  const errors = [];

  for (let i = 0; i < postIds.length; i++) {
    const postId = postIds[i];

    // Notify progress
    if (onProgress) {
      onProgress({
        status: 'fetching_thread',
        message: `Fetching thread ${i + 1}/${postIds.length}`,
        current: i + 1,
        total: postIds.length
      });
    }

    try {
      // Clone payload and update feedItemId
      const payload = JSON.parse(JSON.stringify(template.payload));
      payload.variables.feedItemId = `sharedPost_${postId}`;

      // Send to content script (main world fetch)
      const response = await browser.tabs.sendMessage(tabId, {
        type: 'FETCH_FEEDITEM',
        postId: postId,
        headers: template.headers,
        payload: payload
      });

      if (!response.success) {
        errors.push({ postId, error: response.error });
      } else {
        const post = response.data?.data?.feedItem?.post;

        if (post) {
          const comments = extractAllComments(post);

          threads.push({
            postId,
            url: `https://nextdoor.com/p/${postId}?view=detail`,
            op: {
              author: post.author?.displayName,
              location: post.author?.originationNeighborhood?.displayLocation,
              subject: post.subject,
              body: post.body,
              createdAt: post.createdAt?.asDateTime?.relativeTime
            },
            comments
          });
        }
      }
    } catch (err) {
      errors.push({ postId, error: err.message });
    }

    // Rate limit
    if (i < postIds.length - 1) {
      await new Promise(r => setTimeout(r, 150));
    }
  }

  return threads;
}

// ============================================================================
// Markdown Formatting
// ============================================================================

/**
 * Recursively formats a comment and its nested replies with proper indentation
 * @param {Object} comment - Comment object with replies
 * @param {number} level - Indentation level
 * @returns {string} - Formatted markdown string
 */
function formatCommentWithReplies(comment, level = 0) {
  const indent = '  '.repeat(level); // 2 spaces per level
  let md = '';

  md += `${indent}---\n\n`;
  md += `${indent}**${comment.author}** (${comment.location}) - ${comment.createdAt}`;
  if (level > 0) {
    md += ` *[Reply level ${level}]*`;
  }
  md += `\n\n`;

  // Indent the body text
  const bodyLines = (comment.body || '(empty)').split('\n');
  for (const line of bodyLines) {
    md += `${indent}${line}\n`;
  }
  md += `\n`;

  if (comment.phone) {
    md += `${indent}Phone: \`${comment.phone}\`\n\n`;
  }
  if (comment.business) {
    md += `${indent}Business: **${comment.business.name}**`;
    if (comment.business.category) md += ` (${comment.business.category})`;
    if (comment.business.faves) md += ` - ${comment.business.faves} faves`;
    if (comment.business.address) md += `\n${indent}Address: ${comment.business.address}`;
    md += `\n\n`;
  }

  // Recursively format nested replies
  if (comment.replies && comment.replies.length > 0) {
    for (const reply of comment.replies) {
      md += formatCommentWithReplies(reply, level + 1);
    }
  }

  return md;
}

function formatMarkdown(query, threads, errors, totalComments) {
  const date = new Date().toISOString().split('T')[0];
  let md = `# Nextdoor Deep Search: "${query}"\n\n`;
  md += `**Generated:** ${new Date().toISOString()}\n`;
  md += `**Search URL:** https://nextdoor.com/search/posts/?query=${encodeURIComponent(query)}\n`;
  md += `**Threads:** ${threads.length}\n`;
  md += `**Total Comments:** ${totalComments}\n`;
  if (errors.length > 0) {
    md += `**Errors:** ${errors.length}\n`;
  }
  md += `\n---\n\n`;

  for (const thread of threads) {
    // Calculate total comment count for this thread (including nested)
    const threadCommentCount = countAllComments(thread.comments);

    md += `## ${thread.op.subject || '(No subject)'}\n\n`;
    md += `**Post URL:** ${thread.url}\n`;
    md += `**Author:** ${thread.op.author} (${thread.op.location})\n`;
    md += `**Posted:** ${thread.op.createdAt}\n`;
    md += `**Comments:** ${threadCommentCount} (${thread.comments.length} top-level)\n\n`;
    md += `### Original Post\n\n`;
    md += `> ${thread.op.body?.replace(/\n/g, '\n> ') || '(empty)'}\n\n`;

    if (thread.comments.length > 0) {
      md += `### Comments\n\n`;
      for (const c of thread.comments) {
        md += formatCommentWithReplies(c, 0);
      }
    }
    md += `\n---\n\n`;
  }

  if (errors.length > 0) {
    md += `## Errors\n\n`;
    for (const e of errors) {
      md += `- Post ${e.postId}: ${e.status || e.error}\n`;
    }
  }

  return md;
}

// ============================================================================
// Download Handling
// ============================================================================

async function triggerDownload(query, markdown) {
  const date = new Date().toISOString().split('T')[0];
  const filename = `nextdoor-${query.replace(/[^a-z0-9]/gi, '-')}-${date}.md`;

  const blob = new Blob([markdown], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);

  try {
    await browser.downloads.download({
      url,
      filename,
      saveAs: false
    });
  } finally {
    // Clean up blob URL after a delay
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  return filename;
}

// ============================================================================
// AI Analysis
// ============================================================================

// Default user-customizable analysis prompt (excludes tool instructions and output format rules)
const DEFAULT_ANALYSIS_PROMPT = `You are an expert at analyzing Nextdoor community discussions to identify service providers.

Your task: Analyze search results to find service providers mentioned in threads.

Instructions:
1. Extract all service provider mentions (individuals or businesses)
2. Group similar mentions (same business/person mentioned multiple times)
3. Filter out irrelevant conversations (off-topic, social chit-chat)
4. Weight recommendations by:
   - Number of positive mentions
   - Sentiment (enthusiastic vs lukewarm)
   - Contact info availability (phone, business page)
   - Recency and detail

Be concise but thorough. Focus on actionable information.`;

// Internal tool instructions (not exposed to user)
const TOOL_INSTRUCTIONS = `
You have access to a search tool:
- searchPosts(query): Search Nextdoor for posts/threads matching the query. Use this when you need more information about a specific provider, business, or topic that isn't in the current context.

When the user asks a follow-up question that requires more data (e.g., "what else do people say about X?", "find more about Y", "search for Z"), use searchPosts to gather additional information before responding.

CRITICAL RESPONSE BEHAVIOR AFTER TOOL SEARCH:
- After calling searchPosts, by DEFAULT you MUST list ALL detailed mentions, quotes, recommendations, and context from the search results
- Include ALL relevant quotes from original posts and comments
- Show WHO said WHAT about the search term
- Only filter or summarize if the user EXPLICITLY asks for specific information (e.g., "list only negative comments", "show just phone numbers")
- The detailed results will be added to chat history so users can ask follow-up questions`;

// Internal output format rules (not exposed to user)
const OUTPUT_FORMAT_RULES = `
CRITICAL OUTPUT RULES:
- Wrap your ENTIRE response in a code fence with language identifier
- For HTML output use: \`\`\`html followed by your HTML content and closing \`\`\`
- For Markdown output use: \`\`\`markdown followed by your content and closing \`\`\`
- HTML is preferred. Structure: <h2 style="color:green;">Provider Name</h2><p>details</p><ul><li>mention</li></ul>
- Use inline styles: style="color:green;" for provider names, style="color:blue;" for contact info
- Include contact info prominently: <span style="color:blue;">Phone: 555-1234</span>
- Sort by strength of recommendation (best first)
- Include full quotes from users in <blockquote> tags
IMPORTANT: Always wrap response in code fence (\`\`\`html or \`\`\`markdown).`;

// Build the full system prompt (combines user prompt + internal instructions)
function buildSystemPrompt(customPrompt) {
  const userPrompt = customPrompt || DEFAULT_ANALYSIS_PROMPT;
  return userPrompt + TOOL_INSTRUCTIONS + OUTPUT_FORMAT_RULES;
}

// Tool definition for LLM tool calling
const SEARCH_TOOLS = [{
  name: 'searchPosts',
  description: 'Search Nextdoor posts/threads for a query. Returns detailed threads with all comments, quotes, and mentions. After calling this tool, you MUST list ALL detailed mentions, quotes, and context from the results by default (unless the user explicitly asks for specific filtered information).',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (e.g., provider name, service type, business name)'
      }
    },
    required: ['query']
  }
}];

/**
 * Recursively formats a comment and its replies for LLM context
 * @param {Object} comment - Comment object with replies
 * @param {number} level - Indentation level
 * @returns {string} - Formatted text string
 */
function formatCommentForLLM(comment, level = 0) {
  const indent = '  '.repeat(level);
  let text = '';

  text += `\n${indent}- ${comment.author} (${comment.location}) - ${comment.createdAt}`;
  if (level > 0) {
    text += ` [Reply level ${level}]`;
  }
  text += `\n`;

  // Indent the comment body
  const bodyLines = (comment.body || '(empty)').split('\n');
  for (const line of bodyLines) {
    text += `${indent}  ${line}\n`;
  }

  if (comment.phone) {
    text += `${indent}  Phone: ${comment.phone}\n`;
  }
  if (comment.business) {
    text += `${indent}  Business: ${comment.business.name}`;
    if (comment.business.category) text += ` (${comment.business.category})`;
    if (comment.business.faves) text += ` - ${comment.business.faves} faves`;
    if (comment.business.address) text += `\n${indent}  Address: ${comment.business.address}`;
    text += `\n`;
  }

  // Recursively format nested replies
  if (comment.replies && comment.replies.length > 0) {
    for (const reply of comment.replies) {
      text += formatCommentForLLM(reply, level + 1);
    }
  }

  return text;
}

function formatThreadsForLLM(threads, query) {
  let text = `Search Query: "${query}"\n\n`;
  text += `Found ${threads.length} threads with discussions:\n\n`;

  for (let i = 0; i < threads.length; i++) {
    const thread = threads[i];
    const totalComments = countAllComments(thread.comments);

    text += `\n=== THREAD ${i + 1} ===\n`;
    text += `URL: ${thread.url}\n`;
    text += `Subject: ${thread.op.subject || '(No subject)'}\n`;
    text += `Author: ${thread.op.author} (${thread.op.location})\n`;
    text += `Posted: ${thread.op.createdAt}\n\n`;
    text += `Original Post:\n${thread.op.body || '(empty)'}\n\n`;

    if (thread.comments.length > 0) {
      text += `Comments (${totalComments} total, ${thread.comments.length} top-level):\n`;
      for (const comment of thread.comments) {
        text += formatCommentForLLM(comment, 0);
      }
    }
    text += `\n`;
  }

  return text;
}

async function startAnalysis() {
  if (state.isAnalyzing) {
    throw new Error('Analysis already in progress');
  }

  // Load AI config
  const data = await browser.storage.local.get(['aiConfig', 'lastSearchData']);

  if (!data.aiConfig || !data.aiConfig.provider) {
    throw new Error('No AI provider configured. Please configure in extension options.');
  }

  if (!data.lastSearchData || !data.lastSearchData.threads) {
    throw new Error('No search data available. Please run a Deep Search first.');
  }

  state.isAnalyzing = true;
  state.chatHistory = []; // Reset chat history for new analysis
  state.accumulatedSearches = []; // Reset accumulated tool search results

  try {
    const provider = createLLMProvider(data.aiConfig);
    const threadsText = formatThreadsForLLM(data.lastSearchData.threads, data.lastSearchData.query);

    // Build system prompt with custom user prompt if configured
    const systemPrompt = buildSystemPrompt(data.aiConfig.customPrompt);

    const messages = [
      { role: 'user', content: `${systemPrompt}\n\n${threadsText}` }
    ];

    sendToAnalysis({ type: 'ANALYSIS_START' });

    let fullResponse = '';
    for await (const chunk of provider.streamCompletion(messages)) {
      fullResponse += chunk;
      sendToAnalysis({ type: 'ANALYSIS_CHUNK', data: { chunk } });
    }

    // Save to chat history (for follow-up context)
    state.chatHistory.push(
      { role: 'user', content: `Please analyze these Nextdoor search results for "${data.lastSearchData.query}" and identify service providers with recommendations.` },
      { role: 'assistant', content: fullResponse }
    );

    sendToAnalysis({ type: 'ANALYSIS_COMPLETE', data: { fullResponse } });
    console.log('[NDS] Analysis complete');
  } catch (error) {
    console.error('[NDS] Analysis error:', error);
    sendToAnalysis({ type: 'ANALYSIS_ERROR', data: { message: error.message } });
    throw error;
  } finally {
    state.isAnalyzing = false;
  }
}

async function handleChatMessage(userMessage) {
  if (state.isAnalyzing) {
    throw new Error('Analysis in progress, please wait');
  }

  // Load AI config and search data
  const data = await browser.storage.local.get(['aiConfig', 'lastSearchData']);

  if (!data.aiConfig || !data.aiConfig.provider) {
    throw new Error('No AI provider configured');
  }

  if (!data.lastSearchData || !data.lastSearchData.threads) {
    throw new Error('No search data available');
  }

  state.isAnalyzing = true;

  try {
    const provider = createLLMProvider(data.aiConfig);

    // Add user message to history
    state.chatHistory.push({ role: 'user', content: userMessage });

    // Build context with all accumulated searches
    let allThreadsContext = formatThreadsForLLM(data.lastSearchData.threads, data.lastSearchData.query);

    // Add any accumulated tool search results
    for (const search of state.accumulatedSearches) {
      allThreadsContext += `\n\n=== ADDITIONAL SEARCH: "${search.query}" ===\n`;
      allThreadsContext += formatThreadsForLLM(search.threads, search.query);
    }

    // Build system prompt with custom user prompt if configured
    const systemPrompt = buildSystemPrompt(data.aiConfig.customPrompt);
    const contextMessage = `${systemPrompt}\n\n${allThreadsContext}`;

    // Build messages array - include context in first user message (Claude doesn't support 'system' role in messages)
    const messages = [];

    // Add all previous chat history, prepending context to first user message
    let contextAdded = false;
    for (const msg of state.chatHistory) {
      if (!contextAdded && msg.role === 'user') {
        // Prepend context to first user message
        messages.push({ role: 'user', content: `${contextMessage}\n\nUser question: ${msg.content}` });
        contextAdded = true;
      } else {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // If no user message found (shouldn't happen), add context as user message
    if (!contextAdded) {
      messages.unshift({ role: 'user', content: contextMessage });
    }

    sendToAnalysis({ type: 'CHAT_START' });

    // Check if provider supports tool calling
    if (typeof provider.completionWithTools === 'function') {
      // Tool execution loop
      const MAX_TOOL_ITERATIONS = 3;
      let iterations = 0;

      while (iterations < MAX_TOOL_ITERATIONS) {
        iterations++;
        console.log('[NDS] Tool loop iteration:', iterations);

        // Call LLM with tools (non-streaming for tool detection)
        const response = await provider.completionWithTools(messages, SEARCH_TOOLS);

        if (response.type === 'text') {
          // LLM gave a text response - simulate streaming by chunking
          const content = response.content;
          const chunkSize = 20; // Characters per chunk

          for (let i = 0; i < content.length; i += chunkSize) {
            const chunk = content.slice(i, i + chunkSize);
            sendToAnalysis({ type: 'CHAT_CHUNK', data: { chunk } });
            // Small delay to create streaming effect
            await new Promise(resolve => setTimeout(resolve, 10));
          }

          // Save to history and complete
          state.chatHistory.push({ role: 'assistant', content: content });
          sendToAnalysis({ type: 'CHAT_COMPLETE', data: { fullResponse: content } });
          console.log('[NDS] Chat response complete (with tools)');
          return;
        }

        if (response.type === 'tool_call' && response.toolCalls) {
          // Process each tool call
          for (const toolCall of response.toolCalls) {
            if (toolCall.name === 'searchPosts') {
              const args = typeof toolCall.arguments === 'string'
                ? JSON.parse(toolCall.arguments)
                : toolCall.arguments;

              console.log('[NDS] Executing tool search:', args.query);

              // Notify UI that we're searching
              sendToAnalysis({ type: 'TOOL_EXECUTING', query: args.query, status: 'searching' });

              try {
                // Execute the search with progress callbacks
                const searchResult = await executeSearchWithProgress(args.query, (progress) => {
                  sendToAnalysis({ type: 'TOOL_PROGRESS', ...progress });
                });

                // Accumulate results
                state.accumulatedSearches.push(searchResult);

                // Notify UI of completion and that we're now sending to LLM
                sendToAnalysis({ type: 'TOOL_COMPLETE', resultCount: searchResult.threadCount });
                sendToAnalysis({ type: 'LLM_THINKING', message: 'Analyzing results...' });

                // Add tool result to messages for next LLM call
                // IMPORTANT: Include explicit instructions to display detailed mentions by default
                const toolResultContent = `Tool result for searchPosts("${args.query}"):\n\n${formatThreadsForLLM(searchResult.threads, args.query)}\n\nIMPORTANT: Now list ALL detailed mentions, quotes, and recommendations from these results. Show WHO said WHAT. Include full context and quotes. Only filter/summarize if the user explicitly requested specific information.`;

                // Use provider's formatToolResultMessages for correct format
                const toolMessages = provider.formatToolResultMessages(
                  response.toolCalls,
                  [{ toolCallId: toolCall.id, content: toolResultContent }]
                );
                messages.push(...toolMessages);

              } catch (error) {
                console.error('[NDS] Tool execution error:', error);
                console.error('[NDS] Error stack:', error.stack);

                // Notify UI that search failed
                sendToAnalysis({ type: 'TOOL_COMPLETE', resultCount: 0 });

                // Use provider's formatToolResultMessages for error
                const errorMessage = `Tool error: ${error.message}. The search could not be completed.`;
                const toolMessages = provider.formatToolResultMessages(
                  response.toolCalls,
                  [{ toolCallId: toolCall.id, content: errorMessage }]
                );
                messages.push(...toolMessages);
              }
            }
          }
          // Continue loop to let LLM respond with accumulated data
          continue;
        }

        // Unknown response type, break loop
        console.warn('[NDS] Unknown tool response type:', response.type);
        break;
      }

      if (iterations >= MAX_TOOL_ITERATIONS) {
        console.warn('[NDS] Max tool iterations reached');
        sendToAnalysis({ type: 'CHAT_CHUNK', data: { chunk: 'I apologize, but I reached the maximum number of search iterations. Here is what I found based on available data.' } });
      }
    } else {
      // Fallback: Provider doesn't support tools, use streaming
      let fullResponse = '';
      for await (const chunk of provider.streamCompletion(messages)) {
        fullResponse += chunk;
        sendToAnalysis({ type: 'CHAT_CHUNK', data: { chunk } });
      }

      // Save assistant response to history
      state.chatHistory.push({ role: 'assistant', content: fullResponse });
      sendToAnalysis({ type: 'CHAT_COMPLETE', data: { fullResponse } });
      console.log('[NDS] Chat response complete (streaming fallback)');
    }
  } catch (error) {
    console.error('[NDS] Chat error:', error);
    sendToAnalysis({ type: 'CHAT_ERROR', data: { message: error.message } });
    throw error;
  } finally {
    state.isAnalyzing = false;
  }
}

// ============================================================================
// Initialize
// ============================================================================

// Check current tab on startup
browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
  if (tabs.length > 0) {
    updateTabState(tabs[0].id, tabs[0].url);
  }
});

console.log('[NDS] Background script loaded');
