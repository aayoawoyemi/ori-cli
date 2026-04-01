import type { Tool } from './types.js';
import type { ToolDefinition } from '../router/types.js';
import type { OriVault } from '../memory/vault.js';
import type { ProjectBrain } from '../memory/projectBrain.js';
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

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
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
export function createCoreRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  // Core filesystem tools
  registry.register(new BashTool());
  registry.register(new ReadTool());
  registry.register(new WriteTool());
  registry.register(new EditTool());
  registry.register(new GlobTool());
  registry.register(new GrepTool());
  // Web tools
  registry.register(new WebFetchTool());
  registry.register(new WebSearchTool());
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
  }
}
