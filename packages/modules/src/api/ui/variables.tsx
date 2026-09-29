import { VariablesProvider, useInvoke, type VariableScope } from '@quiver/ui';
import type { ReactNode } from 'react';

/** Supplies the variables in effect (global, then the active environment) to the fields inside, for highlighting and hover. */
export function ApiVariablesProvider({ children }: { children: ReactNode }) {
  const scope = useInvoke<VariableScope>('api.variables.list', {}, { refreshOn: ['environments'], refreshOnState: ['api.activeEnvironment'], refreshOnEvents: ['config.changed'] });
  return <VariablesProvider value={scope.data}>{children}</VariablesProvider>;
}
