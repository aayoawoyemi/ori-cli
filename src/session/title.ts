import type { ModelRouter } from '../router/index.js';
import type { SessionStorage } from './storage.js';

/**
 * Generate a short title for a session using the cheap model slot.
 * Called after the first assistant response completes.
 * Falls back to truncating the user's first message if the model fails.
 */
export async function generateSessionTitle(
  firstUserMessage: string,
  firstAssistantResponse: string,
  router: ModelRouter,
  session: SessionStorage,
): Promise<string> {
  const userSnippet = firstUserMessage.slice(0, 300);
  const assistantSnippet = firstAssistantResponse.slice(0, 200);

  try {
    const result = await router.cheapCall(
      'You generate concise session titles. Respond with ONLY the title, nothing else.',
      [
        {
          role: 'user',
          content: `Generate a 3-6 word title for this coding session. No quotes, no punctuation, no markdown. Just the title words.\n\nUser: ${userSnippet}\n\nAssistant: ${assistantSnippet}`,
        },
      ],
    );

    const title = result.trim().replace(/^["']|["']$/g, '').slice(0, 60);
    if (title.length > 0) {
      session.setTitle(title);
      return title;
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback: first 50 chars of user message
  const fallback = userSnippet.slice(0, 50).replace(/\n/g, ' ').trim();
  session.setTitle(fallback);
  return fallback;
}
