export interface AppConfig {
    telegramToken: string;
    allowedUserId: number;
    dshBaseUrl: string;
    dshWsUrl: string;
    dshAuthority: string;
    credentialsPath: string;
    defaultCwd: string;
}
export declare function loadConfig(): AppConfig;
