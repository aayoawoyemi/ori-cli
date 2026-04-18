import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { colors, figures } from './theme.js';
import type { ResearchEvent } from '../research/types.js';

// ── The self-writing page ─────────────────────────────────────────────────
// A research run renders here as a slowly-accruing prose journal. Phase
// transitions produce soft header sentences; each ingested source adds a
// bullet; completed phases dim into the background while the bright tip
// moves downward. Reading pace, not event pace.

type LineKind = 'title' | 'header' | 'bullet' | 'path' | 'quiet';

interface JournalLine {
  kind: LineKind;
  text: string;
  phase: string;
  addedAt: number;
}

export interface ResearchJournalHandle {
  push: (event: ResearchEvent) => void;
}

interface ResearchJournalProps {
  handleRef?: React.MutableRefObject<ResearchJournalHandle | null>;
}

export function ResearchJournal({ handleRef }: ResearchJournalProps): React.ReactElement {
  const [lines, setLines] = useState<JournalLine[]>([]);
  const [budget, setBudget] = useState<{ spent: number; max: number } | null>(null);
  const [, forceTick] = useState(0);

  // Mutable queue of pending lines waiting to be flushed at reading pace.
  // Lives in a ref so events can enqueue without re-rendering per push.
  const pendingRef = useRef<JournalLine[]>([]);
  // Current phase — bumped at each phase_start event. Lines belonging to
  // older phases render dim regardless of their age.
  const phaseRef = useRef<string>('init');

  // Imperative handle: parent pushes events in via handleRef.current.push(e).
  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      push: (event: ResearchEvent) => {
        translateEvent(event, pendingRef, phaseRef, setBudget);
      },
    };
    return () => {
      if (handleRef) handleRef.current = null;
    };
  }, [handleRef]);

  // Flush loop: every ~800ms, promote one pending line to visible. This is
  // the "reading pace" — if events arrive faster than this, they queue up
  // and stream onto the page slowly. If events arrive slower, the queue
  // drains and we just re-render for age-based dimming.
  useEffect(() => {
    const FLUSH_MS = 800;
    const iv = setInterval(() => {
      if (pendingRef.current.length > 0) {
        const next = pendingRef.current.shift();
        if (next) {
          // Stamp the visible addedAt at flush time, not push time, so age
          // dimming tracks what the reader actually saw.
          setLines(prev => [...prev, { ...next, addedAt: Date.now() }]);
        }
      } else {
        forceTick(t => (t + 1) & 0xffff);
      }
    }, FLUSH_MS);
    return () => clearInterval(iv);
  }, []);

  // Dimming re-render: forces a repaint every 500ms so age-based color
  // tiers transition smoothly as lines grow older without any new events.
  useEffect(() => {
    const iv = setInterval(() => forceTick(t => (t + 1) & 0xffff), 500);
    return () => clearInterval(iv);
  }, []);

  const now = Date.now();

  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.map((line, i) => {
        const age = now - line.addedAt;
        const isCurrentPhase = line.phase === phaseRef.current;
        const color = computeColor(age, isCurrentPhase, line.kind);
        return renderLine(line, color, i);
      })}
      {budget && lines.length > 0 && (
        <Box marginTop={1}>
          <Text color={colors.inactive}>       </Text>
          <Text color={colors.inactive}>∙ {formatNum(budget.spent)} of {formatNum(budget.max)} tokens</Text>
        </Box>
      )}
    </Box>
  );
}

// ── Color tiers ───────────────────────────────────────────────────────────
// Bright tip: ~1.5s. Mid warmth: to 4s. Then settles into the page.
// The title (the glyph + query) keeps its gold accent throughout.
function computeColor(age: number, isCurrentPhase: boolean, kind: LineKind): string {
  if (kind === 'title') return colors.research;
  if (kind === 'path') return colors.claude;
  if (!isCurrentPhase) return colors.dim;
  if (age < 1500) return colors.text;
  if (age < 4000) return colors.subtle;
  return colors.dim;
}

// ── Line renderers ────────────────────────────────────────────────────────
// Indent = 7 spaces so everything hangs off the glyph column.
const INDENT = '       ';
const BULLET_INDENT = '         ';

function renderLine(line: JournalLine, color: string, key: number): React.ReactElement {
  switch (line.kind) {
    case 'title':
      return (
        <Box key={key} marginBottom={1}>
          <Text color={colors.research}>  {figures.researchMode}    </Text>
          <Text color={color} bold>{line.text}</Text>
        </Box>
      );
    case 'header':
      return (
        <Box key={key} marginTop={1}>
          <Text color={color}>{INDENT}{line.text}</Text>
        </Box>
      );
    case 'bullet':
      return (
        <Text key={key} color={color}>{BULLET_INDENT}{figures.bullet}  {line.text}</Text>
      );
    case 'path':
      return (
        <Box key={key} marginTop={1}>
          <Text color={color}>{BULLET_INDENT}{line.text}</Text>
        </Box>
      );
    case 'quiet':
      return (
        <Text key={key} color={colors.inactive}>{BULLET_INDENT}{line.text}</Text>
      );
  }
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

// ── Event → prose translator ──────────────────────────────────────────────
// Maps each engine event to zero, one, or multiple journal lines. The
// wording is deliberate: first-person, soft, deliberate. No numbers leading
// sentences; no "[extract]" labels.

function translateEvent(
  event: ResearchEvent,
  pendingRef: React.MutableRefObject<JournalLine[]>,
  phaseRef: React.MutableRefObject<string>,
  setBudget: (b: { spent: number; max: number }) => void,
): void {
  const now = Date.now();
  const push = (kind: LineKind, text: string) => {
    pendingRef.current.push({ kind, text, phase: phaseRef.current, addedAt: now });
  };
  const enterPhase = (phase: string) => {
    phaseRef.current = phase;
  };

  switch (event.type) {
    case 'run_start':
      enterPhase('title');
      push('title', event.query);
      break;

    case 'discover_start':
      if (event.loop === 0) {
        enterPhase('discover');
        push('header', "I'm looking across seven places — arxiv, semantic scholar, openalex, github, wikipedia, reddit, and exa's neural index.");
      } else {
        enterPhase(`discover-${event.loop}`);
        push('header', 'Going back out for another pass.');
      }
      break;

    case 'discover_done': {
      const worth = Math.min(15, event.surfaced);
      if (event.surfaced === 0) {
        push('bullet', "Nothing surfaced. That's rare — I'll keep moving anyway.");
      } else {
        push('bullet', `${event.surfaced} surfaced.  ${worth} feel worth reading.`);
      }
      break;
    }

    case 'ingest_start':
      enterPhase('ingest');
      push('header', 'Reading the ones that matter now.');
      break;

    case 'ingest_source': {
      const label = sourceLabel(event.sourceApi);
      const title = truncate(event.title, 72);
      push('bullet', `${label} — ${title}`);
      break;
    }

    case 'ingest_done':
      if (event.dropped > 0 || event.skim > 0) {
        const parts: string[] = [];
        if (event.dropped > 0) parts.push(`${event.dropped} set aside as thin`);
        if (event.skim > 0) parts.push(`${event.skim} skimmed lightly`);
        push('bullet', `(${parts.join(', ')})`);
      }
      break;

    case 'extract_start':
      enterPhase('extract');
      push('header', 'Pulling the claims I can stand behind.');
      break;

    case 'extract_done': {
      const primaryBit = event.primaryCount > 0
        ? `, ${event.primaryCount} with primary sources`
        : '';
      push('bullet', `${event.total} findings${primaryBit}.`);
      break;
    }

    case 'chase_start':
      enterPhase('chase');
      push('header', 'Following the citations outward.');
      break;

    case 'chase_done':
      if (event.sharedCitations > 0) {
        push('bullet', `${event.sharedCitations} papers that multiple sources lean on.`);
      } else {
        push('bullet', 'No shared citations worth chasing.');
      }
      break;

    case 'reflect_start':
      enterPhase('reflect');
      push('header', 'Looking for what I missed.');
      break;

    case 'reflect_done':
      if (event.followUps.length === 0) {
        push('bullet', "Nothing obvious left — moving on.");
      } else {
        for (const q of event.followUps) {
          push('bullet', `→  "${q}"`);
        }
      }
      break;

    case 'synthesize_start':
      enterPhase('synthesize');
      push('header', 'Threads converging.');
      break;

    case 'synthesize_done':
      if (event.convergent > 0) push('bullet', `${event.convergent} lines of convergence.`);
      if (event.contradictions > 0) push('bullet', `${event.contradictions} contradictions worth flagging.`);
      if (event.gaps > 0) push('bullet', `${event.gaps} gaps in what the sources will answer.`);
      if (event.convergent === 0 && event.contradictions === 0 && event.gaps === 0) {
        push('bullet', 'Patterns are thin — I have what I have.');
      }
      break;

    case 'frontier_reentry_start':
      enterPhase('frontier');
      push('header', 'Returning for the papers the others leaned on.');
      break;

    case 'frontier_reentry_done':
      push('bullet', `${event.findings} more findings from the frontier.`);
      break;

    case 'save_start':
      enterPhase('save');
      push('header', 'Laying it down.');
      break;

    case 'save_done':
      push('path', event.artifactDir);
      break;

    case 'aborted':
      enterPhase('aborted');
      push('header', '(I stopped here. Nothing saved yet — let me know if you want me to pick it up or start over.)');
      break;

    case 'error':
      push('quiet', `(${event.phase}: ${event.message})`);
      break;

    case 'budget_update':
      setBudget({ spent: event.spent, max: event.max });
      break;
  }
}

function sourceLabel(api: string): string {
  switch (api) {
    case 'wikipedia': return 'Wikipedia';
    case 'arxiv': return 'arXiv';
    case 'semantic_scholar': return 'Semantic Scholar';
    case 'openalex': return 'OpenAlex';
    case 'github': return 'GitHub';
    case 'reddit': return 'Reddit';
    case 'exa': return 'Exa';
    case 'web': return 'web';
    default: return api;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}
