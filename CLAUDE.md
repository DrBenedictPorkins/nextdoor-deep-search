# CLAUDE.md

## Project Overview

Nextdoor Deep Search is a Firefox extension (Manifest V2) that:
1. Captures GraphQL request templates from user's browser activity
2. Replays those requests to fetch full thread details including nested comments
3. Displays results with AI-powered analysis (OpenAI, Claude, Ollama)

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

### LLM Provider Notes

- **Claude API**: Requires `anthropic-dangerous-direct-browser-access: true` header for browser CORS
- **Claude Messages**: No `role: 'system'` in messages array - prepend to first user message
- **Ollama tool calls**: Arguments must be objects, not JSON strings

## File Structure

```
background/
  background.js      # State, request capture, API orchestration, LLM chat
  llm-providers.js   # OpenAI/Claude/Ollama streaming & tool calling

content/
  extract.js         # Main-world fetch execution via wrappedJSObject

popup/               # Extension popup UI
results/             # Search results page with AI chat
options/             # LLM configuration
```

## Badge States

- Red `!`: Missing UTI (browse Nextdoor to capture)
- Yellow `!`: Missing templates (search/click threads to capture)
- Green `GO`: Ready
- Blue `...`: Search in progress

## Storage Schema

```javascript
{
  uti: string,                    // x-nd-uti header
  capturedTemplates: {
    searchPost: { hash, headers, payload, capturedAt },
    feedItem: { hash, headers, payload, capturedAt }
  },
  aiConfig: {
    provider: 'openai' | 'claude' | 'ollama',
    openai: { apiKey, model },
    claude: { apiKey, model },
    ollama: { url, model },
    customPrompt: string  // Optional custom analysis prompt
  },
  lastSearchData: { query, timestamp, threads[] }
}
```
