import type { ModelRouter } from '../router/index.js';
import type {
  ResearchDepth, ResearchOptions, ResearchResult, ResearchPlan,
  Finding, DiscoveredSource, SynthesisReport,
} from './types.js';
import { runResearch } from './index.js';
import { Budget, DEPTH_BUDGETS } from './budget.js';
import { synthesize } from './synthesize.js';

/**
 * Phase D: Multi-Agent Deep Research Orchestrator.
 *
 * For deep/exhaustive depth, the planner identifies independent sub-questions
 * and spawns a `runResearch()` per sub-question with:
 *   - Scoped research plan (limited to the sub-question)
 *   - Budget slice (proportional to priority)
 *   - Independent session
 *
 * The orchestrator collects findings from all sub-agents and runs
 * cross-agent synthesis on the combined set.
 */

interface SubAgentTask {
  subQuestion: string;
  plan: ResearchPlan;
  budget: number;
  priority: 'essential' | 'supplementary' | 'exploratory';
}

export async function orchestrateDeepResearch(
  query: string,
  depth: ResearchDepth,
  router: ModelRouter,
  options: ResearchOptions,
): Promise<ResearchResult> {
  const totalBudget = DEPTH_BUDGETS[depth];
  const masterBudget = new Budget(totalBudget);

  // Generate the master plan using the router
  const { plan: generatePlan } = await import('./plan.js');
  const masterPlan = await generatePlan(query, router, masterBudget, undefined, options.onEvent);

  // Decompose into sub-agent tasks from the plan's sub-queries
  const tasks = decomposePlan(masterPlan, totalBudget);

  if (tasks.length <= 1) {
    // Single sub-question — just run normal research
    return runResearch(query, depth, router, options);
  }

  // Run sub-agents in parallel (max 3 concurrent to avoid API rate limits)
  const subResults: ResearchResult[] = [];
  const batchSize = 3;

  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(task => runSubAgent(task, depth, router, options)),
    );
    subResults.push(...results.filter((r): r is ResearchResult => r !== null));
  }

  // Merge findings from all sub-agents
  const allFindings: Finding[] = [];
  const allSources: DiscoveredSource[] = [];
  let totalDiscovered = 0;
  let totalIngested = 0;

  for (const result of subResults) {
    allFindings.push(...result.session.findings);
    allSources.push(...result.session.sources);
    totalDiscovered += result.session.meta.sourcesDiscovered;
    totalIngested += result.session.meta.sourcesIngested;
  }

  // Cross-agent synthesis
  const crossReport = await synthesize(
    query, allFindings, depth, totalDiscovered,
    totalIngested, 0, router, masterBudget, options.onEvent,
  );

  // Build the merged session
  const { slugify } = await import('./artifacts.js');
  const { saveSession } = await import('./artifacts.js');
  const { generateReport } = await import('./persist.js');
  const slug = slugify(query);

  const session = {
    meta: {
      slug,
      query,
      depth,
      date: new Date().toISOString(),
      sourcesDiscovered: totalDiscovered,
      sourcesIngested: totalIngested,
      findingsCount: allFindings.length,
      convergentCount: crossReport.convergent.length,
      contradictionCount: crossReport.contradictions.length,
      gapCount: crossReport.gaps.length,
      budget: masterBudget.toJSON(),
    },
    report: crossReport,
    sources: allSources,
    findings: allFindings,
    graph: { nodes: [], edges: [] },
    frontier: [],
    reflectionQueries: [],
  };

  const artifactDir = saveSession(session, options.outputDir);
  const markdownReport = generateReport(crossReport);

  return {
    report: markdownReport,
    session,
    slug,
    artifactDir,
  };
}

function decomposePlan(plan: ResearchPlan, totalBudget: number): SubAgentTask[] {
  const tasks: SubAgentTask[] = [];

  // Weight budget allocation by priority
  const priorityWeight = { essential: 3, supplementary: 2, exploratory: 1 };
  const totalWeight = plan.queries.reduce((sum, q) => sum + (priorityWeight[q.priority] ?? 1), 0);

  // Deduct ~10% for orchestration overhead
  const availableBudget = totalBudget * 0.9;

  for (const subQuery of plan.queries) {
    const weight = priorityWeight[subQuery.priority] ?? 1;
    const budgetSlice = Math.floor(availableBudget * (weight / totalWeight));

    // Create a scoped plan for this sub-agent
    const scopedPlan: ResearchPlan = {
      researchQuestion: subQuery.query,
      queries: [{
        query: subQuery.query,
        targetApis: subQuery.targetApis,
        rationale: subQuery.rationale,
        priority: 'essential',
      }],
      activeApis: subQuery.targetApis,
      relevanceCriteria: plan.relevanceCriteria,
      knownContext: plan.knownContext,
      estimatedDepth: Math.max(1, plan.estimatedDepth - 1),
    };

    tasks.push({
      subQuestion: subQuery.query,
      plan: scopedPlan,
      budget: budgetSlice,
      priority: subQuery.priority,
    });
  }

  return tasks;
}

async function runSubAgent(
  task: SubAgentTask,
  parentDepth: ResearchDepth,
  router: ModelRouter,
  options: ResearchOptions,
): Promise<ResearchResult | null> {
  try {
    // Sub-agents run at a reduced depth to manage resource consumption
    const subDepth: ResearchDepth = parentDepth === 'exhaustive' ? 'deep' :
                                     parentDepth === 'deep' ? 'standard' : 'quick';

    const subOptions: ResearchOptions = {
      ...options,
      onEvent: undefined, // Don't emit sub-agent events to the main UI (too noisy)
    };

    return await runResearch(task.subQuestion, subDepth, router, subOptions);
  } catch {
    return null;
  }
}
