import chalk from 'chalk';
import type { ModelRouter } from '../router/index.js';
import { plan } from './plan.js';
import { discover } from './discover.js';
import { ingestSources } from './ingest.js';
import { extractFindings } from './extract.js';
import { readSources, readSource } from './read.js';
import { chaseCitations } from './chase.js';
import { reflect, reflectLegacy } from './reflect.js';
import { synthesize } from './synthesize.js';
import { generateReport } from './persist.js';
import { saveSession, loadSeeds, slugify } from './artifacts.js';
import { Budget, DEPTH_BUDGETS } from './budget.js';
import { orchestrateDeepResearch } from './orchestrator.js';
import type {
  ResearchDepth, ResearchOptions, ResearchResult, ResearchSession, ResearchEvent,
  ResearchPlan, Finding, DiscoveredSource, IngestedSource, CitationNode,
  NextAction, ReadResult,
} from './types.js';
import { DEPTH_CONFIGS } from './types.js';

// Stage functions — re-exported for direct use by bridge.ts + REPL callers
export { discover } from './discover.js';
export { ingestSources } from './ingest.js';
export { extractFindings, extractFromSource } from './extract.js';
export { readSource, readSources } from './read.js';
export { synthesize } from './synthesize.js';
export { fetchUrl } from './fetchUrl.js';
export { saveSession, loadSession, loadSeeds, listSessions, slugify } from './artifacts.js';
export type { ResearchResult, ResearchOptions, SessionMeta } from './types.js';
export type { DiscoveredSource, IngestedSource, Finding, SynthesisReport, ResearchSession, ResearchDepth } from './types.js';

/**
 * /research command — the recursive research engine.
 *
 * V3.1 pipeline:
 *   plan → discover → ingest → read → reflect ──→ synthesize → artifacts
 *              ↑                          │
 *              └──────────────────────────┘
 *                 (recursive: search_more / chase / deep_dive)
 *
 * Collaborative mode: checkpoints after each read cycle where the user
 * can steer the research direction.
 */
export async function runResearch(
  query: string,
  depth: ResearchDepth,
  router: ModelRouter,
  options: ResearchOptions,
): Promise<ResearchResult> {
  const config = { depth, ...DEPTH_CONFIGS[depth] };
  const slug = slugify(query);
  const mode = options.mode ?? 'autonomous';

  // Route deep/exhaustive depth to the multi-agent orchestrator
  // (unless in collaborative mode where user wants to steer each step)
  if ((depth === 'deep' || depth === 'exhaustive') && mode !== 'collaborative') {
    return orchestrateDeepResearch(query, depth, router, options);
  }

  const budget = new Budget(DEPTH_BUDGETS[depth]);

  // Event emitter — silently no-ops if caller didn't pass onEvent.
  const emit = (e: ResearchEvent): void => {
    try { options.onEvent?.(e); } catch { /* never break the pipeline on UI errors */ }
  };
  const checkAborted = (): boolean => {
    if (options.signal?.aborted) {
      emit({ type: 'aborted' });
      return true;
    }
    return false;
  };
  const logToConsole = !options.onEvent;

  if (logToConsole) {
    console.log(chalk.bold(`\nResearch: "${query}"`));
    console.log(chalk.dim(`Depth: ${depth} | Mode: ${mode} | Max sources: ${config.maxSources} | Chase: ${config.chaseDepth} hops | Budget: ${DEPTH_BUDGETS[depth].toLocaleString()} tokens`));
    if (options.buildsOn) {
      console.log(chalk.dim(`Building on: ${options.buildsOn}`));
    }
    console.log('');
  }

  emit({
    type: 'run_start',
    query, depth,
    budget: DEPTH_BUDGETS[depth],
    apis: ['arxiv', 'semantic_scholar', 'openalex', 'github', 'wikipedia', 'reddit', 'exa'],
  });

  // Load seeds from previous session if --builds-on
  let seeds: DiscoveredSource[] | undefined;
  if (options.buildsOn) {
    seeds = loadSeeds(options.outputDir, options.buildsOn);
    if (logToConsole) {
      if (seeds.length > 0) {
        console.log(chalk.dim(`[seeds] Loaded ${seeds.length} sources from "${options.buildsOn}"`));
      } else {
        console.log(chalk.dim(`[seeds] No previous session found for "${options.buildsOn}"`));
      }
    }
  }

  // ── Phase 0: PLAN ─────────────────────────────────────────────────────
  let researchPlan: ResearchPlan;
  emit({ type: 'plan_start', query });
  if (logToConsole) console.log(chalk.dim(`[plan] Generating research plan...`));
  researchPlan = await plan(query, router, budget, undefined, emit);
  emit({ type: 'plan_done', plan: researchPlan });
  emit({ type: 'budget_update', spent: budget.spent, max: budget.max });
  if (logToConsole) {
    console.log(chalk.dim(`[plan] ${researchPlan.queries.length} sub-queries, ${researchPlan.activeApis.length} active APIs`));
    for (const sq of researchPlan.queries) {
      console.log(chalk.dim(`  → "${sq.query}" → [${sq.targetApis.join(', ')}] (${sq.priority})`));
    }
  }

  let allFindings: Finding[] = [];
  let allSources: DiscoveredSource[] = [];
  let allIngested: IngestedSource[] = [];
  let totalDiscovered = 0;
  let citationGraph = { nodes: [] as Array<CitationNode & { id: string }>, edges: [] as Array<{ from: string; to: string; context?: string }> };
  let snowballSeeds: DiscoveredSource[] = [];

  // ── V3.1 Recursive Loop ────────────────────────────────────────────────
  // For V3.1 (mode = autonomous | collaborative), we use the read→reflect→action loop.
  // For backward compat, the old linear pipeline is still available via the extract path.

  if (mode === 'collaborative' || mode === 'autonomous') {
    // Recursive deep research loop
    let currentAction: NextAction = { type: 'search_more', queries: [query] };
    let iteration = 0;
    const maxIterations = config.reflectionLoops * 3 + 2; // safety cap

    while (iteration < maxIterations) {
      if (checkAborted()) break;
      if (budget.exhausted) break;
      iteration++;

      if (logToConsole) {
        console.log(chalk.cyan(`\n── Iteration ${iteration}: action=${currentAction.type} ──\n`));
      }

      switch (currentAction.type) {
        case 'search_more': {
          // DISCOVER + INGEST + READ cycle
          const searchQuery = currentAction.queries[0] ?? query;
          const isFirstDiscovery = iteration <= 1;
          emit({ type: 'discover_start', loop: iteration });
          if (logToConsole) console.log(chalk.dim(`[discover] Searching for "${searchQuery}"...`));

          const loopSeeds = isFirstDiscovery ? seeds : (snowballSeeds.length > 0 ? snowballSeeds : undefined);
          const discoverInput = isFirstDiscovery && researchPlan ? researchPlan : searchQuery;
          const discovered = await discover(
            discoverInput,
            isFirstDiscovery ? config.maxSources : 10,
            loopSeeds,
            { paginationEnabled: config.paginationEnabled && isFirstDiscovery, budget, onError: (msg) => emit({ type: 'error', phase: 'discover', message: msg }) },
          );
          emit({ type: 'budget_update', spent: budget.spent, max: budget.max });

          const newSources = discovered.filter(s => !allSources.some(es => es.id === s.id));
          allSources.push(...newSources);
          totalDiscovered += newSources.length;

          if (newSources.length === 0) {
            if (logToConsole) console.log(chalk.dim(`[discover] No new sources`));
            currentAction = { type: 'done', reason: 'No more sources to discover' };
            continue;
          }

          // INGEST
          emit({ type: 'ingest_start', count: newSources.length });
          const ingested = await ingestSources(newSources, options.fetchFn, searchQuery, emit, researchPlan?.relevanceCriteria);
          allIngested.push(...ingested);
          emit({ type: 'ingest_done', ingested: ingested.length, dropped: newSources.length - ingested.length, skim: ingested.filter(s => s.quality?.skim).length });
          emit({ type: 'budget_update', spent: budget.spent, max: budget.max });

          if (ingested.length === 0) {
            currentAction = { type: 'done', reason: 'All sources dropped during ingest' };
            continue;
          }

          // READ (V3.1 replaces extract)
          emit({ type: 'extract_start' });
          if (logToConsole) console.log(chalk.dim(`[read] Deep-reading ${ingested.length} sources...`));
          const readResult = await readSources(ingested, router, researchPlan, budget, allFindings, emit);
          allFindings.push(...readResult.findings);
          emit({ type: 'extract_done', total: readResult.findings.length, primaryCount: readResult.findings.filter(f => f.confidence === 'primary').length });
          emit({ type: 'budget_update', spent: budget.spent, max: budget.max });

          // CHASE CITATIONS (if configured)
          if (config.chaseDepth > 0) {
            emit({ type: 'chase_start' });
            const { graph, sharedCitations } = await chaseCitations(ingested, config.chaseDepth, budget, emit);
            emit({ type: 'budget_update', spent: budget.spent, max: budget.max });
            for (const [id, node] of graph.nodes) {
              citationGraph.nodes.push({ ...node, id });
            }
            citationGraph.edges.push(...graph.edges);
            snowballSeeds = sharedCitations.slice(0, 10);
            emit({ type: 'chase_done', sharedCitations: sharedCitations.length });
          }

          // REFLECT (decides next action)
          emit({ type: 'reflect_start' });
          const nextAction = await reflect(query, allFindings, router, budget, emit, researchPlan, readResult);
          emit({ type: 'reflect_done', followUps: nextAction.type === 'search_more' ? nextAction.queries : [] });
          emit({ type: 'budget_update', spent: budget.spent, max: budget.max });

          // COLLABORATIVE CHECKPOINT
          if (mode === 'collaborative' && options.onCheckpoint) {
            const deeperTargets = readResult.deeperTargets;
            const gaps = nextAction.type === 'search_more' ? nextAction.queries : [];
            emit({ type: 'checkpoint', findings: allFindings, deeperTargets, gaps });
            // Pause for user input
            currentAction = await options.onCheckpoint({ findings: allFindings, deeperTargets, gaps });
          } else {
            currentAction = nextAction;
          }

          break;
        }

        case 'chase_citations': {
          // Follow specific citation targets
          if (currentAction.targets.length === 0) {
            currentAction = { type: 'done', reason: 'No targets to chase' };
            continue;
          }
          if (logToConsole) console.log(chalk.dim(`[chase] Following ${currentAction.targets.length} citation targets...`));
          // Convert target IDs to DiscoveredSource format for ingest
          const chaseSources: DiscoveredSource[] = currentAction.targets.slice(0, 5).map(id => ({
            id,
            title: id, // Will be updated by ingest
            authors: [],
            date: 'unknown',
            url: id.startsWith('s2:') ? `https://www.semanticscholar.org/paper/${id.replace('s2:', '')}` : id,
            sourceApi: 'semantic_scholar' as const,
            type: 'paper' as const,
          }));
          emit({ type: 'ingest_start', count: chaseSources.length });
          const ingested = await ingestSources(chaseSources, options.fetchFn, query, emit, researchPlan?.relevanceCriteria);
          allIngested.push(...ingested);
          emit({ type: 'budget_update', spent: budget.spent, max: budget.max });

          if (ingested.length > 0) {
            emit({ type: 'extract_start' });
            const readResult = await readSources(ingested, router, researchPlan, budget, allFindings, emit);
            allFindings.push(...readResult.findings);
            emit({ type: 'extract_done', total: readResult.findings.length, primaryCount: readResult.findings.filter(f => f.confidence === 'primary').length });
            emit({ type: 'budget_update', spent: budget.spent, max: budget.max });
          }

          // Reflect again
          emit({ type: 'reflect_start' });
          currentAction = await reflect(query, allFindings, router, budget, emit, researchPlan);
          emit({ type: 'budget_update', spent: budget.spent, max: budget.max });

          if (mode === 'collaborative' && options.onCheckpoint) {
            emit({ type: 'checkpoint', findings: allFindings, deeperTargets: [], gaps: [] });
            currentAction = await options.onCheckpoint({ findings: allFindings, deeperTargets: [], gaps: [] });
          }
          break;
        }

        case 'deep_dive': {
          // Re-read one source with a focused question
          const ddAction = currentAction as { type: 'deep_dive'; sourceId: string; focus: string };
          const targetSource = allIngested.find(s => s.id === ddAction.sourceId);
          if (!targetSource) {
            if (logToConsole) console.log(chalk.dim(`[deep_dive] Source not found: ${ddAction.sourceId}`));
            currentAction = { type: 'done', reason: 'Deep dive target not found' };
            continue;
          }
          if (logToConsole) console.log(chalk.dim(`[deep_dive] Re-reading "${targetSource.title}" with focus: ${ddAction.focus}`));
          emit({ type: 'extract_start' });
          const diveResult = await readSource(targetSource, router, researchPlan, budget, allFindings, emit);
          allFindings.push(...diveResult.findings);
          emit({ type: 'extract_done', total: diveResult.findings.length, primaryCount: diveResult.findings.filter(f => f.confidence === 'primary').length });
          emit({ type: 'budget_update', spent: budget.spent, max: budget.max });

          // Reflect again
          emit({ type: 'reflect_start' });
          currentAction = await reflect(query, allFindings, router, budget, emit, researchPlan, diveResult);
          emit({ type: 'budget_update', spent: budget.spent, max: budget.max });

          if (mode === 'collaborative' && options.onCheckpoint) {
            emit({ type: 'checkpoint', findings: allFindings, deeperTargets: diveResult.deeperTargets, gaps: [] });
            currentAction = await options.onCheckpoint({ findings: allFindings, deeperTargets: diveResult.deeperTargets, gaps: [] });
          }
          break;
        }

        case 'done': {
          if (logToConsole) console.log(chalk.dim(`[done] ${currentAction.reason}`));
          // Exit the loop
          iteration = maxIterations;
          break;
        }
      }
    }
  } else {
    // ── Legacy V2 pipeline (backward compat) ──────────────────────────────
    const queries = [query];
    for (let loop = 0; loop <= config.reflectionLoops; loop++) {
      if (checkAborted()) break;
      const currentQuery = queries[loop] ?? query;
      const isFollowUp = loop > 0;

      if (isFollowUp && logToConsole) {
        console.log(chalk.cyan(`\n── Reflection loop ${loop}: "${currentQuery}"\n`));
      }

      emit({ type: 'discover_start', loop });
      if (logToConsole) console.log(chalk.dim(`[discover] Searching...`));
      const loopSeeds = !isFollowUp ? seeds : (snowballSeeds.length > 0 ? snowballSeeds : undefined);
      const discoverInput = (!isFollowUp && researchPlan) ? researchPlan : currentQuery;
      const discovered = await discover(
        discoverInput,
        isFollowUp ? 10 : config.maxSources,
        loopSeeds,
        { paginationEnabled: config.paginationEnabled && !isFollowUp, budget, onError: (msg) => emit({ type: 'error', phase: 'discover', message: msg }) },
      );
      emit({ type: 'budget_update', spent: budget.spent, max: budget.max });

      const newSources = discovered.filter(s => !allSources.some(es => es.id === s.id));
      allSources.push(...newSources);
      totalDiscovered += newSources.length;
      const byApi: Record<string, number> = {};
      for (const s of newSources) byApi[s.sourceApi] = (byApi[s.sourceApi] || 0) + 1;
      emit({ type: 'discover_done', loop, surfaced: newSources.length, byApi });

      if (newSources.length === 0) {
        if (loop < config.reflectionLoops) {
          emit({ type: 'reflect_start' });
          const followUps = await reflectLegacy(query, allFindings, router, budget, emit);
          emit({ type: 'reflect_done', followUps });
          emit({ type: 'budget_update', spent: budget.spent, max: budget.max });
          if (followUps.length > 0) queries.push(...followUps);
          else break;
        }
        continue;
      }

      emit({ type: 'ingest_start', count: newSources.length });
      if (logToConsole) console.log(chalk.dim(`[ingest] Deep-reading ${newSources.length} sources...`));
      const ingested = await ingestSources(newSources, options.fetchFn, currentQuery, emit, researchPlan?.relevanceCriteria);
      const dropped = newSources.length - ingested.length;
      const skimCount = ingested.filter(s => s.quality?.skim).length;
      allIngested.push(...ingested);
      emit({ type: 'ingest_done', ingested: ingested.length, dropped, skim: skimCount });
      emit({ type: 'budget_update', spent: budget.spent, max: budget.max });

      if (ingested.length === 0) continue;

      emit({ type: 'extract_start' });
      if (logToConsole) console.log(chalk.dim(`[extract] Extracting findings...`));
      const findings = await extractFindings(ingested, router, budget, emit);
      allFindings.push(...findings);
      emit({ type: 'extract_done', total: findings.length, primaryCount: findings.filter(f => f.confidence === 'primary').length });
      emit({ type: 'budget_update', spent: budget.spent, max: budget.max });

      if (config.chaseDepth > 0) {
        emit({ type: 'chase_start' });
        const { graph, sharedCitations } = await chaseCitations(ingested, config.chaseDepth, budget, emit);
        emit({ type: 'budget_update', spent: budget.spent, max: budget.max });
        for (const [id, node] of graph.nodes) citationGraph.nodes.push({ ...node, id });
        citationGraph.edges.push(...graph.edges);
        snowballSeeds = sharedCitations.slice(0, 10);
        emit({ type: 'chase_done', sharedCitations: sharedCitations.length });
      }

      if (checkAborted()) break;

      if (loop < config.reflectionLoops) {
        emit({ type: 'reflect_start' });
        const followUps = await reflectLegacy(query, allFindings, router, budget, emit);
        emit({ type: 'reflect_done', followUps });
        emit({ type: 'budget_update', spent: budget.spent, max: budget.max });
        if (followUps.length > 0) queries.push(...followUps);
        else break;
      }
    }
  }

  // ── Phase 6: SYNTHESIZE ──────────────────────────────────────────────
  emit({ type: 'synthesize_start' });
  if (logToConsole) console.log(chalk.dim(`\n[synthesize] Cross-source analysis on ${allFindings.length} findings...`));
  let report = await synthesize(
    query, allFindings, depth, totalDiscovered,
    allIngested.length, config.chaseDepth, router, budget, emit,
  );
  emit({
    type: 'synthesize_done',
    convergent: report.convergent.length,
    contradictions: report.contradictions.length,
    gaps: report.gaps.length,
  });
  emit({ type: 'budget_update', spent: budget.spent, max: budget.max });
  if (logToConsole) console.log(chalk.dim(`[synthesize] ${report.convergent.length} convergent, ${report.contradictions.length} contradictions, ${report.gaps.length} gaps`));

  // Build frontier
  const ingestedIds = new Set(allIngested.map(s => s.id));
  const frontierNodes = citationGraph.nodes
    .filter(n => !ingestedIds.has(n.id) && n.inDegree >= 2)
    .sort((a, b) => b.inDegree - a.inDegree);
  const frontier = frontierNodes.map(n => n.id).slice(0, 20);

  // Frontier re-entry
  if (config.frontierReEntry && budget.remaining() > budget.max * 0.2 && frontierNodes.length > 0 && !options.signal?.aborted) {
    const reentryTargets: DiscoveredSource[] = frontierNodes.slice(0, 10).map(n => ({
      id: n.id,
      title: n.title,
      authors: [],
      date: 'unknown',
      url: n.id.startsWith('s2:') ? `https://www.semanticscholar.org/paper/${n.id.replace('s2:', '')}` : n.id,
      sourceApi: 'semantic_scholar' as const,
      citationCount: n.citationCount,
      type: 'paper' as const,
    }));
    emit({ type: 'frontier_reentry_start', count: reentryTargets.length });
    if (logToConsole) console.log(chalk.dim(`[frontier] Re-entering top ${reentryTargets.length} frontier papers...`));
    const frontierIngested = await ingestSources(reentryTargets, options.fetchFn, query, emit, researchPlan?.relevanceCriteria);
    allIngested.push(...frontierIngested);
    const frontierFindings = await extractFindings(frontierIngested, router, budget, emit);
    allFindings.push(...frontierFindings);
    emit({ type: 'frontier_reentry_done', findings: frontierFindings.length });
    emit({ type: 'budget_update', spent: budget.spent, max: budget.max });
    report = await synthesize(
      query, allFindings, depth, totalDiscovered,
      allIngested.length, config.chaseDepth, router, budget, emit,
    );
    emit({ type: 'budget_update', spent: budget.spent, max: budget.max });
  }

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
      budget: budget.toJSON(),
    },
    report,
    sources: allSources,
    findings: allFindings,
    graph: citationGraph,
    frontier,
    reflectionQueries: [],
  };

  emit({ type: 'save_start' });
  if (logToConsole) console.log(chalk.dim(`[save] Writing artifacts...`));
  const artifactDir = saveSession(session, options.outputDir);
  emit({ type: 'save_done', artifactDir, slug });
  if (logToConsole) console.log(chalk.dim(`[save] Saved to ${artifactDir}\n`));

  const markdownReport = generateReport(report);

  return {
    report: markdownReport,
    session,
    slug,
    artifactDir,
  };
}
