/**
 * Nextdoor Deep Search - LLM Provider (Claude/Anthropic only)
 *
 * Provides streaming and tool-calling interface for Claude API.
 */

// ============================================================================
// Custom Error Class
// ============================================================================

class LLMProviderError extends Error {
  constructor(message, provider, statusCode = null) {
    super(message);
    this.name = 'LLMProviderError';
    this.provider = provider;
    this.statusCode = statusCode;
  }
}

// ============================================================================
// Claude Provider
// ============================================================================

class ClaudeProvider {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = 'https://api.anthropic.com/v1';
  }

  async *streamCompletion(messages, maxTokens = 4096) {
    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages,
        max_tokens: maxTokens,
        temperature: 0,
        stream: true
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new LLMProviderError(
        `Claude API error: ${errorText}`,
        'claude',
        response.status
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith('data: ')) {
            try {
              const data = JSON.parse(trimmed.slice(6));

              // Claude streaming events
              if (data.type === 'content_block_delta' && data.delta?.text) {
                yield data.delta.text;
              }
            } catch (e) {
              console.warn('[Claude] Failed to parse SSE line:', trimmed, e);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async completionWithTools(messages, tools, maxTokens = 4096) {
    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages,
        max_tokens: maxTokens,
        temperature: 0,
        tools: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: {
            type: 'object',
            properties: tool.parameters.properties,
            required: tool.parameters.required
          }
        })),
        stream: false
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new LLMProviderError(
        `Claude API error: ${errorText}`,
        'claude',
        response.status
      );
    }

    const data = await response.json();

    if (!data.content || !Array.isArray(data.content)) {
      throw new LLMProviderError(
        'Invalid response format from Claude',
        'claude'
      );
    }

    // Check for tool use
    if (data.stop_reason === 'tool_use') {
      const toolCalls = data.content
        .filter(block => block.type === 'tool_use')
        .map(block => ({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input)
        }));

      if (toolCalls.length > 0) {
        return {
          type: 'tool_call',
          content: null,
          toolCalls: toolCalls
        };
      }
    }

    // Regular text response
    const textBlock = data.content.find(block => block.type === 'text');
    return {
      type: 'text',
      content: textBlock?.text || '',
      toolCalls: null
    };
  }

  /**
   * Format messages for tool results (Claude format)
   * Claude uses a different format: assistant message with tool_use blocks,
   * then user message with tool_result blocks
   * @param {Array} toolCalls - Array of tool calls from the response
   * @param {Array} results - Array of {toolCallId, content} objects
   * @returns {Array} Messages to append to conversation
   */
  formatToolResultMessages(toolCalls, results) {
    const messages = [];

    // Assistant message with tool_use content blocks
    messages.push({
      role: 'assistant',
      content: toolCalls.map(tc => ({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments
      }))
    });

    // User message with tool_result content blocks
    messages.push({
      role: 'user',
      content: results.map(result => ({
        type: 'tool_result',
        tool_use_id: result.toolCallId,
        content: result.content
      }))
    });

    return messages;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

function createLLMProvider(config) {
  if (!config || !config.provider) {
    throw new LLMProviderError('No LLM provider configured', 'none');
  }

  if (config.provider !== 'claude') {
    throw new LLMProviderError(`Unknown provider: ${config.provider}`, config.provider);
  }

  if (!config.claude) {
    throw new LLMProviderError('Claude configuration missing', 'claude');
  }

  return new ClaudeProvider(config.claude);
}

// Export for use in background script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createLLMProvider,
    LLMProviderError,
    ClaudeProvider
  };
}
