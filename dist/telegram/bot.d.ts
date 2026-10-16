import { AppConfig } from "../config.js";
import { DshClient } from "../dsh/client.js";
export declare class TelegramBridge {
    private bot;
    private config;
    private dsh;
    private currentSessionId;
    private sessionStateFile;
    private topicStore;
    private workspaceStateFile;
    private activeCwd;
    private mediaGroupBuffers;
    private sessionLocks;
    private processedMessageIds;
    private activeTurns;
    private modelCatalogCache;
    constructor(config: AppConfig, dshClient: DshClient);
    private loadPersistedWorkspace;
    setActiveCwd(newCwd: string): void;
    getActiveCwd(): string;
    private listAvailableWorkspaces;
    private loadPersistedSession;
    private persistSession;
    private setupPlugins;
    private setupMiddleware;
    private resolveSession;
    private resolveSessionForContext;
    private isThreadedChat;
    private syncTopicTitleIfChanged;
    private setupCommands;
    private enqueueSessionTurn;
    private setupMessageHandler;
    private processMediaGroup;
    private handleSessionTurn;
    /**
     * Intelligently delivers the assistant response.
     * If markdown images are detected, sends them as rich Telegram photos with caption and post text!
     */
    private deliverAssistantResponse;
    start(): Promise<void>;
    stop(): Promise<void>;
}
