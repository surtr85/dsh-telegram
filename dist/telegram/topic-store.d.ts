export interface TopicBinding {
    chatId: number;
    topicId: number;
    sessionId: string;
    title: string;
    createdAt: number;
    updatedAt: number;
}
export declare class TopicStore {
    private filePath;
    private bindings;
    constructor(filePath: string);
    private getKey;
    getBinding(chatId: number, topicId: number): TopicBinding | undefined;
    getBindingBySession(sessionId: string): TopicBinding | undefined;
    setBinding(chatId: number, topicId: number, sessionId: string, title?: string): TopicBinding;
    updateTitle(chatId: number, topicId: number, title: string): boolean;
    updateTitleBySession(sessionId: string, title: string): boolean;
    deleteBinding(chatId: number, topicId: number): boolean;
    listBindings(chatId?: number): TopicBinding[];
    load(): void;
    save(): void;
}
