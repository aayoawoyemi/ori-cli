import chalk from 'chalk';
import type { ModelRouter } from '../router/index.js';
import { discover } from './discover.js';
import { ingestSources } from './ingest.js';
import { extractFindings } from './extract.js';
import { chaseCitations } from './chase.js';
import { reflect } from './reflect.js';
import { synthesize } from './synthesize.js';
import { generateReport } from './persist.js';
import { saveSession, loadSeeds, slugify } from './artifacts.js';
import type {
  ResearchDepth, ResearchOptions, ResearchResult, ResearchSession,
  Finding, DiscoveredSource, IngestedSource, CitationNode,
} from './types.js';
import { DEPTH_CONFIGS } from './types.js';

export { listSessions } from './artifacts.js';
export type { ResearchResult, ResearchOptions, SessionMeta } from './types.js';

/**
 * /research command — the 7-phase recursive research engine.
 *
 * Discovers sources across structured APIs (Arxiv, Semantic Scholar,
 * OpenAlex, GitHub, Exa, Reddit), deep-reads them, chases citation graphs,
 * reflects on gaps, synthesizes cross-source patterns, and saves
 * durable artifacts to disk.
 */
export async function runResearch(
  query: string,
  depth: ResearchDepth,
  router: ModelRouter,
  options: ResearchOptions,
): Promise<ResearchResult> {
  const config = { depth, ...DEPTH_CONFIGS[depth] };
  const slug = slugify(query);

  console.log(chalk.bold(`\nResearch: "${query}"`));
  console.log(chalk.dim(`Depth: ${depth} | Max sources: ${config.maxSources} | Chase: ${config.chaseDepth} hops | Reflection: ${config.reflectionLoops} loops`));
  if (options.buildsOn) {
    console.log(chalk.dim(`Building on: ${options.buildsOn}`));
  }
  console.log('');

  // Load seeds from previous session if --builds-on
  let seeds: DiscoveredSource[] | undefined;
  if (options.buildsOn) {
    seeds = loadSeeds(options.outputDir, options.buildsOn);
    if (seeds.length > 0) {
      console.log(chalk.dim(`[seeds] Loaded ${seeds.length} sources from "${options.buildsOn}"`));
    } else {
      console.log(chalk.dim(`[seeds] No previous session found for "${options.buildsOn}"`));
    }
  }

  let allFindings: Finding[] = [];
  let allSources: DiscoveredSource[] = [];
  let allIngested: IngestedSource[] = [];
  let totalDiscovered = 0;
  let citationGraph = { nodes: [] as Array<CitationNode & { id: string }>, edges: [] as Array<{ from: string; to: string; context?: string }> };

  const queries = [query];

  for (let loop = 0; loop <= config.reflectionLoops; loop++) {
    const currentQuery = queries[loop] ?? query;
    const isFollowUp = loop > 0;

    if (isFollowUp) {
      console.log(chalk.cyan(`\n── Reflection loop ${loop}: "${currentQuery}"\n`));
    }

    // ── Phase 1: DISCOVER ──────────────────────────────────────────────
    console.log(chalk.dim(`[discover] Searching across Arxiv, Semantic Scholar, OpenAlex, GitHub, Exa, Reddit...`));
    const discovered = await discover(
      currentQuery,
      isFollowUp ? 10 : config.maxSources,
      !isFollowUp ? seeds : undefined,
    );
    totalDiscovered += discovered.length;
    allSources.push(...discovered);
    console.log(chalk.dim(`[discover] Found ${discovered.length} sources`));

    // ── Phase 2: INGEST ────────────────────────────────────────────────
    const toIngest = discovered.slice(0, isFollowUp ? 5 : 15);
    console.log(chalk.dim(`[ingest] Deep-reading ${toIngest.length} sources...`));
    const ingested = await ingestSources(toIngest, options.fetchFn);
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
      const { graph, sharedCitations } = await chaseCitations(discovered, config.chaseDepth);
      console.log(chalk.dim(`[chase] Found ${sharedCitations.length} shared citations (convergent)`));

      // Preserve the citation graph
      citationGraph = {
        nodes: Array.from(graph.nodes.entries()).map(([id, node]) => ({ ...node, id })),
        edges: graph.edges,
      };

      if (sharedCitations.length > 0) {
        const chaseIngested = await ingestSources(sharedCitations.slice(0, 5), options.fetchFn);
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
    query, allFindings, depth, totalDiscovered,
    allIngested.length, config.chaseDepth, router,
  );
  console.log(chalk.dim(`[synthesize] ${report.convergent.length} convergent, ${report.contradictions.length} contradictions, ${report.gaps.length} gaps`));

  // Build frontier — sources in the citation graph that we didn't ingest
  const ingestedIds = new Set(allIngested.map(s => s.id));
  const frontier = citationGraph.nodes
    .filter(n => !ingestedIds.has(n.id) && n.inDegree >= 2)
    .sort((a, b) => b.inDegree - a.inDegree)
    .map(n => n.id)
    .slice(0, 20);

  // ── Phase 7: SAVE ARTIFACTS ──────────────────────────────────────────
  const session: ResearchSession = {
    meta: {
      slug,
      query,
      depth,
      date: new Date().toISOString(),
      sourcesDiscovered: totalDiscovered,
      sourcesIngested: allIngested.length,
      findingsCount: allFindings.length,
      convergentCount: report.convergent.length,
      contradictionCount: report.contradictions.length,
      gapCount: report.gaps.length,
      buildsOn: options.buildsOn,
    },
    report,
    sources: allSources,
    findings: allFindings,
    graph: citationGraph,
    frontier,
    reflectionQueries: queries.slice(1), // skip the original query
  };

  console.log(chalk.dim(`[save] Writing artifacts...`));
  const artifactDir = saveSession(session, options.outputDir);
  console.log(chalk.dim(`[save] Saved to ${artifactDir}\n`));

  const markdownReport = generateReport(report);

  return {
    report: markdownReport,
    session,
    slug,
    artifactDir,
  };
}
