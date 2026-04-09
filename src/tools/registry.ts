import type { Tool } from './types.js';
import type { ToolDefinition } from '../router/types.js';
import type { OriVault } from '../memory/vault.js';
import type { ProjectBrain } from '../memory/projectBrain.js';
import type { WebSearchConfig } from '../config/types.js';
import { BashTool } from './bash.js';
import { ReadTool } from './read.js';
import { WriteTool } from './write.js';
import { EditTool } from './edit.js';
import { GlobTool } from './glob.js';
import { GrepTool } from './grep.js';
import { WebFetchTool } from './webFetch.js';
import { WebSearchTool } from './webSearch.js';
import { AgentTool } from './agent.js';
import { VaultSearchTool } from './vaultSearch.js';
import { VaultReadTool } from './vaultRead.js';
import { VaultAddTool } from './vaultAdd.js';
import { VaultExploreTool } from './vaultExplore.js';
import { VaultWarmthTool } from './vaultWarmth.js';
import { ProjectSearchTool } from './projectSearch.js';
import { ProjectSaveTool } from './projectSave.js';
import { ReplTool } from './repl.js';
import type { ReplHandle } from '../repl/setup.js';
import type { PlanContext, PlanApprovalResult } from './planTypes.js';
import { EnterPlanModeTool } from './enterPlanMode.js';
import { ExitPlanModeTool } from './exitPlanMode.js';

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Get all tool definitions to send to the model. */
  definitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition());
  }

  /** Get all registered tools. */
  all(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** Check if a tool is read-only (safe for parallel execution). */
  isReadOnly(name: string): boolean {
    return this.tools.get(name)?.readOnly ?? false;
  }
}

/** Create a registry with all core tools. */
export function createCoreRegistry(options?: { replEnabled?: boolean; webSearch?: WebSearchConfig; getHandle?: () => ReplHandle | null }): ToolRegistry {
  const registry = new ToolRegistry();
  // Core filesystem tools
  registry.register(new BashTool({ replEnabled: options?.replEnabled, getHandle: options?.getHandle }));
  registry.register(new ReadTool());
  registry.register(new WriteTool());
  registry.register(new EditTool());
  registry.register(new GlobTool());
  registry.register(new GrepTool());
  // Web tools
  registry.register(new WebFetchTool());
  registry.register(new WebSearchTool(options?.webSearch));
  // Subagent
  registry.register(new AgentTool());
  return registry;
}

/** Register memory tools (requires vault and/or project brain). */
export function registerMemoryTools(
  registry: ToolRegistry,
  vault: OriVault | null,
  projectBrain: ProjectBrain | null,
): void {
  if (vault?.connected) {
    registry.register(new VaultSearchTool(vault));
    registry.register(new VaultReadTool(vault));
    registry.register(new VaultAddTool(vault));
    registry.register(new VaultExploreTool(vault));
    registry.register(new VaultWarmthTool(vault));
  }
  if (projectBrain) {
    registry.register(new ProjectSearchTool(projectBrain));
    registry.register(new ProjectSaveTool(projectBrain));
  }
}

/**
 * Register the Repl tool. Enables code-acting via Python body.
 * The getHandle closure allows the tool to check bridge liveness at call time
 * (restart-on-crash is transparent to the tool).
 */
export function registerReplTool(
  registry: ToolRegistry,
  getHandle: () => ReplHandle | null,
): void {
  registry.register(new ReplTool(getHandle));
}

/**
 * Strip legacy file-navigation tools (Read/Grep/Glob/VaultSearch/VaultRead/
 * VaultExplore/VaultWarmth/ProjectSearch) to force the model through the
 * Repl tool for code + memory navigation. Leaves Bash, Write, Edit, Web*,
 * Agent, VaultAdd — ops that don't benefit from composition.
 *
 * Mirrors the mandatory-REPL thesis: removing meta-decisions by subtracting
 * escape hatches.
 */
/** Register EnterPlanMode + ExitPlanMode tools. Returns the shared plan context. */
export function registerPlanTools(
  registry: ToolRegistry,
  options: {
    cwd: string;
    onEnter: (filePath: string) => void;
    onExit: (filePath: string, content: string) => Promise<PlanApprovalResult>;
  },
): PlanContext {
  const planContext: PlanContext = { filePath: null };
  registry.register(new EnterPlanModeTool(planContext, options.cwd, options.onEnter));
  registry.register(new ExitPlanModeTool(planContext, options.onExit));
  return planContext;
}

export function stripNavigationTools(registry: ToolRegistry): void {
  const legacyNav = [
    'Read', 'Grep', 'Glob',
    'VaultSearch', 'VaultRead', 'VaultExplore', 'VaultWarmth',
    'ProjectSearch',
  ];
  for (const name of legacyNav) {
    (registry as any).tools.delete(name);
  }
}
