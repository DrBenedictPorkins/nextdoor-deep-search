/**
 * Nextdoor Deep Search - Options Page Script
 *
 * Handles:
 * 1. Claude API configuration
 * 2. API validation
 * 3. Storage of AI configuration
 */

(function() {
  'use strict';

  // DOM Elements
  const elements = {
    // Claude
    claudeApiKey: document.getElementById('claude-api-key'),
    claudeModel: document.getElementById('claude-model'),
    claudeToggleKey: document.getElementById('claude-toggle-key'),

    // Response Settings
    maxTokens: document.getElementById('max-tokens'),
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
    elements.claudeToggleKey.addEventListener('click', () => togglePasswordVisibility(elements.claudeApiKey, elements.claudeToggleKey));
    elements.validateBtn.addEventListener('click', validateConfiguration);
    elements.saveBtn.addEventListener('click', saveConfiguration);
    elements.resetPromptBtn.addEventListener('click', resetPromptToDefault);

    // Enable validation when inputs change
    [elements.claudeApiKey, elements.claudeModel].forEach(el => {
      el.addEventListener('input', handleInputChange);
    });

    // Enable validate button since Claude is always selected
    elements.validateBtn.disabled = false;
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
      if (data.aiConfig && data.aiConfig.claude) {
        currentConfig = data.aiConfig;
        elements.claudeApiKey.value = currentConfig.claude.apiKey || '';
        elements.claudeModel.value = currentConfig.claude.model || 'claude-haiku-4-5-20251001';

        // Load custom prompt if set
        if (currentConfig.customPrompt) {
          elements.customPrompt.value = currentConfig.customPrompt;
        }

        // Load max tokens if set
        if (currentConfig.maxTokens) {
          elements.maxTokens.value = currentConfig.maxTokens;
        }

        updateCurrentStatus();
      }
    } catch (e) {
      console.error('[NDS Options] Error loading config:', e);
    }
  }

  // ============================================================================
  // UI Event Handlers
  // ============================================================================

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
    elements.saveBtn.disabled = !validationPassed;
  }

  // ============================================================================
  // Validation
  // ============================================================================

  async function validateConfiguration() {
    showValidationSpinner('Validating configuration...');
    validationPassed = false;
    updateButtonStates();

    try {
      await validateClaude();
      validationPassed = true;
      showValidationSuccess('Configuration validated successfully!');
    } catch (error) {
      validationPassed = false;
      showValidationError(error.message);
    }

    updateButtonStates();
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

  // ============================================================================
  // Save Configuration
  // ============================================================================

  async function saveConfiguration() {
    if (!validationPassed) return;

    const customPrompt = elements.customPrompt.value.trim();
    const maxTokens = parseInt(elements.maxTokens.value, 10) || 2048;

    const config = {
      provider: 'claude',
      claude: {
        apiKey: elements.claudeApiKey.value.trim(),
        model: elements.claudeModel.value
      },
      customPrompt: customPrompt || null,
      maxTokens: maxTokens
    };

    try {
      await browser.storage.local.set({ aiConfig: config });
      currentConfig = config;
      updateCurrentStatus();
      showValidationSuccess('Configuration saved successfully!');
      console.log('[NDS Options] Configuration saved: claude');
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
    if (currentConfig && currentConfig.claude) {
      elements.currentStatus.style.display = 'block';
      elements.statusText.textContent = `Claude - ${currentConfig.claude.model}`;
    } else {
      elements.currentStatus.style.display = 'none';
    }
  }

  // ============================================================================
  // Start
  // ============================================================================

  init();

})();
