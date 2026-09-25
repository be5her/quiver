import type { GlobalConfig } from './types';

export const DEFAULT_MCP_PORT = 7411;

export function defaultGlobalConfig(): GlobalConfig {
  return {
    theme: 'system',
    recentWorkspaces: [],
    openWorkspaces: [],
    globalVariables: [],
    mcp: { enabled: true, port: DEFAULT_MCP_PORT, allowMutating: false },
    teleport: { proxies: [], pins: [], tshPath: '', loginOnLaunch: false },
  };
}
