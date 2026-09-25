import { buildVariableMap, type Environment, type HostApi, type Variable, type WorkspaceApi } from '@quiver/core';

export const COLLECTIONS = {
  requests: 'requests',
  collections: 'collections',
  environments: 'environments',
} as const;

const SECRETS_DOC = 'secrets';
const ACTIVE_ENV_KEY = 'api.activeEnvironment';
const MASK = '••••••••';

type SecretsDoc = Record<string, string>;

function secretKey(envId: string, variableId: string): string {
  return `${envId}/${variableId}`;
}

/**
 * Persist an environment. Secret values are encrypted with the OS keychain and kept in
 * `.quiver/local/secrets.json`; the committed environment file only carries an empty value.
 */
export async function saveEnvironment(ws: WorkspaceApi, host: HostApi, env: Environment): Promise<Environment> {
  const secrets = await ws.store.readLocal<SecretsDoc>(SECRETS_DOC, {});
  const stripped: Environment = {
    ...env,
    variables: env.variables.map((v) => {
      const key = secretKey(env.id, v.id);
      if (v.secret) {
        if (v.value !== MASK) secrets[key] = host.secrets.encrypt(v.value);
        return { ...v, value: '' };
      }
      delete secrets[key];
      return v;
    }),
  };
  // Drop secrets of variables that no longer exist.
  const liveIds = new Set(env.variables.map((v) => secretKey(env.id, v.id)));
  for (const key of Object.keys(secrets)) {
    if (key.startsWith(`${env.id}/`) && !liveIds.has(key)) delete secrets[key];
  }
  await ws.store.writeLocal(SECRETS_DOC, secrets);
  await ws.store.put(COLLECTIONS.environments, stripped);
  return hydrateEnvironment(stripped, secrets, host, false);
}

function hydrateEnvironment(env: Environment, secrets: SecretsDoc, host: HostApi, mask: boolean): Environment {
  return {
    ...env,
    variables: env.variables.map((v) => {
      if (!v.secret) return v;
      const cipher = secrets[secretKey(env.id, v.id)];
      if (cipher === undefined) return v;
      return { ...v, value: mask ? MASK : safeDecrypt(host, cipher) };
    }),
  };
}

function safeDecrypt(host: HostApi, cipher: string): string {
  try {
    return host.secrets.decrypt(cipher);
  } catch {
    return '';
  }
}

export async function getEnvironment(ws: WorkspaceApi, host: HostApi, id: string, mask = false): Promise<Environment | undefined> {
  const env = await ws.store.get<Environment>(COLLECTIONS.environments, id);
  if (!env) return undefined;
  const secrets = await ws.store.readLocal<SecretsDoc>(SECRETS_DOC, {});
  return hydrateEnvironment(env, secrets, host, mask);
}

export async function listEnvironments(ws: WorkspaceApi, host: HostApi, mask = false): Promise<Environment[]> {
  const envs = await ws.store.list<Environment>(COLLECTIONS.environments);
  const secrets = await ws.store.readLocal<SecretsDoc>(SECRETS_DOC, {});
  return envs.map((e) => hydrateEnvironment(e, secrets, host, mask)).sort((a, b) => a.name.localeCompare(b.name));
}

export async function deleteEnvironment(ws: WorkspaceApi, id: string): Promise<boolean> {
  const secrets = await ws.store.readLocal<SecretsDoc>(SECRETS_DOC, {});
  for (const key of Object.keys(secrets)) if (key.startsWith(`${id}/`)) delete secrets[key];
  await ws.store.writeLocal(SECRETS_DOC, secrets);
  if ((await ws.getState<string | null>(ACTIVE_ENV_KEY, null)) === id) await ws.setState(ACTIVE_ENV_KEY, null);
  return ws.store.remove(COLLECTIONS.environments, id);
}

export async function getActiveEnvironmentId(ws: WorkspaceApi): Promise<string | null> {
  return ws.getState<string | null>(ACTIVE_ENV_KEY, null);
}

export async function setActiveEnvironmentId(ws: WorkspaceApi, id: string | null): Promise<void> {
  await ws.setState(ACTIVE_ENV_KEY, id);
}

/** Global variables, then the chosen (or active) environment. */
export async function resolveVariableMap(ws: WorkspaceApi, host: HostApi, environmentId?: string | null): Promise<Record<string, string>> {
  const envId = environmentId === undefined ? await getActiveEnvironmentId(ws) : environmentId;
  const layers: Variable[][] = [host.config.get().globalVariables];
  if (envId) {
    const env = await getEnvironment(ws, host, envId);
    if (env) layers.push(env.variables);
  }
  return buildVariableMap(layers);
}

export const ACTIVE_ENVIRONMENT_STATE_KEY = ACTIVE_ENV_KEY;
