import React, { useState, useCallback, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { Select, type SelectOption } from './select.js';
import { colors } from './theme.js';
import type { EffortLevel } from '../router/index.js';

// ── Effort ────────────────────────────────────────────────────────────────

import { figures } from './theme.js';

const EFFORT_SYMBOLS: Record<EffortLevel, string> = {
  low:    figures.effortLow,
  medium: figures.effortMedium,
  high:   figures.effortHigh,
};

const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high'];

function cycleEffort(current: EffortLevel, direction: 'left' | 'right'): EffortLevel {
  const idx = EFFORT_LEVELS.indexOf(current);
  if (direction === 'right') {
    return EFFORT_LEVELS[(idx + 1) % EFFORT_LEVELS.length]!;
  }
  return EFFORT_LEVELS[(idx - 1 + EFFORT_LEVELS.length) % EFFORT_LEVELS.length]!;
}

// ── Model Definitions ──────────────────────────────────────────────────────

interface ModelOption {
  value: string;
  label: string;
  description: string;
  supportsEffort: boolean;
  defaultEffort: EffortLevel;
}

interface ModelFamily {
  name: string;
  models: ModelOption[];
}

const MODEL_FAMILIES: ModelFamily[] = [
  {
    name: 'Anthropic (Claude)',
    models: [
      { value: 'opus',   label: 'Opus 4.6',    description: '1M · Most capable',     supportsEffort: true,  defaultEffort: 'high' },
      { value: 'sonnet', label: 'Sonnet 4.6',   description: '200K · Everyday tasks',  supportsEffort: true,  defaultEffort: 'medium' },
      { value: 'haiku',  label: 'Haiku 4.5',    description: '200K · Fast + cheap',    supportsEffort: true,  defaultEffort: 'low' },
    ],
  },
  {
    name: 'Google (Gemini)',
    models: [
      { value: 'gemini', label: 'Gemini 2.5 Pro',   description: '1M · Strong reasoning', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'flash',  label: 'Gemini 2.5 Flash',  description: '1M · Fast',             supportsEffort: false, defaultEffort: 'medium' },
    ],
  },
  {
    name: 'OpenAI',
    models: [
      { value: 'gpt5',    label: 'GPT-5',    description: '1M',                supportsEffort: false, defaultEffort: 'medium' },
      { value: 'gpt4o',   label: 'GPT-4o',   description: '128K',              supportsEffort: false, defaultEffort: 'medium' },
      { value: 'o4-mini', label: 'o4-mini',   description: '200K · Reasoning',  supportsEffort: false, defaultEffort: 'medium' },
    ],
  },
  {
    name: 'Open Source',
    models: [
      { value: 'deepseek',    label: 'DeepSeek V3',      description: '128K',              supportsEffort: false, defaultEffort: 'medium' },
      { value: 'deepseek-r1', label: 'DeepSeek R1',      description: '128K · Reasoning',  supportsEffort: false, defaultEffort: 'medium' },
      { value: 'qwen3.6',     label: 'Qwen3.6-Plus',     description: '131K · DashScope',  supportsEffort: false, defaultEffort: 'medium' },
      { value: 'qwen3',       label: 'Qwen3 235B',       description: '131K · DashScope',  supportsEffort: false, defaultEffort: 'medium' },
      { value: 'kimi',        label: 'Kimi K2',          description: '128K · Moonshot',   supportsEffort: false, defaultEffort: 'medium' },
      { value: 'llama',       label: 'Llama 3.3 70B',    description: '128K · Groq',       supportsEffort: false, defaultEffort: 'medium' },
    ],
  },
  {
    name: 'Local',
    models: [
      { value: 'devstral',       label: 'Devstral',       description: '131K · llama.cpp',  supportsEffort: false, defaultEffort: 'medium' },
      { value: 'qwen-coder-7b',  label: 'Qwen Coder 7B',  description: '32K · llama.cpp',   supportsEffort: false, defaultEffort: 'medium' },
      { value: 'qwen-coder-3b',  label: 'Qwen Coder 3B',  description: '32K · llama.cpp',   supportsEffort: false, defaultEffort: 'medium' },
      { value: 'local',          label: 'Local (Ollama)',  description: '128K · localhost',   supportsEffort: false, defaultEffort: 'medium' },
    ],
  },
  {
    name: 'OpenRouter (free)',
    models: [
      { value: 'qwen3.6-free', label: 'Qwen3.6 (free)',     description: '131K · Rate-limited', supportsEffort: false, defaultEffort: 'medium' },
      { value: 'qwen3-free',   label: 'Qwen3 235B (free)',   description: '131K · Rate-limited', supportsEffort: false, defaultEffort: 'medium' },
    ],
  },
];

// Find which family the current model belongs to
function findCurrentFamily(currentModel: string): number {
  for (let i = 0; i < MODEL_FAMILIES.length; i++) {
    if (MODEL_FAMILIES[i]!.models.some(m => m.value === currentModel)) return i;
  }
  return 0;
}

// ── Props ──────────────────────────────────────────────────────────────────

export interface ModelPickerProps {
  currentModel: string;
  currentEffort: EffortLevel;
  onSelect: (model: string, effort: EffortLevel) => void;
  onCancel: () => void;
}

// ── ModelPicker Component ──────────────────────────────────────────────────
// Two-tier: families → models. Enter drills in, Backspace goes back.

export function ModelPicker({
  currentModel,
  currentEffort,
  onSelect,
  onCancel,
}: ModelPickerProps): React.ReactElement {
  const [phase, setPhase] = useState<'family' | 'model'>('family');
  const [selectedFamily, setSelectedFamily] = useState(findCurrentFamily(currentModel));
  const [effort, setEffort] = useState<EffortLevel>(currentEffort);
  const [hasToggledEffort, setHasToggledEffort] = useState(false);
  const [focusedModel, setFocusedModel] = useState<string>(currentModel);

  const currentFamilyIdx = findCurrentFamily(currentModel);

  // ── Family view ────────────────────────────────────────────────────────

  const familyOptions: SelectOption<number>[] = useMemo(
    () => MODEL_FAMILIES.map((f, i) => ({
      value: i,
      label: f.name,
      description: i === currentFamilyIdx ? '← current' : undefined,
    })),
    [currentFamilyIdx],
  );

  const handleFamilySelect = useCallback((idx: number) => {
    setSelectedFamily(idx);
    const family = MODEL_FAMILIES[idx]!;
    // Pre-select current model if in this family, else first model
    const currentInFamily = family.models.find(m => m.value === currentModel);
    setFocusedModel(currentInFamily?.value ?? family.models[0]!.value);
    setPhase('model');
  }, [currentModel]);

  // ── Model view ─────────────────────────────────────────────────────────

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
    onSelect(value, effort);
  }, [onSelect, effort]);

  const handleModelFocus = useCallback((value: string) => {
    setFocusedModel(value);
    if (!hasToggledEffort) {
      const model = family.models.find(m => m.value === value);
      if (model) setEffort(model.defaultEffort);
    }
  }, [hasToggledEffort, family]);

  // Backspace in model view → back to families
  useInput((_input, key) => {
    if (phase === 'model' && key.backspace) {
      setPhase('family');
      return;
    }
    // Effort cycling (model view only)
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

  // ── Render ─────────────────────────────────────────────────────────────

  if (phase === 'family') {
    return (
      <Box flexDirection="column" paddingTop={1}>
        <Box marginBottom={1} flexDirection="column">
          <Text color={colors.suggestion} bold>Select provider</Text>
          <Text dimColor>Enter to select, Esc to cancel.</Text>
        </Box>
        <Select
          options={familyOptions}
          defaultValue={currentFamilyIdx}
          onChange={handleFamilySelect}
          onCancel={onCancel}
          visibleCount={6}
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

      {/* Effort indicator */}
      <Box marginTop={1} marginBottom={1}>
        {supportsEffort ? (
          <Text dimColor>
            <Text color={colors.suggestion}>{EFFORT_SYMBOLS[effort]}</Text>
            {' '}{effort.charAt(0).toUpperCase() + effort.slice(1)} effort
            {effort === defaultEffort ? ' (default)' : ''}
            {'  '}
            <Text color={colors.dim}>← → to adjust</Text>
          </Text>
        ) : (
          <Text color={colors.dim}>
            {EFFORT_SYMBOLS.low} Effort not supported for {focusedConfig?.label ?? 'this model'}
          </Text>
        )}
      </Box>

      <Text dimColor italic>Enter confirm | Backspace back | Esc cancel</Text>
    </Box>
  );
}
