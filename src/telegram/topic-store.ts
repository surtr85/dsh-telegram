import fs from "fs";
import path from "path";

export interface TopicBinding {
  chatId: number;
  topicId: number;
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export class TopicStore {
  private filePath: string;
  private bindings = new Map<string, TopicBinding>(); // key: `${chatId}:${topicId}`

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private getKey(chatId: number, topicId: number): string {
    return `${chatId}:${topicId}`;
  }

  public getBinding(chatId: number, topicId: number): TopicBinding | undefined {
    return this.bindings.get(this.getKey(chatId, topicId));
  }

  public getBindingBySession(sessionId: string): TopicBinding | undefined {
    for (const binding of this.bindings.values()) {
      if (binding.sessionId === sessionId) {
        return binding;
      }
    }
    return undefined;
  }

  public setBinding(
    chatId: number,
    topicId: number,
    sessionId: string,
    title: string = "New Session"
  ): TopicBinding {
    const key = this.getKey(chatId, topicId);
    const existing = this.bindings.get(key);
    const now = Date.now();

    const binding: TopicBinding = {
      chatId,
      topicId,
      sessionId,
      title,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now
    };

    this.bindings.set(key, binding);
    this.save();
    return binding;
  }

  public updateTitle(chatId: number, topicId: number, title: string): boolean {
    const key = this.getKey(chatId, topicId);
    const existing = this.bindings.get(key);
    if (!existing) return false;

    existing.title = title;
    existing.updatedAt = Date.now();
    this.save();
    return true;
  }

  public updateTitleBySession(sessionId: string, title: string): boolean {
    const existing = this.getBindingBySession(sessionId);
    if (!existing) return false;

    existing.title = title;
    existing.updatedAt = Date.now();
    this.save();
    return true;
  }

  public deleteBinding(chatId: number, topicId: number): boolean {
    const key = this.getKey(chatId, topicId);
    const deleted = this.bindings.delete(key);
    if (deleted) {
      this.save();
    }
    return deleted;
  }

  public listBindings(chatId?: number): TopicBinding[] {
    const list = Array.from(this.bindings.values());
    if (chatId !== undefined) {
      return list.filter((b) => b.chatId === chatId);
    }
    return list;
  }

  public load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.bindings.clear();
          for (const item of parsed) {
            if (item.chatId && item.topicId && item.sessionId) {
              this.bindings.set(this.getKey(item.chatId, item.topicId), item);
            }
          }
        }
      }
    } catch (err: any) {
      console.warn(`[TopicStore] Failed to load topics from ${this.filePath}:`, err.message);
    }
  }

  public save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = Array.from(this.bindings.values());
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err: any) {
      console.error(`[TopicStore] Failed to save topics to ${this.filePath}:`, err.message);
    }
  }
}
