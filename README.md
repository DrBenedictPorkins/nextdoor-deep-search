# Nextdoor Deep Search

A Firefox extension that solves the painful search experience on Nextdoor.com.

**Requirements:** Firefox browser, Nextdoor.com account (must be logged in).

## The Problem

Nextdoor's native search is frustrating. When you search for something like "plumber recommendations," you get a list of thread titles. To find actual useful information, you have to:

1. Click into each thread individually
2. Read through all comments and nested replies
3. Manually extract relevant details (names, phone numbers, recommendations)
4. Go back, click the next thread, and repeat

This results in dozens of clicks and endless context-switching just to answer a simple question.

## The Solution

This extension automates the tedious work. Using your existing search query, it automatically fetches all matching threads, retrieves every comment and nested reply, and combines everything into a single page for easy viewing.

Optionally, you can use AI to analyze the combined results and extract exactly what you're looking for—like a ranked list of recommended service providers with contact info and quotes from neighbors. You can then ask follow-up questions against the results, or request additional searches for specific terms discovered during analysis (e.g., "search for 'Lazar's Pizza' and list all posts mentioning them").

## AI-Powered Analysis

The extension supports three AI providers for analyzing search results:

- **OpenAI**: gpt-5.2, gpt-5.1, gpt-4.1, gpt-4.1-nano, gpt-4o, gpt-4o-mini
- **Claude (Anthropic)**: claude-sonnet-4.5, claude-haiku-4.5, claude-opus-4.5, claude-sonnet-4, claude-3.5-haiku
- **Ollama (Local)**: Any locally installed model (llama3.1, qwen2.5, mistral, etc.)

The AI can also execute follow-up searches to gather more context, and you can customize the analysis prompt to fit your specific needs.

## Installation

1. Clone this repository
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
3. Click "Load Temporary Add-on"
4. Select the `manifest.json` file

## Usage

1. **Browse Nextdoor**: Visit nextdoor.com, perform a search, and click on any thread
   - This captures the required GraphQL request templates
2. **Check Badge**:
   - Red `!` = Missing session (browse Nextdoor)
   - Yellow `!` = Missing templates (search + click a thread)
   - Green `GO` = Ready
3. **Deep Search**: Click the extension icon and press "Deep Search"
4. **AI Analysis**: Configure an AI provider in options, then click "Analyze with AI"

## How It Works

The extension captures GraphQL persisted query hashes from your browser's actual requests to Nextdoor (since the API rejects invalid/outdated hashes). It then replays these requests to fetch full thread details.

API requests execute in the page's main world using Firefox's `wrappedJSObject` to properly send credentials/cookies.

## License

MIT License - see [LICENSE](LICENSE) file
