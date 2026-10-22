import { z } from 'zod';

/**
 * Value patterns shared by the read-only query catalogue (`kube.ts`) and the write actions
 * (`kube-actions.ts`), so both validate names the same way and neither imports the other.
 */

/** DNS-1123 label: namespaces and container names. */
export const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** DNS-1123 subdomain: object names (pods, deployments, nodes, ...). */
export const DNS1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
/** Teleport Kubernetes cluster names as `tsh kube ls` prints them. */
export const KUBE_CLUSTER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const noDash = (v: string) => !v.startsWith('-');

/** A string field: not empty, bounded, never starting with `-`, matching `re`. */
export function kubePattern(re: RegExp, max: number, what: string) {
  return z
    .string()
    .min(1, `${what} is empty`)
    .max(max, `${what} is longer than ${max} characters`)
    .refine(noDash, `${what} must not start with "-"`)
    .regex(re, `${what} is not valid`);
}
