import chalk from 'chalk';
import type { ModelRouter } from '../router/index.js';
import type { OriVault } from '../memory/vault.js';
import { discover } from './discover.js';
import { ingestSources } from './ingest.js';
import { extractFindings } from './extract.js';
import { chaseCitations } from './chase.js';
import { reflect } from './reflect.js';
import { synthesize } from './synthesize.js';
import { persistFindings } from './persist.js';
import type { ResearchDepth, Finding, DiscoveredSource, IngestedSource } from './types.js';
import { DEPTH_CONFIGS } from './types.js';

/**
 * /research command — the 7-phase recursive research engine.
 *
 * Discovers sources across structured APIs (Arxiv, Semantic Scholar,
 * OpenAlex, GitHub), deep-reads them, chases citation graphs,
 * reflects on gaps, synthesizes cross-source patterns, and persists
 * findings to the vault with full provenance.
 */
export async function runResearch(
  query: string,
  depth: ResearchDepth,
  router: ModelRouter,
  vault: OriVault | null,
  fetchFn: (url: string) => Promise<string>,
): Promise<string> {
  const config = { depth, ...DEPTH_CONFIGS[depth] };

  console.log(chalk.bold(`\nResearch: "${query}"`));
  console.log(chalk.dim(`Depth: ${depth} | Max sources: ${config.maxSources} | Chase: ${config.chaseDepth} hops | Reflection: ${config.reflectionLoops} loops\n`));

  let allFindings: Finding[] = [];
  let allSources: DiscoveredSource[] = [];
  let allIngested: IngestedSource[] = [];
  let totalDiscovered = 0;

  // Track queries across reflection loops
  const queries = [query];

  for (let loop = 0; loop <= config.reflectionLoops; loop++) {
    const currentQuery = queries[loop] ?? query;
    const isFollowUp = loop > 0;

    if (isFollowUp) {
      console.log(chalk.cyan(`\n── Reflection loop ${loop}: "${currentQuery}"\n`));
    }

    // ── Phase 1: DISCOVER ──────────────────────────────────────────────
    console.log(chalk.dim(`[discover] Searching across Arxiv, Semantic Scholar, OpenAlex, GitHub...`));
    const discovered = await discover(currentQuery, isFollowUp ? 10 : config.maxSources);
    totalDiscovered += discovered.length;
    allSources.push(...discovered);
    console.log(chalk.dim(`[discover] Found ${discovered.length} sources`));

    // ── Phase 2: INGEST ────────────────────────────────────────────────
    const toIngest = discovered.slice(0, isFollowUp ? 5 : 15);
    console.log(chalk.dim(`[ingest] Deep-reading ${toIngest.length} sources...`));
    const ingested = await ingestSources(toIngest, fetchFn);
    allIngested.push(...ingested);
    console.log(chalk.dim(`[ingest] Ingested ${ingested.length} sources`));

    // ── Phase 3: EXTRACT ───────────────────────────────────────────────
    console.log(chalk.dim(`[extract] Extracting findings with provenance...`));
    const findings = await extractFindings(ingested, router);
    allFindings.push(...findings);
    console.log(chalk.dim(`[extract] ${findings.length} findings extracted (${allFindings.length} total)`));

    // ── Phase 4: CHASE ─────────────────────────────────────────────────
    if (config.chaseDepth > 0 && !isFollowUp) {
      console.log(chalk.dim(`[chase] Traversing citation graph (depth ${config.chaseDepth})...`));
      const { sharedCitations } = await chaseCitations(discovered, config.chaseDepth);
      console.log(chalk.dim(`[chase] Found ${sharedCitations.length} shared citations (convergent)`));

      // Ingest shared citations (high signal)
      if (sharedCitations.length > 0) {
        const chaseIngested = await ingestSources(sharedCitations.slice(0, 5), fetchFn);
        const chaseFindings = await extractFindings(chaseIngested, router);
        allIngested.push(...chaseIngested);
        allFindings.push(...chaseFindings);
        console.log(chalk.dim(`[chase] ${chaseFindings.length} additional findings from shared citations`));
      }
    }

    // ── Phase 5: REFLECT ───────────────────────────────────────────────
    if (loop < config.reflectionLoops) {
      console.log(chalk.dim(`[reflect] Analyzing gaps, generating follow-up queries...`));
      const followUps = await reflect(query, allFindings, router);
      if (followUps.length > 0) {
        queries.push(...followUps);
        console.log(chalk.dim(`[reflect] Generated ${followUps.length} follow-up queries:`));
        for (const fq of followUps) {
          console.log(chalk.dim(`  → "${fq}"`));
        }
      } else {
        console.log(chalk.dim(`[reflect] No gaps found — research is comprehensive`));
        break;
      }
    }
  }

  // ── Phase 6: SYNTHESIZE ──────────────────────────────────────────────
  console.log(chalk.dim(`\n[synthesize] Cross-source analysis on ${allFindings.length} findings...`));
  const report = await synthesize(
    query,
    allFindings,
    depth,
    totalDiscovered,
    allIngested.length,
    config.chaseDepth,
    router,
  );
  console.log(chalk.dim(`[synthesize] ${report.convergent.length} convergent, ${report.contradictions.length} contradictions, ${report.gaps.length} gaps`));

  // ── Phase 7: PERSIST ─────────────────────────────────────────────────
  console.log(chalk.dim(`[persist] Saving findings to vault...`));
  const markdownReport = await persistFindings(report, vault);
  const savedCount = report.convergent.length + report.contradictions.length + 1; // +1 for synthesis
  console.log(chalk.dim(`[persist] ${savedCount} notes saved to vault\n`));

  return markdownReport;
}
