# CLAUDE.md

## Project Overview

Nextdoor Deep Search is a Firefox extension (Manifest V2) that:
1. Captures GraphQL request templates from user's browser activity
2. Replays those requests to fetch full thread details including nested comments
3. Displays results with relevance scoring, highlighting, and AI-powered analysis (Claude)

## Critical Implementation Details

### Main World Fetch (The "Wicked Issue")

API requests MUST execute in the page's main world, not the content script's isolated world. Without this, requests get 403 Forbidden because cookies/credentials aren't sent properly.

**Solution:** Use Firefox's `wrappedJSObject` to access the page's native fetch:

```javascript
// content/extract.js
const pageWindow = window.wrappedJSObject;
const pageHeaders = cloneInto(cleanHeaders, pageWindow);
const pageOptions = cloneInto({
  method: 'POST',
  headers: pageHeaders,
  body: JSON.stringify(payload),
  credentials: 'include',  // Critical: sends cookies
  mode: 'cors'
}, pageWindow);
const response = await pageWindow.fetch(url, pageOptions);
```

Key points:
- `cloneInto()` is required to pass objects from content script world to page world
- `credentials: 'include'` ensures cookies are sent
- Remove `Cookie` header manually - let the browser handle it via credentials
- Requests from background script (`tabId === -1`) are filtered out during capture

### Request Template Capture

Nextdoor uses persisted GraphQL queries with `sha256Hash`. Invalid/outdated hashes get rejected. The extension captures these from real browser requests:

- `webRequest.onBeforeRequest` - captures request body (payload with hash)
- `webRequest.onSendHeaders` - captures headers, combines with payload
- Templates stored in `browser.storage.local`
- Extension's own requests (`tabId === -1`) are ignored

### Claude API Notes

- Requires `anthropic-dangerous-direct-browser-access: true` header for browser CORS
- No `role: 'system'` in messages array - prepend to first user message
- Tool calling for follow-up searches (searchPosts tool)

## File Structure

```
background/
  background.js      # State, request capture, API orchestration, LLM chat
  llm-providers.js   # Claude streaming & tool calling

content/
  extract.js         # Main-world fetch execution via wrappedJSObject

popup/               # Extension popup UI (stepper setup flow)
results/             # Search results page with relevance scoring & AI chat
options/             # Claude API key configuration
```

## Popup Stepper

Three-step setup flow replacing the old status grid:
1. Browse Nextdoor (captures UTI/auth)
2. Search for something (captures searchPost template)
3. Click on any post (captures feedItem template)

## Badge States

- Red `!`: Missing UTI (browse Nextdoor to capture)
- Yellow `!`: Missing templates (search/click threads to capture)
- Green `GO`: Ready
- Blue `...`: Search in progress

## Results Page

- Relevance scoring per thread (keyword frequency: title x3, body x2, comments x1)
- Search term highlighting in titles, bodies, comments
- Sort by relevance/comments/date, filter out low-match threads
- Low-relevance threads auto-collapsed
- Header shows relevance summary with distribution bar

## Storage Schema

```javascript
{
  uti: string,                    // x-nd-uti header
  capturedTemplates: {
    searchPost: { hash, headers, payload, capturedAt },
    feedItem: { hash, headers, payload, capturedAt }
  },
  aiConfig: {
    provider: 'claude',
    claude: { apiKey, model },
    customPrompt: string  // Optional custom analysis prompt
  },
  lastSearchData: { query, timestamp, threads[] }
}
```
