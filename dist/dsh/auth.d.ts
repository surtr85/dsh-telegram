export declare class DshAuth {
    private credentialsPath;
    private authority;
    private cachedCookie;
    private cookieExpiresAt;
    constructor(credentialsPath: string, authority: string);
    getCookie(): string;
}
