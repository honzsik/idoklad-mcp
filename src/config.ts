import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  clientId: string;
  clientSecret: string;
  applicationId: string;
  readOnly: boolean;
  apiUrl: string;
  tokenUrl: string;
  /** Folder for downloaded PDFs. */
  downloadDir: string;
}

// Shared application ID of the idoklad-mcp project on developer.idoklad.cz.
// Empty until iDoklad confirms a shared ID is allowed; users set their own meanwhile.
const DEFAULT_APPLICATION_ID = "";

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const clientId = env.IDOKLAD_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.IDOKLAD_CLIENT_SECRET?.trim() ?? "";
  const applicationId = env.IDOKLAD_APPLICATION_ID?.trim() || DEFAULT_APPLICATION_ID;

  const missing = [
    !clientId && "IDOKLAD_CLIENT_ID",
    !clientSecret && "IDOKLAD_CLIENT_SECRET",
    !applicationId && "IDOKLAD_APPLICATION_ID",
  ].filter(Boolean);
  if (missing.length) {
    throw new ConfigError(
      `Missing environment variables: ${missing.join(", ")}. ` +
        "Client ID and secret come from iDoklad → Settings → API; " +
        "the application ID is the Client Id of a ClientCredentials app on https://developer.idoklad.cz.",
    );
  }

  return {
    clientId,
    clientSecret,
    applicationId,
    readOnly: (env.IDOKLAD_READ_ONLY ?? "true").trim().toLowerCase() !== "false",
    apiUrl: env.IDOKLAD_API_URL?.trim() || "https://api.idoklad.cz/v3",
    tokenUrl: env.IDOKLAD_TOKEN_URL?.trim() || "https://identity.idoklad.cz/server/v2/connect/token",
    downloadDir: env.IDOKLAD_DOWNLOAD_DIR?.trim() || join(homedir(), "Downloads"),
  };
}
