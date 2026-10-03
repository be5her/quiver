import { inject, untracked } from '@angular/core';
import { AppState, defineModuleUI } from '@quiver/ui';
import { Plug } from 'lucide';
import { McpActions } from './mcp-actions';
import { McpRecording, RECORDER_TAB } from './mcp-recording';
import { McpSidebar } from './mcp-sidebar';
import { McpRecorderTab } from './recorder-tab';
import { McpServerTab } from './server-tab';

export const mcpModuleUI = defineModuleUI({
  id: 'mcp',
  title: 'MCP inspector',
  icon: Plug,
  order: 40,
  availability: 'workspace',
  sidebar: McpSidebar,
  tabs: {
    'mcp.server': McpServerTab,
    [RECORDER_TAB]: McpRecorderTab,
  },
  actions: () => {
    const mcp = inject(McpActions);
    const recording = inject(McpRecording);
    const app = inject(AppState);
    const hasWorkspace = () => untracked(app.hasWorkspace);
    return [
      { id: 'mcp.server.new', title: 'New MCP server (command)', group: 'MCP inspector', run: () => mcp.createServer('stdio'), when: hasWorkspace },
      { id: 'mcp.server.newHttp', title: 'New MCP server (HTTP)', group: 'MCP inspector', run: () => mcp.createServer('http'), when: hasWorkspace },
      { id: 'mcp.server.import', title: 'Import MCP servers from project files', group: 'MCP inspector', run: () => mcp.importServers(), when: hasWorkspace },
      { id: 'mcp.server.self', title: "Inspect Quiver's own MCP server", group: 'MCP inspector', run: () => mcp.addThisQuiver(), when: hasWorkspace },
      { id: 'mcp.recorder.open', title: 'Open the MCP call recorder', group: 'MCP inspector', keywords: ['record', 'agent', 'calls'], run: () => recording.openRecorderTab() },
      {
        id: 'mcp.recorder.start',
        title: 'Record the calls agents make to Quiver',
        group: 'MCP inspector',
        keywords: ['record', 'agent', 'mcp'],
        run: async () => {
          recording.openRecorderTab();
          await recording.start();
        },
      },
    ];
  },
});
