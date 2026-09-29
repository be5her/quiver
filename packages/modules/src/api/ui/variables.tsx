import { toErrorPayload } from '@quiver/core';
import { VariablesProvider, invoke, notify, useInvoke, type VariableScope } from '@quiver/ui';
import { useCallback, type ReactNode } from 'react';

/**
 * Supplies the variables in effect (global, then the active environment) to the fields inside,
 * for highlighting and hover, and lets the hover card change a value where it is defined.
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
  return (
    <VariablesProvider value={scope.data} onSave={save}>
      {children}
    </VariablesProvider>
  );
}
