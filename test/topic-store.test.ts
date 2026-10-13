import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { TopicStore } from "../src/telegram/topic-store.js";

test("TopicStore manages session bindings per chat and topic", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-topic-test-"));
  const storePath = path.join(tmpDir, "topics.json");

  try {
    const store = new TopicStore(storePath);

    // Initial state is empty
    assert.equal(store.getBinding(-1001234567, 101), undefined);
    assert.equal(store.listBindings().length, 0);

    // Set a binding
    const binding = store.setBinding(-1001234567, 101, "session-abc-123", "Task 1: Feature XYZ");
    assert.equal(binding.chatId, -1001234567);
    assert.equal(binding.topicId, 101);
    assert.equal(binding.sessionId, "session-abc-123");
    assert.equal(binding.title, "Task 1: Feature XYZ");

    // Lookup by (chatId, topicId)
    const found = store.getBinding(-1001234567, 101);
    assert.ok(found);
    assert.equal(found.sessionId, "session-abc-123");

    // Lookup by sessionId
    const bySession = store.getBindingBySession("session-abc-123");
    assert.ok(bySession);
    assert.equal(bySession.topicId, 101);

    // Update title
    const updated = store.updateTitle(-1001234567, 101, "Task 1: Renamed Title");
    assert.equal(updated, true);
    assert.equal(store.getBinding(-1001234567, 101)?.title, "Task 1: Renamed Title");

    // Update title by session
    const updatedBySession = store.updateTitleBySession("session-abc-123", "Task 1: Second Rename");
    assert.equal(updatedBySession, true);
    assert.equal(store.getBinding(-1001234567, 101)?.title, "Task 1: Second Rename");

    // Persistence reload test
    const storeReloaded = new TopicStore(storePath);
    const reloadedBinding = storeReloaded.getBinding(-1001234567, 101);
    assert.ok(reloadedBinding);
    assert.equal(reloadedBinding.sessionId, "session-abc-123");
    assert.equal(reloadedBinding.title, "Task 1: Second Rename");

    // Deletion test
    assert.equal(store.deleteBinding(-1001234567, 101), true);
    assert.equal(store.getBinding(-1001234567, 101), undefined);
    assert.equal(store.getBindingBySession("session-abc-123"), undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
