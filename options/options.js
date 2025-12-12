/**
 * Nextdoor Deep Search - Options Page Script
 *
 * Handles:
 * 1. Provider selection and configuration
 * 2. API validation
 * 3. Storage of AI configuration
 */

(function() {
  'use strict';

  // DOM Elements
  const elements = {
    providerSelect: document.getElementById('provider-select'),

    // OpenAI
    openaiConfig: document.getElementById('openai-config'),
    openaiApiKey: document.getElementById('openai-api-key'),
    openaiModel: document.getElementById('openai-model'),
    openaiToggleKey: document.getElementById('openai-toggle-key'),

    // Claude
    claudeConfig: document.getElementById('claude-config'),
    claudeApiKey: document.getElementById('claude-api-key'),
    claudeModel: document.getElementById('claude-model'),
    claudeToggleKey: document.getElementById('claude-toggle-key'),

    // Ollama
    ollamaConfig: document.getElementById('ollama-config'),
    ollamaUrl: document.getElementById('ollama-url'),
    ollamaModel: document.getElementById('ollama-model'),

    // Custom Prompt
    customPrompt: document.getElementById('custom-prompt'),
    resetPromptBtn: document.getElementById('reset-prompt-btn'),

    // Validation
    validationStatus: document.getElementById('validation-status'),
    validationSpinner: document.getElementById('validation-spinner'),
    validationSuccess: document.getElementById('validation-success'),
    validationError: document.getElementById('validation-error'),
    validationMessage: document.getElementById('validation-message'),

    // Buttons
    validateBtn: document.getElementById('validate-btn'),
    saveBtn: document.getElementById('save-btn'),

    // Status
    currentStatus: document.getElementById('current-status'),
    statusText: document.getElementById('status-text')
  };

  // State
  let validationPassed = false;
  let currentConfig = null;
  let defaultPrompt = '';

  // ============================================================================
  // Initialization
  // ============================================================================

  async function init() {
    // Load default prompt from background
    await loadDefaultPrompt();

    // Load saved configuration
    await loadConfiguration();

    // Set up event listeners
    elements.providerSelect.addEventListener('change', handleProviderChange);
    elements.openaiToggleKey.addEventListener('click', () => togglePasswordVisibility(elements.openaiApiKey, elements.openaiToggleKey));
    elements.claudeToggleKey.addEventListener('click', () => togglePasswordVisibility(elements.claudeApiKey, elements.claudeToggleKey));
    elements.validateBtn.addEventListener('click', validateConfiguration);
    elements.saveBtn.addEventListener('click', saveConfiguration);
    elements.resetPromptBtn.addEventListener('click', resetPromptToDefault);

    // Enable validation when inputs change
    [elements.openaiApiKey, elements.openaiModel, elements.claudeApiKey, elements.claudeModel,
     elements.ollamaUrl, elements.ollamaModel].forEach(el => {
      el.addEventListener('input', handleInputChange);
    });
  }

  async function loadDefaultPrompt() {
    try {
      const response = await browser.runtime.sendMessage({ type: 'GET_DEFAULT_PROMPT' });
      defaultPrompt = response?.data || '';
      // Set the default prompt as initial value (user can edit it)
      elements.customPrompt.value = defaultPrompt;
    } catch (e) {
      console.error('[NDS Options] Error loading default prompt:', e);
    }
  }

  function resetPromptToDefault() {
    elements.customPrompt.value = defaultPrompt;
  }

  // ============================================================================
  // Configuration Loading
  // ============================================================================

  async function loadConfiguration() {
    try {
      const data = await browser.storage.local.get('aiConfig');
      if (data.aiConfig && data.aiConfig.provider) {
        currentConfig = data.aiConfig;
        elements.providerSelect.value = currentConfig.provider;

        // Load provider-specific config
        if (currentConfig.provider === 'openai' && currentConfig.openai) {
          elements.openaiApiKey.value = currentConfig.openai.apiKey || '';
          elements.openaiModel.value = currentConfig.openai.model || 'gpt-4o';
        } else if (currentConfig.provider === 'claude' && currentConfig.claude) {
          elements.claudeApiKey.value = currentConfig.claude.apiKey || '';
          elements.claudeModel.value = currentConfig.claude.model || 'claude-sonnet-4-20250514';
        } else if (currentConfig.provider === 'ollama' && currentConfig.ollama) {
          elements.ollamaUrl.value = currentConfig.ollama.url || 'http://localhost:11434';
          elements.ollamaModel.value = currentConfig.ollama.model || 'qwen2.5:7b';
        }

        // Load custom prompt if set
        if (currentConfig.customPrompt) {
          elements.customPrompt.value = currentConfig.customPrompt;
        }

        handleProviderChange();
        updateCurrentStatus();
      }
    } catch (e) {
      console.error('[NDS Options] Error loading config:', e);
    }
  }

  // ============================================================================
  // UI Event Handlers
  // ============================================================================

  function handleProviderChange() {
    const provider = elements.providerSelect.value;

    // Hide all configs
    elements.openaiConfig.style.display = 'none';
    elements.claudeConfig.style.display = 'none';
    elements.ollamaConfig.style.display = 'none';

    // Show selected config
    if (provider === 'openai') {
      elements.openaiConfig.style.display = 'block';
    } else if (provider === 'claude') {
      elements.claudeConfig.style.display = 'block';
    } else if (provider === 'ollama') {
      elements.ollamaConfig.style.display = 'block';
    }

    // Update button states
    updateButtonStates();
    hideValidation();
  }

  function handleInputChange() {
    validationPassed = false;
    updateButtonStates();
    hideValidation();
  }

  function togglePasswordVisibility(input, button) {
    if (input.type === 'password') {
      input.type = 'text';
      button.textContent = 'Hide';
    } else {
      input.type = 'password';
      button.textContent = 'Show';
    }
  }

  function updateButtonStates() {
    const provider = elements.providerSelect.value;
    const hasProvider = provider !== '';

    elements.validateBtn.disabled = !hasProvider;
    elements.saveBtn.disabled = !validationPassed;
  }

  // ============================================================================
  // Validation
  // ============================================================================

  async function validateConfiguration() {
    const provider = elements.providerSelect.value;

    if (!provider) return;

    showValidationSpinner('Validating configuration...');
    validationPassed = false;
    updateButtonStates();

    try {
      if (provider === 'openai') {
        await validateOpenAI();
      } else if (provider === 'claude') {
        await validateClaude();
      } else if (provider === 'ollama') {
        await validateOllama();
      }

      validationPassed = true;
      showValidationSuccess('Configuration validated successfully!');
    } catch (error) {
      validationPassed = false;
      showValidationError(error.message);
    }

    updateButtonStates();
  }

  async function validateOpenAI() {
    const apiKey = elements.openaiApiKey.value.trim();
    const model = elements.openaiModel.value;

    if (!apiKey) {
      throw new Error('API key is required');
    }

    const response = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Invalid API key');
      } else if (response.status === 429) {
        throw new Error('Rate limit exceeded');
      } else {
        throw new Error(`API error: ${response.status}`);
      }
    }

    const data = await response.json();
    const modelExists = data.data.some(m => m.id === model);

    if (!modelExists) {
      console.warn('[NDS Options] Model not found in list, but continuing...');
    }
  }

  async function validateClaude() {
    const apiKey = elements.claudeApiKey.value.trim();
    const model = elements.claudeModel.value;

    if (!apiKey) {
      throw new Error('API key is required');
    }

    // Test with minimal message
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 10,
        messages: [
          { role: 'user', content: 'Hi' }
        ]
      })
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Invalid API key');
      } else if (response.status === 429) {
        throw new Error('Rate limit exceeded');
      } else if (response.status === 400) {
        const errorData = await response.json();
        if (errorData.error?.type === 'invalid_request_error' && errorData.error?.message?.includes('model')) {
          throw new Error(`Invalid model: ${model}`);
        }
        throw new Error('Invalid request');
      } else {
        throw new Error(`API error: ${response.status}`);
      }
    }
  }

  async function validateOllama() {
    const url = elements.ollamaUrl.value.trim();
    const model = elements.ollamaModel.value.trim();

    if (!url) {
      throw new Error('Server URL is required');
    }

    if (!model) {
      throw new Error('Model name is required');
    }

    // Check server and get available models
    const response = await fetch(`${url}/api/tags`, {
      method: 'GET'
    });

    if (!response.ok) {
      throw new Error(`Cannot connect to Ollama server at ${url}`);
    }

    const data = await response.json();
    const modelExists = data.models.some(m => m.name === model);

    if (!modelExists) {
      throw new Error(`Model "${model}" not found on server. Available models: ${data.models.map(m => m.name).join(', ')}`);
    }
  }

  // ============================================================================
  // Save Configuration
  // ============================================================================

  async function saveConfiguration() {
    if (!validationPassed) return;

    const provider = elements.providerSelect.value;
    const customPrompt = elements.customPrompt.value.trim();

    const config = {
      provider: provider,
      openai: null,
      claude: null,
      ollama: null,
      customPrompt: customPrompt || null  // Store custom prompt (null if empty = use default)
    };

    if (provider === 'openai') {
      config.openai = {
        apiKey: elements.openaiApiKey.value.trim(),
        model: elements.openaiModel.value
      };
    } else if (provider === 'claude') {
      config.claude = {
        apiKey: elements.claudeApiKey.value.trim(),
        model: elements.claudeModel.value
      };
    } else if (provider === 'ollama') {
      config.ollama = {
        url: elements.ollamaUrl.value.trim(),
        model: elements.ollamaModel.value.trim()
      };
    }

    try {
      await browser.storage.local.set({ aiConfig: config });
      currentConfig = config;
      updateCurrentStatus();
      showValidationSuccess('Configuration saved successfully!');
      console.log('[NDS Options] Configuration saved:', provider);
    } catch (e) {
      console.error('[NDS Options] Error saving config:', e);
      showValidationError('Failed to save configuration');
    }
  }

  // ============================================================================
  // UI Updates
  // ============================================================================

  function showValidationSpinner(message) {
    elements.validationStatus.style.display = 'flex';
    elements.validationSpinner.style.display = 'block';
    elements.validationSuccess.style.display = 'none';
    elements.validationError.style.display = 'none';
    elements.validationMessage.textContent = message;
    elements.validationMessage.className = 'validation-message';
  }

  function showValidationSuccess(message) {
    elements.validationStatus.style.display = 'flex';
    elements.validationSpinner.style.display = 'none';
    elements.validationSuccess.style.display = 'block';
    elements.validationError.style.display = 'none';
    elements.validationMessage.textContent = message;
    elements.validationMessage.className = 'validation-message success';
  }

  function showValidationError(message) {
    elements.validationStatus.style.display = 'flex';
    elements.validationSpinner.style.display = 'none';
    elements.validationSuccess.style.display = 'none';
    elements.validationError.style.display = 'block';
    elements.validationMessage.textContent = message;
    elements.validationMessage.className = 'validation-message error';
  }

  function hideValidation() {
    elements.validationStatus.style.display = 'none';
  }

  function updateCurrentStatus() {
    if (currentConfig && currentConfig.provider) {
      elements.currentStatus.style.display = 'block';
      let providerName = currentConfig.provider.charAt(0).toUpperCase() + currentConfig.provider.slice(1);
      let model = '';

      if (currentConfig.provider === 'openai' && currentConfig.openai) {
        model = currentConfig.openai.model;
      } else if (currentConfig.provider === 'claude' && currentConfig.claude) {
        model = currentConfig.claude.model;
      } else if (currentConfig.provider === 'ollama' && currentConfig.ollama) {
        model = currentConfig.ollama.model;
      }

      elements.statusText.textContent = `${providerName} - ${model}`;
    } else {
      elements.currentStatus.style.display = 'none';
    }
  }

  // ============================================================================
  // Start
  // ============================================================================

  init();

})();
