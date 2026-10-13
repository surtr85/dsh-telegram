import test from "node:test";
import assert from "node:assert/strict";
import { formatTopicTitle } from "../src/telegram/topic-utils.js";

test("formatTopicTitle formats clean topic titles", () => {
  // Simple English sentence
  assert.equal(
    formatTopicTitle("Implement user authentication module"),
    "Implement user authentication module"
  );

  // Long text gets truncated cleanly to max 64 characters (Telegram limit)
  const longText = "This is a very long text that exceeds sixty four characters and must be truncated gracefully";
  const formattedLong = formatTopicTitle(longText);
  assert.ok(formattedLong.length <= 64);
  assert.ok(formattedLong.endsWith("..."));

  // Trims symbols and newlines
  assert.equal(formatTopicTitle("\n\n  Fix bug in router  \n"), "Fix bug in router");

  // Empty or fallback returns a default
  assert.equal(formatTopicTitle(""), "New Session");
  assert.equal(formatTopicTitle("   "), "New Session");
});
