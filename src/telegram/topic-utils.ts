/**
 * Formats a clean topic title adhering to Telegram's 64-character limit
 * and session naming rules.
 */
export function formatTopicTitle(input: string, fallback = "New Session"): string {
  if (!input) return fallback;

  // Collapse spaces and newlines
  const cleaned = input
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return fallback;

  // Maximum length for Telegram forum topic name is 64 characters
  const MAX_TOPIC_LENGTH = 64;

  if (cleaned.length <= MAX_TOPIC_LENGTH) {
    return cleaned;
  }

  // Truncate at word boundary if possible
  const truncated = cleaned.slice(0, MAX_TOPIC_LENGTH - 3).trim();
  return `${truncated}...`;
}
