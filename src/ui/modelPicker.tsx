import React, { useState, useCallback, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { Select, type SelectOption } from './select.js';
import { colors, figures } from './theme.js';
import type { EffortLevel } from '../router/index.js';
import type { ExperimentalConfig } from '../config/types.js';

const EFFORT_SYMBOLS: Record<EffortLevel, string> = {
  low: figures.effortLow,
  medium: figures.effortMedium,
  high: figures.effortHigh,
};

const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high'];

function cycleEffort(current: EffortLevel, direction: 'left' | 'right'): EffortLevel {
  const idx = EFFORT_LEVELS.indexOf(current);
  if (direction === 'right') return EFFORT_LEVELS[(idx + 1) % EFFORT_LEVELS.length]!;
  return EFFORT_LEVELS[(idx - 1 + EFFORT_LEVELS.length) % EFFORT_LEVELS.length]!;
}

interface ModelOption {
  value: string;
  label: string;
  description: string;
  supportsEffort: boolean;
  defaultEffort: EffortLevel;
}

interface ModelFamily {
  name: string;
  description: string;
  models: ModelOption[];
}

const MODEL_FAMILIES: ModelFamily[] = [
  {
    name: 'Anthropic (Claude)',
    description: 'API key required',
    models: [
      { value: 'opus', label: 'Opus 4.6', description: '1M - Most capable', supportsEffort: true, defaultEffort: 'high' },
      { value: 'sonnet', label: 'Sonnet 4.6', description: '200K - Everyday tasks', supportsEffort: true, defaultEffort: 'medium' },
      { value: 'haiku', label: 'Haiku 4.5', description: '200K - Fast + cheap', supportsEffort: true, defaultEffort: 'low' },
    ],
  },
  {
    name: 'Google (Gemini)',
    description: 'API key required',
    models: [
      { value: 'gemini', label: 'Gemini 2.5 Pro', description: '1M - Strong reasoning', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'flash', label: 'Gemini 2.5 Flash', description: '1M - Fast', supportsEffort: false, defaultEffort: 'medium' },
    ],
  },
  {
    name: 'OpenAI (API key)',
    description: 'API key required',
    models: [
      { value: 'gpt5', label: 'GPT-5', description: '1M', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'gpt4o', label: 'GPT-4o', description: '128K', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'o4-mini', label: 'o4-mini', description: '200K - Reasoning', supportsEffort: false, defaultEffort: 'medium' },
    ],
  },
  {
    name: 'ChatGPT (subscription)',
    description: 'Local OAuth subscription',
    models: [
      { value: 'gpt-5.4', label: 'gpt-5.4 (default)', description: 'Latest frontier agentic coding model', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini', description: 'Smaller frontier agentic coding model', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'gpt-5.3', label: 'gpt-5.3-codex', description: 'Frontier Codex-optimized agentic coding model', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'gpt-5.2', label: 'gpt-5.2', description: 'Optimized for long-running agents', supportsEffort: false, defaultEffort: 'medium' },
    ],
  },
  {
    name: 'Open Models (direct APIs)',
    description: 'DashScope, Moonshot, Groq, DeepSeek',
    models: [
      { value: 'deepseek', label: 'DeepSeek V3', description: '128K', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'deepseek-r1', label: 'DeepSeek R1', description: '128K - Reasoning', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'qwen3.6', label: 'Qwen3.6-Plus', description: '131K - DashScope', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'qwen3', label: 'Qwen3 235B', description: '131K - DashScope', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'kimi', label: 'Kimi K2', description: '128K - Moonshot', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'llama', label: 'Llama 3.3 70B', description: '128K - Groq', supportsEffort: false, defaultEffort: 'medium' },
    ],
  },
  {
    name: 'OpenRouter (paid)',
    description: 'One key, routed providers',
    models: [
      { value: 'qwen3.6-or', label: 'Qwen3.6-Plus', description: '131K', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'glm5', label: 'GLM 5.1', description: '203K', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'gemma4', label: 'Gemma 4 26B', description: '262K', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'deepseek-v3', label: 'DeepSeek V3.2', description: '131K', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'minimax', label: 'MiniMax M2.7', description: '1M', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'gemini-flash', label: 'Gemini 3 Flash', description: '1M - Preview', supportsEffort: false, defaultEffort: 'medium' },
    ],
  },
  {
    name: 'Local',
    description: 'llama.cpp / localhost',
    models: [
      { value: 'devstral', label: 'Devstral', description: '131K - llama.cpp', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'qwen-coder-7b', label: 'Qwen Coder 7B', description: '32K - llama.cpp', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'qwen-coder-3b', label: 'Qwen Coder 3B', description: '32K - llama.cpp', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'local', label: 'Local (Ollama)', description: '128K - localhost', supportsEffort: false, defaultEffort: 'medium' },
    ],
  },
  {
    name: 'OpenRouter (free)',
    description: 'Rate-limited free tier',
    models: [
      { value: 'qwen3.6-free', label: 'Qwen3.6 (free)', description: '131K - Rate-limited', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'qwen3-free', label: 'Qwen3 235B (free)', description: '131K - Rate-limited', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'gemma4-free', label: 'Gemma 4 26B (free)', description: '262K - Rate-limited', supportsEffort: false, defaultEffort: 'medium' },
    ],
  },
];

function findCurrentFamily(currentModel: string): number {
  for (let i = 0; i < MODEL_FAMILIES.length; i++) {
    if (MODEL_FAMILIES[i]!.models.some(m => m.value === currentModel)) return i;
  }
  return 0;
}

export interface ModelPickerProps {
  currentModel: string;
  currentEffort: EffortLevel;
  onSelect: (model: string, effort: EffortLevel) => void;
  onCancel: () => void;
  experimental?: ExperimentalConfig;
}

const SUBSCRIPTION_MODELS = new Set(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3', 'gpt-5.2']);

export function ModelPicker({
  currentModel,
  currentEffort,
  onSelect,
  onCancel,
  experimental,
}: ModelPickerProps): React.ReactElement {
  const oauthEnabled = experimental?.localChatGPTSubscription ?? false;
  const [phase, setPhase] = useState<'family' | 'model'>('family');
  const [selectedFamily, setSelectedFamily] = useState(findCurrentFamily(currentModel));
  const [effort, setEffort] = useState<EffortLevel>(currentEffort);
  const [hasToggledEffort, setHasToggledEffort] = useState(false);
  const [focusedModel, setFocusedModel] = useState<string>(currentModel);

  const currentFamilyIdx = findCurrentFamily(currentModel);

  const familyOptions: SelectOption<number>[] = useMemo(
    () => MODEL_FAMILIES.map((f, i) => ({
      value: i,
      label: f.name,
      description: i === currentFamilyIdx ? `${f.description} - current` : f.description,
    })),
    [currentFamilyIdx],
  );

  const handleFamilySelect = useCallback((idx: number) => {
    setSelectedFamily(idx);
    const family = MODEL_FAMILIES[idx]!;
    const currentInFamily = family.models.find(m => m.value === currentModel);
    setFocusedModel(currentInFamily?.value ?? family.models[0]!.value);
    setPhase('model');
  }, [currentModel]);

  const family = MODEL_FAMILIES[selectedFamily]!;

  const modelOptions: SelectOption<string>[] = useMemo(
    () => family.models.map(m => ({
      value: m.value,
      label: m.label,
      description: m.description,
    })),
    [selectedFamily],
  );

  const handleModelSelect = useCallback((value: string) => {
    if (SUBSCRIPTION_MODELS.has(value) && !oauthEnabled) return;
    onSelect(value, effort);
  }, [onSelect, effort, oauthEnabled]);

  const handleModelFocus = useCallback((value: string) => {
    setFocusedModel(value);
    if (!hasToggledEffort) {
      const model = family.models.find(m => m.value === value);
      if (model) setEffort(model.defaultEffort);
    }
  }, [hasToggledEffort, family]);

  useInput((_input, key) => {
    if (phase === 'model' && key.backspace) {
      setPhase('family');
      return;
    }
    if (phase === 'model') {
      const focused = family.models.find(m => m.value === focusedModel);
      if (!focused?.supportsEffort) return;
      if (key.leftArrow) {
        setEffort(prev => cycleEffort(prev, 'left'));
        setHasToggledEffort(true);
      }
      if (key.rightArrow) {
        setEffort(prev => cycleEffort(prev, 'right'));
        setHasToggledEffort(true);
      }
    }
  });

  const focusedConfig = family.models.find(m => m.value === focusedModel);
  const supportsEffort = focusedConfig?.supportsEffort ?? false;
  const defaultEffort = focusedConfig?.defaultEffort ?? 'medium';

  if (phase === 'family') {
    return (
      <Box flexDirection="column" paddingTop={1}>
        <Box marginBottom={1} flexDirection="column">
          <Text color={colors.suggestion} bold>Select provider</Text>
          <Text dimColor>OpenRouter paid models are in "OpenRouter (paid)".</Text>
          <Text dimColor>Enter to select, Esc to cancel.</Text>
        </Box>
        <Select
          options={familyOptions}
          defaultValue={currentFamilyIdx}
          onChange={handleFamilySelect}
          onCancel={onCancel}
          visibleCount={Math.min(9, familyOptions.length)}
        />
        <Box marginTop={1}>
          <Text dimColor italic>Enter select | Esc cancel</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingTop={1}>
      <Box marginBottom={1} flexDirection="column">
        <Text color={colors.suggestion} bold>{family.name}</Text>
        <Text dimColor>Enter to confirm, Backspace to go back, Esc to cancel.</Text>
      </Box>
      <Select
        options={modelOptions}
        defaultValue={focusedModel}
        onChange={handleModelSelect}
        onCancel={onCancel}
        onFocus={handleModelFocus}
        visibleCount={Math.min(8, family.models.length)}
      />

      <Box marginTop={1} marginBottom={1}>
        {supportsEffort ? (
          <Text dimColor>
            <Text color={colors.suggestion}>{EFFORT_SYMBOLS[effort]}</Text>
            {' '}{effort.charAt(0).toUpperCase() + effort.slice(1)} effort
            {effort === defaultEffort ? ' (default)' : ''}
            {'  '}
            <Text color={colors.dim}>left/right to adjust</Text>
          </Text>
        ) : (
          <Text color={colors.dim}>
            {EFFORT_SYMBOLS.low} Effort not supported for {focusedConfig?.label ?? 'this model'}
          </Text>
        )}
      </Box>

      {family.name === 'ChatGPT (subscription)' && !oauthEnabled && (
        <Box marginTop={1}>
          <Text color={colors.warning}>
            Requires experimental.localChatGPTSubscription: true in ~/.aries/config.yaml
          </Text>
        </Box>
      )}

      <Text dimColor italic>Enter confirm | Backspace back | Esc cancel</Text>
    </Box>
  );
}