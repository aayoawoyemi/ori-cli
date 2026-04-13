import type { SynthesisReport, Finding } from './types.js';

/**
 * Phase 7: Generate the markdown report for display.
 * No vault writes — the artifact folder handles persistence.
 */
export function generateReport(report: SynthesisReport): string {
  const sections: string[] = [];

  sections.push(`# Research: ${report.query}\n`);
  sections.push(`**Depth:** ${report.depth} | **Sources:** ${report.sourcesDiscovered} discovered → ${report.sourcesIngested} ingested | **Findings:** ${report.findingsExtracted} | **Citation depth:** ${report.citationsChasedDepth}\n`);

  if (report.convergent.length > 0) {
    sections.push('## Convergent Findings (high confidence)\n');
    for (const c of report.convergent) {
      sections.push(`- **${c.claim}** — supported by ${c.confidence} independent sources`);
    }
    sections.push('');
  }

  if (report.contradictions.length > 0) {
    sections.push('## Contradictions\n');
    for (const c of report.contradictions) {
      sections.push(`- ${c.claim}`);
    }
    sections.push('');
  }

  if (report.gaps.length > 0) {
    sections.push('## Research Gaps\n');
    for (const g of report.gaps) {
      sections.push(`- ${g.description}`);
    }
    sections.push('');
  }

  sections.push('## Key Findings\n');
  const byType = new Map<string, Finding[]>();
  for (const f of report.findings) {
    if (!byType.has(f.type)) byType.set(f.type, []);
    byType.get(f.type)!.push(f);
  }
  for (const [type, findings] of byType) {
    sections.push(`### ${type.charAt(0).toUpperCase() + type.slice(1)}s\n`);
    for (const f of findings.slice(0, 10)) {
      sections.push(`- **${f.claim}** [${f.confidence}]`);
      sections.push(`  Source: ${f.provenance.sourceTitle} (${f.provenance.url})`);
    }
    sections.push('');
  }

  if (report.frontier.length > 0) {
    sections.push('## Frontier (next targets)\n');
    for (const f of report.frontier.slice(0, 5)) {
      sections.push(`- ${f}`);
    }
    sections.push('');
  }

  return sections.join('\n');
}
