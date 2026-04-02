import type { Message } from '../router/types.js';
import type { OriVault } from '../memory/vault.js';
import type { ProjectBrain } from '../memory/projectBrain.js';
import type { ModelRouter } from '../router/index.js';
import { runPostflight } from '../memory/postflight.js';
import { triggerReflectionWithModel, triggerReflectionSimple } from '../memory/reflection.js';
import { getMessageText } from '../utils/messages.js';

/**
 * End-of-session sync. Called when the user exits or runs /clear.
 *
 * 1. Final postflight
 * 2. ALWAYS reflect — every session deserves a synthesis moment
 * 3. Save session metadata to vault
 */
export async function syncSession(
  messages: Message[],
  importanceAccumulator: number,
  projectBrain: ProjectBrain | null,
  vault: OriVault | null,
  router: ModelRouter,
): Promise<void> {
  if (messages.length < 2) return;

  // 1. Final postflight
  await runPostflight(messages, null, projectBrain, vault, importanceAccumulator);

  // 2. Always reflect at session end — no threshold gate.
  // Every session gets a synthesis moment. The agent identified this gap:
  // "there's no moment where I look back at what happened and crystallize it."
  if (vault?.connected && messages.length >= 4) {
    try {
      await triggerReflectionWithModel(messages, vault, router);
    } catch {
      // Fall back to simple keyword reflection if cheap model unavailable
      try {
        await triggerReflectionSimple(messages, vault);
      } catch {
        // Reflection failure never blocks exit
      }
    }
  }

  // 3. Save session metadata
  if (vault?.connected && messages.length >= 4) {
    const userMsgCount = messages.filter(m => m.role === 'user').length;
    const assistantMsgCount = messages.filter(m => m.role === 'assistant').length;
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    const topic = lastUserMsg ? getMessageText(lastUserMsg).slice(0, 100) : 'unknown';
    const date = new Date().toISOString().split('T')[0];

    await vault.add(
      `session ${date} ${topic}`,
      `Session on ${date}. ${userMsgCount} user messages, ${assistantMsgCount} assistant messages. Topic: ${topic}`,
      'learning',
    ).catch(() => {});
  }
}
