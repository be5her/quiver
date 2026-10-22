import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CliUsageError, QuiverError, lookupSecret, type SecretsApi } from '@quiver/core';
import type { CliOutcome } from '@quiver/mcp';
import { runCliRequest } from '../main/cli-access';
import { Host } from '../main/host';
import type { Transport } from './transport';

/**
 * Secrets in a headless run: there is no OS keychain to decrypt what the app stored, so such a value fails with
 * SECRET_UNAVAILABLE; secrets come in by name from the `--secrets` file and `QUIVER_SECRET_<NAME>` variables instead.
 * What a command stores is kept unencrypted (`plain:`), as the app does on a machine without a keychain.
 */
export function headlessSecrets(file: Record<string, unknown>): SecretsApi {
  return {
    available: false,
    encrypt: (plain) => `plain:${plain}`,
    decrypt: (cipher) => {
      if (cipher.startsWith('plain:')) return cipher.slice(6);
      if (cipher.startsWith('enc:')) throw new QuiverError('SECRET_UNAVAILABLE', 'A headless run has no access to the keychain the app encrypts secrets with; run the command with the app open, or hand the secret in.');
      return cipher;
    },
    lookup: (name) => lookupSecret(name, process.env, file),
  };
}

/** Start a Host in this process: no window, no MCP server, the config and per-machine state under `dataDir`. */
export async function headless(dataDir: string, secretsFile: string | undefined, version: string): Promise<Transport> {
  let file: Record<string, unknown> = {};
  if (secretsFile) {
    try {
      file = JSON.parse(await fs.readFile(path.resolve(secretsFile), 'utf8')) as Record<string, unknown>;
    } catch (err) {
      // JSON.parse quotes the text around the error, which here is a secret; say only where it is.
      const at = err instanceof SyntaxError ? /position \d+/.exec(err.message)?.[0] : undefined;
      const where = err instanceof SyntaxError ? `is not valid JSON${at ? ` (at ${at})` : ''}` : (err as Error).message;
      throw new CliUsageError(`--secrets ${secretsFile}: ${where}`);
    }
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new CliUsageError(`--secrets ${secretsFile} must hold a JSON object of name to value`);
  }
  await fs.mkdir(dataDir, { recursive: true });
  const host = new Host({ userDataDir: dataDir, version, secrets: headlessSecrets(file), broadcast: () => {}, serve: false });
  await host.start();
  return {
    mode: 'headless',
    call: (command, input, workspace, signal) =>
      new Promise<CliOutcome>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        runCliRequest(host, { command, input, workspace }, signal).then(resolve, reject);
      }),
    close: () => host.stop(),
  };
}
