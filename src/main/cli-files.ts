// The files the app publishes for the `quiver` command line (src/cli). Kept apart from cli-access, so a connected
// CLI reads them without loading the Host.

/** In the user data folder: the token of this run, readable by the user only. */
export const CLI_TOKEN_FILE = 'cli-token';
/** In the user data folder: where this run listens, while it does. */
export const CLI_ENDPOINT_FILE = 'cli-endpoint.json';

export interface CliEndpointInfo {
  port: number;
  url: string;
  pid: number;
  version: string;
}
