import type { HostApi, WorkspaceApi } from '@quiver/core';

const SECRETS_DOC = 'metabase-secrets';

/** Connection id to its API key, encrypted for this machine. Never committed, never returned to a caller. */
type SecretsDoc = Record<string, string>;

/** The API key stored on this machine for a connection, or '' when there is none (or it no longer decrypts). */
export async function readApiKey(ws: WorkspaceApi, host: HostApi, connectionId: string): Promise<string> {
  const secrets = await ws.store.readLocal<SecretsDoc>(SECRETS_DOC, {});
  const cipher = secrets[connectionId];
  if (!cipher) return '';
  try {
    return host.secrets.decrypt(cipher);
  } catch {
    return '';
  }
}

/** Store a key for a connection, or forget it with null. The caller announces the change. */
export async function writeApiKey(ws: WorkspaceApi, host: HostApi, connectionId: string, apiKey: string | null): Promise<void> {
  const secrets = await ws.store.readLocal<SecretsDoc>(SECRETS_DOC, {});
  if (apiKey) secrets[connectionId] = host.secrets.encrypt(apiKey);
  else delete secrets[connectionId];
  await ws.store.writeLocal(SECRETS_DOC, secrets);
}

/** The connections that have a key on this machine. */
export async function connectionsWithApiKey(ws: WorkspaceApi): Promise<Set<string>> {
  return new Set(Object.keys(await ws.store.readLocal<SecretsDoc>(SECRETS_DOC, {})));
}

export async function hasApiKey(ws: WorkspaceApi, connectionId: string): Promise<boolean> {
  return (await connectionsWithApiKey(ws)).has(connectionId);
}
