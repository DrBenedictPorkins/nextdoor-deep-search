/**
 * Nextdoor Deep Search - LLM Provider Abstraction
 *
 * Provides unified interface for OpenAI, Claude, and Ollama
 * with streaming support.
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
// OpenAI Provider
// ============================================================================

class OpenAIProvider {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = 'https://api.openai.com/v1';
  }

  // Newer models (gpt-4.1+, gpt-5+) use max_completion_tokens instead of max_tokens
  _useNewTokenParam() {
    return this.model.startsWith('gpt-4.1') ||
           this.model.startsWith('gpt-5') ||
           this.model.startsWith('o1') ||
           this.model.startsWith('o3') ||
           this.model.startsWith('o4');
  }

  async *streamCompletion(messages, maxTokens = 4096) {
    const tokenParam = this._useNewTokenParam()
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages,
        ...tokenParam,
        temperature: 0,
        stream: true
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new LLMProviderError(
        `OpenAI API error: ${errorText}`,
        'openai',
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
          if (!trimmed || trimmed === 'data: [DONE]') continue;

          if (trimmed.startsWith('data: ')) {
            try {
              const data = JSON.parse(trimmed.slice(6));
              const content = data.choices?.[0]?.delta?.content;
              if (content) {
                yield content;
              }
            } catch (e) {
              console.warn('[OpenAI] Failed to parse SSE line:', trimmed, e);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async completionWithTools(messages, tools, maxTokens = 4096) {
    const tokenParam = this._useNewTokenParam()
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages,
        ...tokenParam,
        temperature: 0,
        tools: tools.map(tool => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        })),
        tool_choice: 'auto',
        stream: false
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new LLMProviderError(
        `OpenAI API error: ${errorText}`,
        'openai',
        response.status
      );
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;

    if (!message) {
      throw new LLMProviderError(
        'Invalid response format from OpenAI',
        'openai'
      );
    }

    // Check for tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      return {
        type: 'tool_call',
        content: null,
        toolCalls: message.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments
        }))
      };
    }

    // Regular text response
    return {
      type: 'text',
      content: message.content,
      toolCalls: null
    };
  }

  /**
   * Format messages for tool results (OpenAI format)
   * @param {Array} toolCalls - Array of tool calls from the response
   * @param {Array} results - Array of {toolCallId, content} objects
   * @returns {Array} Messages to append to conversation
   */
  formatToolResultMessages(toolCalls, results) {
    const messages = [];

    // Assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments)
        }
      }))
    });

    // Tool result messages
    for (const result of results) {
      messages.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: result.content
      });
    }

    return messages;
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
// Ollama Provider
// ============================================================================

class OllamaProvider {
  constructor(config) {
    this.url = config.url;
    this.model = config.model;
  }

  async *streamCompletion(messages, maxTokens = 4096) {
    const response = await fetch(`${this.url}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages,
        stream: true,
        options: {
          num_predict: maxTokens,
          temperature: 0
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new LLMProviderError(
        `Ollama API error: ${errorText}`,
        'ollama',
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

          try {
            const data = JSON.parse(trimmed);
            if (data.message?.content) {
              yield data.message.content;
            }
            if (data.done) {
              return;
            }
          } catch (e) {
            console.warn('[Ollama] Failed to parse NDJSON line:', trimmed, e);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async completionWithTools(messages, tools, maxTokens = 4096) {
    const response = await fetch(`${this.url}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages,
        stream: false,
        tools: tools.map(tool => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        })),
        options: {
          num_predict: maxTokens,
          temperature: 0
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new LLMProviderError(
        `Ollama API error: ${errorText}`,
        'ollama',
        response.status
      );
    }

    const data = await response.json();
    const message = data.message;

    if (!message) {
      throw new LLMProviderError(
        'Invalid response format from Ollama',
        'ollama'
      );
    }

    // Check for tool calls (Ollama 0.4.0+ format, same as OpenAI)
    if (message.tool_calls && message.tool_calls.length > 0) {
      return {
        type: 'tool_call',
        content: null,
        toolCalls: message.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments
        }))
      };
    }

    // Regular text response
    return {
      type: 'text',
      content: message.content,
      toolCalls: null
    };
  }

  /**
   * Format messages for tool results (Ollama uses OpenAI-compatible format)
   * @param {Array} toolCalls - Array of tool calls from the response
   * @param {Array} results - Array of {toolCallId, content} objects
   * @returns {Array} Messages to append to conversation
   */
  formatToolResultMessages(toolCalls, results) {
    const messages = [];

    // Assistant message with tool calls (Ollama expects arguments as object, not string)
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments
        }
      }))
    });

    // Tool result messages
    for (const result of results) {
      messages.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: result.content
      });
    }

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

  switch (config.provider) {
    case 'openai':
      if (!config.openai) {
        throw new LLMProviderError('OpenAI configuration missing', 'openai');
      }
      return new OpenAIProvider(config.openai);

    case 'claude':
      if (!config.claude) {
        throw new LLMProviderError('Claude configuration missing', 'claude');
      }
      return new ClaudeProvider(config.claude);

    case 'ollama':
      if (!config.ollama) {
        throw new LLMProviderError('Ollama configuration missing', 'ollama');
      }
      return new OllamaProvider(config.ollama);

    default:
      throw new LLMProviderError(`Unknown provider: ${config.provider}`, config.provider);
  }
}

// Export for use in background script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createLLMProvider,
    LLMProviderError,
    OpenAIProvider,
    ClaudeProvider,
    OllamaProvider
  };
}
