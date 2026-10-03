import { Component, inject } from '@angular/core';
import { AppState, ContextMenuHost, DialogHost, ToastHost, VariableHoverCard } from '@quiver/ui';
import { ActivityBar } from './activity-bar/activity-bar';
import { CommandPalette } from './command-palette/command-palette';
import { ShellActions } from './shell-actions';
import { Sidebar } from './sidebar/sidebar';
import { StatusBar } from './status-bar/status-bar';
import { TabBar } from './tabs/tab-bar';
import { TabContent } from './tabs/tab-content';
import { TitleBar } from './title-bar/title-bar';

/** The frame around the modules: title bar, activity bar, sidebar, tabs, status bar, and the overlays. */
@Component({
  selector: 'q-root',
  imports: [ActivityBar, CommandPalette, ContextMenuHost, DialogHost, Sidebar, StatusBar, TabBar, TabContent, TitleBar, ToastHost, VariableHoverCard],
  templateUrl: './app.html',
  host: { '(window:keydown)': 'shortcut($event)' },
})
export class App {
  private readonly shell = inject(ShellActions);
  protected readonly ready = inject(AppState).ready;

  protected shortcut(event: KeyboardEvent): void {
    this.shell.handleShortcut(event);
  }
}
