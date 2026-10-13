import fs from "fs";
import crypto from "crypto";
import yaml from "yaml";
export class DshAuth {
    credentialsPath;
    authority;
    cachedCookie = null;
    cookieExpiresAt = 0;
    constructor(credentialsPath, authority) {
        this.credentialsPath = credentialsPath;
        this.authority = authority;
    }
    getCookie() {
        const now = Date.now();
        // Refresh cookie 1 day before expiration
        if (this.cachedCookie && this.cookieExpiresAt > now + 86400000) {
            return this.cachedCookie;
        }
        if (!fs.existsSync(this.credentialsPath)) {
            throw new Error(`DSH credentials file not found: ${this.credentialsPath}`);
        }
        const creds = yaml.parse(fs.readFileSync(this.credentialsPath, "utf8"));
        const browserSession = creds.records?.["client-connection/browser-session"];
        if (!browserSession || !browserSession.payload?.secret) {
            throw new Error("client-connection/browser-session secret not found in credentials.yaml");
        }
        const secret = Buffer.from(browserSession.payload.secret, "base64url");
        const cookieName = "dsh-auth-" + crypto.createHash("sha256").update(this.authority).digest("base64url");
        const expiresAt = now + 30 * 24 * 3600 * 1000;
        const payload = {
            version: 1,
            authority: this.authority,
            issuedAt: now,
            expiresAt
        };
        const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
        const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
        const cookieValue = `v1.${body}.${sig}`;
        this.cachedCookie = `${cookieName}=${cookieValue}`;
        this.cookieExpiresAt = expiresAt;
        return this.cachedCookie;
    }
}
