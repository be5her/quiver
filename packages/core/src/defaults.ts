import { defaultActivityBarLayout } from './activity-bar';
import { defaultNetworkConfig } from './network';
import { DEFAULT_PALETTE } from './palettes';
import type { GlobalConfig } from './types';

export const DEFAULT_MCP_PORT = 7411;

export function defaultGlobalConfig(): GlobalConfig {
  return {
    theme: 'system',
    palette: DEFAULT_PALETTE,
    recentWorkspaces: [],
    openWorkspaces: [],
    globalVariables: [],
    mcp: { enabled: true, port: DEFAULT_MCP_PORT, allowMutating: false, permissions: { mode: 'read-only', rules: [] }, workspaceRules: {}, paused: false },
    teleport: { proxies: [], pins: [], tshPath: '', loginOnLaunch: false, protectedKubes: [], agentActionsOnProtected: false },
    mock: { ports: [] },
    updates: { channel: 'stable' },
    activityBar: defaultActivityBarLayout(),
    network: defaultNetworkConfig(),
  };
}
