import { Directive, computed, inject } from '@angular/core';
import { toErrorPayload } from '@quiver/core';
import { HostBridge, Toasts, VariableSource, invokeResource, type VariableContext, type VariableScope, type VariableTarget } from '@quiver/ui';

/**
 * Supplies the variables in effect (global, then the active environment) to the fields inside, for
 * highlighting and hover, and lets the hover card change a value where it is defined or define a
 * missing one in any environment or the globals.
 */
@Directive({
  selector: '[qApiVariables]',
  providers: [{ provide: VariableSource, useExisting: ApiVariables }],
})
export class ApiVariables implements VariableSource {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);
  private readonly scope = invokeResource<VariableScope>('api.variables.list', () => ({}), {
    refreshOn: ['environments'],
    refreshOnState: ['api.activeEnvironment'],
    refreshOnEvents: ['config.changed'],
  });

  readonly context = computed<VariableContext | null>(() => {
    const scope = this.scope.value();
    return scope ? { ...scope, save: (name, value) => this.save(name, value), define: (name, value, target, secret) => this.define(name, value, target, secret) } : null;
  });

  private async save(name: string, value: string): Promise<void> {
    try {
      const { source } = await this.host.invoke<{ source: 'environment' | 'global' }>('api.variables.set', { name, value });
      this.toasts.notify(source === 'global' ? `Updated the global variable ${name}` : `Updated ${name} in the active environment`, 'success');
    } catch (err) {
      throw new Error(toErrorPayload(err).message);
    }
    this.scope.reload();
  }

  private async define(name: string, value: string, target: VariableTarget, secret: boolean): Promise<VariableScope> {
    try {
      const result = await this.host.invoke<{ environmentName?: string }>('api.variables.define', { name, value, target, secret });
      const active = this.scope.value()?.environment;
      this.toasts.notify(
        target.kind === 'global'
          ? `Added the global variable ${name}`
          : target.id === active?.id
            ? `Added ${name} to ${result.environmentName}`
            : `Added ${name} to ${result.environmentName}; it applies when that environment is active`,
        'success',
      );
    } catch (err) {
      throw new Error(toErrorPayload(err).message);
    }
    const next = await this.host.invoke<VariableScope>('api.variables.list', {});
    this.scope.reload();
    return next;
  }
}
