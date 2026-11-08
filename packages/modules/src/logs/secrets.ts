import type { HostApi, WorkspaceApi } from '@quiver/core';

/** Per machine, under `.quiver/local`: `{ "logs-connection:<id>": cipher }`, encrypted with `host.secrets`. */
const SECRETS_DOC = 'logs-secrets';

type SecretsDoc = Record<string, string>;

/** The name a direct connection's password or token is stored under, and looked up by in the headless CLI. */
export function logsSecretName(connectionId: string): string {
  return `logs-connection:${connectionId}`;
}

/** The password or token of a direct connection on this machine, or '' when there is none (or it no longer decrypts). */
export async function readLogsSecret(ws: WorkspaceApi, host: HostApi, connectionId: string): Promise<string> {
  const name = logsSecretName(connectionId);
  const handed = host.secrets.lookup?.(name);
  if (handed !== undefined) return handed;
  const cipher = (await ws.store.readLocal<SecretsDoc>(SECRETS_DOC, {}))[name];
  if (!cipher) return '';
  try {
    return host.secrets.decrypt(cipher);
  } catch {
    return '';
  }
}

/** Store a secret for a connection, or forget it with null or ''. The caller announces the change. */
export async function writeLogsSecret(ws: WorkspaceApi, host: HostApi, connectionId: string, secret: string | null): Promise<void> {
  const secrets = await ws.store.readLocal<SecretsDoc>(SECRETS_DOC, {});
  const name = logsSecretName(connectionId);
  if (secret) secrets[name] = host.secrets.encrypt(secret);
  else if (name in secrets) delete secrets[name];
  else return;
  await ws.store.writeLocal(SECRETS_DOC, secrets);
}

/** The ids of the connections that have a secret on this machine. */
export async function connectionsWithSecret(ws: WorkspaceApi): Promise<Set<string>> {
  const prefix = logsSecretName('');
  return new Set(
    Object.keys(await ws.store.readLocal<SecretsDoc>(SECRETS_DOC, {}))
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length)),
  );
}
