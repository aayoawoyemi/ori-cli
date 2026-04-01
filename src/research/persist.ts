import type { SynthesisReport, Finding } from './types.js';
import type { OriVault } from '../memory/vault.js';

/**
 * Phase 7: Persist findings to vault and generate report.
 */
export async function persistFindings(
  report: SynthesisReport,
  vault: OriVault | null,
): Promise<string> {
  // Save convergent findings to vault (highest value)
  if (vault?.connected) {
    for (const conv of report.convergent.slice(0, 5)) {
      await vault.add(
        conv.claim,
        `Convergent finding from ${conv.confidence} sources. Supported by: ${conv.supportedBy.join(', ')}. Research query: "${report.query}"`,
        'insight',
      ).catch(() => {});
    }

    // Save contradictions as tensions
    for (const contra of report.contradictions.slice(0, 3)) {
      await vault.add(
        `research tension: ${contra.claim.slice(0, 80)}`,
        `Contradiction found during research on "${report.query}". For: ${contra.forSources.join(', ')}. Against: ${contra.againstSources.join(', ')}.`,
        'insight',
      ).catch(() => {});
    }

    // Save the synthesis report itself
    await vault.add(
      `research synthesis: ${report.query.slice(0, 60)}`,
      generateReportBody(report),
      'learning',
    ).catch(() => {});
  }

  // Generate markdown report for stdout
  return generateMarkdownReport(report);
}

function generateReportBody(report: SynthesisReport): string {
  const lines: string[] = [
    `Research on: "${report.query}" (${report.depth} depth)`,
    `${report.sourcesDiscovered} discovered → ${report.sourcesIngested} ingested → ${report.findingsExtracted} findings`,
    `Citation chase depth: ${report.citationsChasedDepth}`,
    '',
    `Convergent (${report.convergent.length}):`,
    ...report.convergent.map(c => `- ${c.claim} (${c.confidence} sources)`),
    '',
    `Contradictions (${report.contradictions.length}):`,
    ...report.contradictions.map(c => `- ${c.claim}`),
    '',
    `Gaps (${report.gaps.length}):`,
    ...report.gaps.map(g => `- ${g.description}`),
  ];
  return lines.join('\n');
}

function generateMarkdownReport(report: SynthesisReport): string {
  const sections: string[] = [];

  sections.push(`# Research: ${report.query}\n`);
  sections.push(`**Depth:** ${report.depth} | **Sources:** ${report.sourcesDiscovered} discovered → ${report.sourcesIngested} ingested | **Findings:** ${report.findingsExtracted} | **Citation depth:** ${report.citationsChasedDepth}\n`);

  // Convergent findings
  if (report.convergent.length > 0) {
    sections.push('## Convergent Findings (high confidence)\n');
    for (const c of report.convergent) {
      sections.push(`- **${c.claim}** — supported by ${c.confidence} independent sources`);
    }
    sections.push('');
  }

  // Contradictions
  if (report.contradictions.length > 0) {
    sections.push('## Contradictions\n');
    for (const c of report.contradictions) {
      sections.push(`- ${c.claim}`);
    }
    sections.push('');
  }

  // Gaps
  if (report.gaps.length > 0) {
    sections.push('## Research Gaps\n');
    for (const g of report.gaps) {
      sections.push(`- ${g.description}`);
    }
    sections.push('');
  }

  // Key findings by type
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

  // Frontier
  if (report.frontier.length > 0) {
    sections.push('## Frontier (next targets)\n');
    for (const f of report.frontier.slice(0, 5)) {
      sections.push(`- ${f}`);
    }
    sections.push('');
  }

  return sections.join('\n');
}
