# Nextdoor Deep Search

A Firefox extension that extracts full threads and nested comments from Nextdoor search results, with AI-powered analysis.

**Requirements:** Firefox, logged-in Nextdoor account.

## What It Does

Nextdoor's search shows thread titles. To find actual recommendations, you click into each thread, read all comments, go back, repeat. This extension does that automatically — fetches every matching thread with all comments and nested replies into a single results page.

Results include relevance scoring, search term highlighting, and sort/filter controls. Optionally, Claude AI can analyze everything and extract what you need (ranked providers, contact info, quotes from neighbors), with follow-up search capability.

## Installation

1. Clone this repo
2. Open `about:debugging#/runtime/this-firefox`
3. Click "Load Temporary Add-on" and select `manifest.json`

## Usage

The popup shows a 3-step setup stepper:

1. **Browse Nextdoor** — captures authentication
2. **Search for something** — captures search query template
3. **Click on any post** — captures thread template

Badge: Red `!` = missing auth, Yellow `!` = missing templates, Green `GO` = ready.

Once ready, click "Deep Search" to extract all threads and comments. Results open in a new tab with relevance badges, highlighted search terms, and sort by relevance/comments/date.

Click "Analyze with AI" to get Claude's analysis. Configure your API key in extension options.

## How It Works

Nextdoor uses persisted GraphQL queries identified by SHA256 hashes — the server rejects unknown hashes. The extension captures these from your live browser requests and replays them with modified variables. API calls execute in the page's main world via Firefox's `wrappedJSObject` to send credentials properly.

## License

MIT
