import type { Message } from '../router/types.js';
import type { OriVault } from '../memory/vault.js';
import type { ProjectBrain } from '../memory/projectBrain.js';
import type { ModelRouter } from '../router/index.js';
import { runPostflight, REFLECTION_THRESHOLD } from '../memory/postflight.js';
import { triggerReflectionWithModel } from '../memory/reflection.js';
import { getMessageText } from '../utils/messages.js';

/**
 * End-of-session sync. Called when the user exits or runs /clear.
 *
 * 1. Final postflight with accumulated session context
 * 2. Force reflection if importance accumulator is above half-threshold
 * 3. Save session summary to vault ops/sessions/
 */
export async function syncSession(
  messages: Message[],
  importanceAccumulator: number,
  projectBrain: ProjectBrain | null,
  vault: OriVault | null,
  router: ModelRouter,
): Promise<void> {
  if (messages.length < 2) return; // nothing meaningful to sync

  // 1. Final postflight
  await runPostflight(messages, null, projectBrain, vault, importanceAccumulator);

  // 2. Force reflection if we accumulated enough importance (half threshold)
  if (vault?.connected && importanceAccumulator >= REFLECTION_THRESHOLD / 2) {
    try {
      await triggerReflectionWithModel(messages, vault, router);
    } catch {
      // Reflection failure shouldn't block exit
    }
  }

  // 3. Save session metadata to vault
  if (vault?.connected && messages.length >= 4) {
    const userMsgCount = messages.filter(m => m.role === 'user').length;
    const assistantMsgCount = messages.filter(m => m.role === 'assistant').length;
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    const topic = lastUserMsg ? getMessageText(lastUserMsg).slice(0, 100) : 'unknown';
    const date = new Date().toISOString().split('T')[0];

    await vault.add(
      `session ${date} ${topic}`,
      `Session on ${date}. ${userMsgCount} user messages, ${assistantMsgCount} assistant messages. Last topic: ${topic}`,
      'learning',
    ).catch(() => {});
  }
}
