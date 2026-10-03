export type ClassValue = string | false | null | undefined | 0;

/**
 * Joins the truthy class names, for `[class]` bindings built in code. Plain joining without
 * Tailwind merging, so a later class does not override an earlier one.
 */
export function cn(...inputs: ClassValue[]): string {
  return inputs.filter(Boolean).join(' ');
}
