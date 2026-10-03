import { Directive, computed, inject, input, type Signal } from '@angular/core';

/** One variable a `{{name}}` can reach, as the host's `api.variables.list` returns it. */
export interface VariableInfo {
  name: string;
  /** Null for built-in dynamic variables, which get a new value on every send. */
  value: string | null;
  secret: boolean;
  source: 'global' | 'environment' | 'dynamic';
  overridesGlobal?: boolean;
  help?: string;
}

export interface VariableScope {
  environment: { id: string; name: string } | null;
  /** Every environment of the workspace, where an undefined variable can be defined. */
  environments?: { id: string; name: string }[];
  variables: VariableInfo[];
}

/** Where a new variable goes: an environment of the workspace or the global variables. */
export type VariableTarget = { kind: 'environment'; id: string } | { kind: 'global' };

/** Changes the value `{{name}}` resolves to, where it is defined. */
export type SaveVariable = (name: string, value: string) => Promise<void>;
/** Defines `{{name}}` in the chosen place and returns the variables in effect afterwards. */
export type DefineVariable = (name: string, value: string, target: VariableTarget, secret: boolean) => Promise<VariableScope>;

/** The variables in reach, plus how to change or add one when the provider allows it. */
export interface VariableContext extends VariableScope {
  save?: SaveVariable;
  define?: DefineVariable;
}

/**
 * Where the variables in reach come from. The variable input, the key/value editor and the code
 * editor inject it from their surroundings; a directive provides it, e.g. `[qVariables]` below, or a
 * module's own provider that loads its variables.
 */
export abstract class VariableSource {
  abstract readonly context: Signal<VariableContext | null>;
}

/**
 * Makes `{{variables}}` inside the variable input, the key/value editor and the code editor
 * highlighted, with their value on hover: `<div [qVariables]="scope" [variablesSave]="save">`.
 * Outside it those components behave as plain inputs. With `variablesSave`, the hover card can
 * also edit a value, and with `variablesDefine` define a missing one.
 */
@Directive({ selector: '[qVariables]', providers: [{ provide: VariableSource, useExisting: VariablesProvider }] })
export class VariablesProvider implements VariableSource {
  readonly qVariables = input<VariableScope | null | undefined>();
  readonly variablesSave = input<SaveVariable>();
  readonly variablesDefine = input<DefineVariable>();

  readonly context = computed<VariableContext | null>(() => {
    const scope = this.qVariables();
    return scope ? { ...scope, save: this.variablesSave(), define: this.variablesDefine() } : null;
  });
}

/** The variables of the nearest variable source around the caller, or null outside one. */
export function injectVariables(): Signal<VariableContext | null> {
  const source = inject(VariableSource, { optional: true });
  return source ? source.context : computed(() => null);
}

export function lookupVariable(scope: VariableScope, name: string): VariableInfo | undefined {
  return scope.variables.find((v) => v.name === name);
}
