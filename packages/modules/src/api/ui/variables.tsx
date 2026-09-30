import { toErrorPayload } from '@quiver/core';
import { VariablesProvider, invoke, notify, useInvoke, type VariableScope, type VariableTarget } from '@quiver/ui';
import { useCallback, type ReactNode } from 'react';

/**
 * Supplies the variables in effect (global, then the active environment) to the fields inside,
 * for highlighting and hover, and lets the hover card change a value where it is defined or
 * define a missing one in any environment or the globals.
 */
export function ApiVariablesProvider({ children }: { children: ReactNode }) {
  const scope = useInvoke<VariableScope>('api.variables.list', {}, { refreshOn: ['environments'], refreshOnState: ['api.activeEnvironment'], refreshOnEvents: ['config.changed'] });
  const { refresh } = scope;
  const save = useCallback(
    async (name: string, value: string) => {
      try {
        const { source } = await invoke<{ source: 'environment' | 'global' }>('api.variables.set', { name, value });
        notify(source === 'global' ? `Updated the global variable ${name}` : `Updated ${name} in the active environment`, 'success');
      } catch (err) {
        throw new Error(toErrorPayload(err).message);
      }
      await refresh();
    },
    [refresh],
  );
  const define = useCallback(
    async (name: string, value: string, target: VariableTarget, secret: boolean) => {
      try {
        const result = await invoke<{ environmentName?: string }>('api.variables.define', { name, value, target, secret });
        const active = scope.data?.environment;
        notify(
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
      const next = await invoke<VariableScope>('api.variables.list', {});
      await refresh();
      return next;
    },
    [refresh, scope.data?.environment],
  );
  return (
    <VariablesProvider value={scope.data} onSave={save} onDefine={define}>
      {children}
    </VariablesProvider>
  );
}
