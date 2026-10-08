import { Component, computed, effect, input, output, untracked } from '@angular/core';
import { KUBE_CAN_I_VERBS, KUBE_OUTPUTS, KUBE_RESOURCE_TYPES, KUBE_TAIL_MAX, closestName, type KubeField } from '@quiver/core';
import { Checkbox, Input, Select, cn } from '@quiver/ui';
import { KubeFieldBox } from './kube-field-box';
import type { KubeLookups } from './kube-lookups';
import type { KubeValues } from './kube-query-model';

type FieldValue = KubeValues[string];

/** One typed field of a Kubernetes operation, with pickers filled from the cluster where they help. */
@Component({
  selector: 'q-kube-field-editor',
  imports: [Checkbox, Input, KubeFieldBox, Select],
  templateUrl: './kube-field-editor.html',
  host: { class: 'contents' },
})
export class KubeFieldEditor {
  readonly field = input.required<KubeField>();
  readonly values = input.required<KubeValues>();
  readonly error = input<string>();
  readonly lookups = input.required<KubeLookups>();
  /** The namespace the pickers look in. */
  readonly namespace = input.required<string>();
  readonly changed = output<FieldValue>();

  protected readonly resourceTypes = KUBE_RESOURCE_TYPES;
  protected readonly verbs = KUBE_CAN_I_VERBS;
  protected readonly outputs = KUBE_OUTPUTS;
  protected readonly tailPlaceholder = `1-${KUBE_TAIL_MAX}`;
  /** Pods, names and deployments share one layout: a text field with the matching names as suggestions. */
  protected readonly layout = computed(() => {
    const kind = this.field().kind;
    return kind === 'pod' || kind === 'name' || kind === 'deployment' ? 'names' : kind;
  });
  protected readonly value = computed(() => this.values()[this.field().key]);
  protected readonly text = computed(() => {
    const value = this.value();
    return value === undefined ? '' : String(value);
  });
  protected readonly testId = computed(() => `kube-field-${this.field().key}`);
  protected readonly listId = computed(() => `kube-${this.field().key}-options`);
  protected readonly inputClass = computed(() => cn('font-mono text-xs', this.error() && 'border-danger focus:border-danger focus:ring-danger/30'));
  /** Names for the pod, name and deployment fields. */
  private readonly nameResource = computed(() => {
    const kind = this.field().kind;
    if (kind === 'pod') return 'pods';
    if (kind === 'deployment') return 'deployments';
    if (kind === 'name') return String(this.values()['resource'] ?? '');
    return '';
  });
  protected readonly names = computed(() => {
    const resource = this.nameResource();
    return resource ? this.lookups().names(resource, this.namespace()) : [];
  });
  private readonly pod = computed(() => {
    const pod = this.values()['pod'];
    return typeof pod === 'string' ? pod.trim() : '';
  });
  /** The pod's containers, plus the one typed when the pod is not known yet. */
  protected readonly containers = computed(() => {
    const pod = this.pod();
    const options = pod ? this.lookups().containers(this.namespace(), pod) : [];
    const value = this.value();
    return [...new Set([...options, ...(typeof value === 'string' && value ? [value] : [])])];
  });
  /** kubectl answers "No resources found" with exit 0 for a namespace that does not exist, so say so before running. */
  protected readonly unknownNamespace = computed(() => {
    if (this.field().kind !== 'namespace') return false;
    const value = this.value();
    const typed = typeof value === 'string' ? value.trim() : '';
    const namespaces = this.lookups().namespaces();
    return !this.values()['allNamespaces'] && typed !== '' && namespaces.length > 0 && !namespaces.includes(typed);
  });
  protected readonly suggestion = computed(() => {
    if (!this.unknownNamespace()) return null;
    return closestName(String(this.value()).trim(), this.lookups().namespaces());
  });

  constructor() {
    effect(() => {
      const resource = this.nameResource();
      const namespace = this.namespace();
      if (resource) untracked(() => this.lookups().loadNames(resource, namespace));
    });
    effect(() => {
      const pod = this.pod();
      const namespace = this.namespace();
      if (this.field().kind === 'container' && pod) untracked(() => this.lookups().loadContainers(namespace, pod));
    });
  }

  /** Text fields: an emptied field is unset. */
  protected typed(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.changed.emit(value === '' ? undefined : value);
  }

  /** Selects with an empty choice: picking it unsets the field. */
  protected picked(event: Event): void {
    this.changed.emit((event.target as HTMLSelectElement).value || undefined);
  }

  protected pickedVerb(event: Event): void {
    this.changed.emit((event.target as HTMLSelectElement).value);
  }

  protected ticked(event: Event): void {
    this.changed.emit((event.target as HTMLInputElement).checked || undefined);
  }

  protected useSuggestion(name: string): void {
    this.changed.emit(name);
  }
}
