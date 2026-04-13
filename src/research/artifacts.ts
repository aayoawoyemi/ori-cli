import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ResearchSession, SessionMeta, DiscoveredSource, CitationGraph } from './types.js';

/** Derive a slug from a research query. */
export function slugify(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .replace(/-+$/, '');
}

/** Resolve a unique directory for this session. Appends date on collision. */
function resolveDir(outputDir: string, slug: string): string {
  const base = join(outputDir, slug);
  if (!existsSync(base)) return base;
  const dated = `${slug}-${new Date().toISOString().slice(0, 10)}`;
  const alt = join(outputDir, dated);
  if (!existsSync(alt)) return alt;
  // Last resort: append timestamp
  return join(outputDir, `${slug}-${Date.now()}`);
}

/** Save a complete research session to disk. */
export function saveSession(session: ResearchSession, outputDir: string): string {
  const dir = resolveDir(outputDir, session.meta.slug);
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, 'meta.json'), JSON.stringify(session.meta, null, 2));
  writeFileSync(join(dir, 'report.md'), formatReportMd(session));
  writeFileSync(join(dir, 'sources.json'), JSON.stringify(session.sources, null, 2));
  writeFileSync(join(dir, 'findings.json'), JSON.stringify(session.findings, null, 2));
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(session.graph, null, 2));
  writeFileSync(join(dir, 'frontier.json'), JSON.stringify(session.frontier, null, 2));

  return dir;
}

/** Load seeds from a previous session for --builds-on. */
export function loadSeeds(outputDir: string, slug: string): DiscoveredSource[] {
  const dir = findSessionDir(outputDir, slug);
  if (!dir) return [];

  const seeds: DiscoveredSource[] = [];

  // Load frontier — these are the high-value unread sources
  const frontierPath = join(dir, 'frontier.json');
  if (existsSync(frontierPath)) {
    try {
      const frontier = JSON.parse(readFileSync(frontierPath, 'utf8')) as string[];
      // Frontier items are just IDs — we need to resolve them from sources
      const sourcesPath = join(dir, 'sources.json');
      if (existsSync(sourcesPath)) {
        const sources = JSON.parse(readFileSync(sourcesPath, 'utf8')) as DiscoveredSource[];
        const sourceMap = new Map(sources.map(s => [s.id, s]));
        for (const id of frontier) {
          const source = sourceMap.get(id);
          if (source) seeds.push(source);
        }
      }
    } catch { /* corrupt file, skip */ }
  }

  // Also pull top sources from the previous session (they provide graph context)
  const sourcesPath = join(dir, 'sources.json');
  if (existsSync(sourcesPath) && seeds.length === 0) {
    try {
      const sources = JSON.parse(readFileSync(sourcesPath, 'utf8')) as DiscoveredSource[];
      seeds.push(...sources.slice(0, 10));
    } catch { /* skip */ }
  }

  return seeds;
}

/** List all research sessions in the output directory. */
export function listSessions(outputDir: string): SessionMeta[] {
  if (!existsSync(outputDir)) return [];

  const entries = readdirSync(outputDir, { withFileTypes: true });
  const sessions: SessionMeta[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = join(outputDir, entry.name, 'meta.json');
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as SessionMeta;
        sessions.push(meta);
      } catch { /* skip corrupt */ }
    }
  }

  return sessions.sort((a, b) => b.date.localeCompare(a.date));
}

/** Find a session directory by slug (exact or prefix match). */
function findSessionDir(outputDir: string, slug: string): string | null {
  if (!existsSync(outputDir)) return null;

  // Exact match first
  const exact = join(outputDir, slug);
  if (existsSync(join(exact, 'meta.json'))) return exact;

  // Prefix match (handles date-appended slugs)
  const entries = readdirSync(outputDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(slug)) {
      const metaPath = join(outputDir, entry.name, 'meta.json');
      if (existsSync(metaPath)) return join(outputDir, entry.name);
    }
  }

  return null;
}

/** Format the report.md with frontmatter for Ori indexing. */
function formatReportMd(session: ResearchSession): string {
  const m = session.meta;
  const lines: string[] = [
    '---',
    `description: "Research: ${m.query}"`,
    'type: research',
    `query: "${m.query}"`,
    `depth: ${m.depth}`,
    `date: ${m.date}`,
    `sources_discovered: ${m.sourcesDiscovered}`,
    `sources_ingested: ${m.sourcesIngested}`,
    `findings: ${m.findingsCount}`,
    ...(m.buildsOn ? [`builds_on: ${m.buildsOn}`] : []),
    '---',
    '',
  ];

  // Append the synthesis report markdown
  // (This duplicates the report generation but with frontmatter for vault indexing)
  lines.push(`# Research: ${m.query}\n`);
  lines.push(`**Depth:** ${m.depth} | **Sources:** ${m.sourcesDiscovered} discovered → ${m.sourcesIngested} ingested | **Findings:** ${m.findingsCount}\n`);

  const r = session.report;

  if (r.convergent.length > 0) {
    lines.push('## Convergent Findings\n');
    for (const c of r.convergent) {
      lines.push(`- **${c.claim}** — ${c.confidence} independent sources`);
    }
    lines.push('');
  }

  if (r.contradictions.length > 0) {
    lines.push('## Contradictions\n');
    for (const c of r.contradictions) {
      lines.push(`- ${c.claim}`);
    }
    lines.push('');
  }

  if (r.gaps.length > 0) {
    lines.push('## Research Gaps\n');
    for (const g of r.gaps) {
      lines.push(`- ${g.description}`);
    }
    lines.push('');
  }

  lines.push('## Key Findings\n');
  const byType = new Map<string, typeof session.findings>();
  for (const f of session.findings) {
    if (!byType.has(f.type)) byType.set(f.type, []);
    byType.get(f.type)!.push(f);
  }
  for (const [type, findings] of byType) {
    lines.push(`### ${type.charAt(0).toUpperCase() + type.slice(1)}s\n`);
    for (const f of findings.slice(0, 10)) {
      lines.push(`- **${f.claim}** [${f.confidence}]`);
      lines.push(`  Source: ${f.provenance.sourceTitle} (${f.provenance.url})`);
    }
    lines.push('');
  }

  if (session.frontier.length > 0) {
    lines.push('## Frontier (next targets)\n');
    const sourceMap = new Map(session.sources.map(s => [s.id, s]));
    for (const id of session.frontier.slice(0, 10)) {
      const s = sourceMap.get(id);
      lines.push(s ? `- ${s.title} (${s.url})` : `- ${id}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
