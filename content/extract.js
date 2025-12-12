/**
 * Nextdoor Deep Search - Content Script
 *
 * Runs on nextdoor.com pages to extract:
 * 1. CSRF token from cookies
 * 2. Train value from page HTML
 * 3. Post IDs from search result links
 * 4. Current search query from URL
 */

(function() {
  'use strict';

  console.log('[NDS Content] Script loaded');

  // Listen for messages from background
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'EXTRACT_DATA') {
      console.log('[NDS Content] Extraction requested');
      const data = extractPageData();
      browser.runtime.sendMessage({
        type: 'EXTRACTED_DATA',
        data
      });
      sendResponse({ acknowledged: true });
    } else if (message.type === 'FETCH_FEEDITEM') {
      // Execute fetch from content script context (appears as page request)
      console.log('[NDS Content] FeedItem fetch requested for:', message.postId);
      fetchFeedItem(message.postId, message.headers, message.payload)
        .then(result => {
          sendResponse({ success: true, data: result });
        })
        .catch(error => {
          sendResponse({ success: false, error: error.message });
        });
      return true; // Keep channel open for async response
    } else if (message.type === 'FETCH_SEARCH') {
      // Execute searchPost fetch from content script context
      console.log('[NDS Content] searchPost fetch requested');
      fetchSearch(message.headers, message.payload)
        .then(result => {
          sendResponse({ success: true, data: result });
        })
        .catch(error => {
          console.error('[NDS Content] searchPost error:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true; // Keep channel open for async response
    }
    return true;
  });

  /**
   * Fetch a FeedItem from MAIN PAGE WORLD (not isolated content script world)
   * Uses wrappedJSObject to access the page's fetch function
   */
  async function fetchFeedItem(postId, headers, payload) {
    console.log('[NDS Content] Fetching FeedItem via MAIN WORLD:', postId);

    // Remove forbidden headers that browser won't allow
    const cleanHeaders = { ...headers };
    delete cleanHeaders['Host'];
    delete cleanHeaders['Connection'];
    delete cleanHeaders['Content-Length'];
    delete cleanHeaders['Cookie']; // Let credentials: 'include' handle cookies

    // Use the page's fetch function via wrappedJSObject to execute in main world
    const pageWindow = window.wrappedJSObject;

    // Clone data into page world using Firefox's cloneInto
    const pageHeaders = cloneInto(cleanHeaders, pageWindow);
    const pageOptions = cloneInto({
      method: 'POST',
      headers: pageHeaders,
      body: JSON.stringify(payload),
      credentials: 'include',
      mode: 'cors'
    }, pageWindow);

    // Call the page's native fetch
    const response = await pageWindow.fetch('https://nextdoor.com/api/gql/FeedItem?', pageOptions);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    // Get response text and parse in our world
    const text = await response.text();
    return JSON.parse(text);
  }

  /**
   * Fetch searchPost from MAIN PAGE WORLD (not isolated content script world)
   * Uses wrappedJSObject to access the page's fetch function
   */
  async function fetchSearch(headers, payload) {
    console.log('[NDS Content] Fetching searchPost via MAIN WORLD');

    // Remove forbidden headers that browser won't allow
    const cleanHeaders = { ...headers };
    delete cleanHeaders['Host'];
    delete cleanHeaders['Connection'];
    delete cleanHeaders['Content-Length'];
    delete cleanHeaders['Cookie']; // Let credentials: 'include' handle cookies

    console.log('[NDS Content] Headers (cleaned):', cleanHeaders);
    console.log('[NDS Content] Payload:', payload);

    // Use the page's fetch function via wrappedJSObject to execute in main world
    // This gives us the same context as code running directly in the page
    const pageWindow = window.wrappedJSObject;

    // Clone data into page world using Firefox's cloneInto
    const pageHeaders = cloneInto(cleanHeaders, pageWindow);
    const pageOptions = cloneInto({
      method: 'POST',
      headers: pageHeaders,
      body: JSON.stringify(payload),
      credentials: 'include',
      mode: 'cors'
    }, pageWindow);

    console.log('[NDS Content] Calling page fetch...');

    // Call the page's native fetch
    const response = await pageWindow.fetch('https://nextdoor.com/api/gql/searchPost?', pageOptions);

    console.log('[NDS Content] Response status:', response.status);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    // Get response text and parse in our world
    const text = await response.text();
    return JSON.parse(text);
  }

  /**
   * Extract all required data from the current page
   */
  function extractPageData() {
    const csrf = extractCsrf();
    const train = extractTrain();
    const postIds = extractPostIds();
    const query = extractQuery();

    console.log('[NDS Content] Extracted:', {
      csrf: csrf ? 'found' : 'missing',
      train: train ? 'found' : 'missing',
      postIds: postIds.length,
      query
    });

    return { csrf, train, postIds, query };
  }

  /**
   * Extract CSRF token from cookies
   */
  function extractCsrf() {
    const match = document.cookie.match(/csrftoken=([^;]+)/);
    return match ? match[1] : null;
  }

  /**
   * Extract train value from page HTML
   * The train value is embedded somewhere in the page content
   */
  function extractTrain() {
    const match = document.body.innerHTML.match(/train-\d+-[a-f0-9]+/);
    return match ? match[0] : null;
  }

  /**
   * Extract post IDs from search result links
   * Links have format: /p/{postId} or /p/{postId}?...
   */
  function extractPostIds() {
    const postLinks = [...document.querySelectorAll('a[href*="/p/"]')];
    const postIds = [...new Set(
      postLinks
        .map(a => {
          const match = a.href.match(/\/p\/([^/?]+)/);
          return match ? match[1] : null;
        })
        .filter(Boolean)
    )];
    return postIds;
  }

  /**
   * Extract search query from URL
   */
  function extractQuery() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('query');
  }

})();
