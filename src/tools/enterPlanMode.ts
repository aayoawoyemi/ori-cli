import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Tool, ToolContext } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';
import type { PlanContext } from './planTypes.js';
import { getPlanModeInstructions } from './planInstructions.js';

// ── Slug generation (no dependencies) ──────────────────────────────────────

const ADJECTIVES = [
  'amber', 'bold', 'calm', 'dark', 'eager', 'fair', 'glad', 'haze',
  'iron', 'jade', 'keen', 'lone', 'mild', 'neat', 'opal', 'pale',
  'rare', 'sage', 'taut', 'vast', 'warm', 'zeal', 'crisp', 'deft',
  'fern', 'gilt', 'hush', 'ivory', 'lucid', 'swift',
];

const NOUNS = [
  'arc', 'beam', 'claw', 'dawn', 'edge', 'flux', 'gate', 'hive',
  'isle', 'jewel', 'knot', 'loom', 'mist', 'node', 'oath', 'pike',
  'reed', 'shard', 'tide', 'vale', 'weft', 'zinc', 'anvil', 'bolt',
  'coil', 'drift', 'forge', 'glyph', 'helm', 'spark',
];

function generateSlug(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!;
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]!;
  const hex = Date.now().toString(16).slice(-4);
  return `${adj}-${noun}-${hex}`;
}

// ── Tool ───────────────────────────────────────────────────────────────────

export class EnterPlanModeTool implements Tool {
  readonly name = 'EnterPlanMode';
  readonly description = 'Enter plan mode to design an approach before coding. Creates a plan file and provides structured workflow instructions.';
  readonly readOnly = true;

  constructor(
    private planContext: PlanContext,
    private cwd: string,
    private onEnter: (filePath: string) => void,
  ) {}

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {},
      },
    };
  }

  async execute(_input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    if (this.planContext.filePath) {
      return {
        id: '', name: this.name,
        output: `Already in plan mode. Plan file: ${this.planContext.filePath}`,
        isError: true,
      };
    }

    const slug = generateSlug();
    const plansDir = join(tmpdir(), 'aries-plans');
    mkdirSync(plansDir, { recursive: true });
    const filePath = join(plansDir, `${slug}.md`);
    writeFileSync(filePath, '', 'utf-8');

    this.planContext.filePath = filePath;
    this.onEnter(filePath);

    return {
      id: '', name: this.name,
      output: getPlanModeInstructions(filePath),
      isError: false,
    };
  }
}
