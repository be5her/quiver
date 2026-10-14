import { Directive, computed, input } from '@angular/core';
import { REDIS_TYPE_COLORS } from './db-format';

/** The type of a Redis key as a coloured badge: `<span [qRedisType]="key.type"></span>`. */
@Directive({
  selector: 'span[qRedisType]',
  host: { '[class]': 'classes()', '[textContent]': 'qRedisType()' },
})
export class RedisTypeBadge {
  readonly qRedisType = input.required<string>();

  protected readonly classes = computed(
    () => `inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium bg-elevated text-muted w-12 justify-center font-mono text-[10px] ${REDIS_TYPE_COLORS[this.qRedisType()] ?? ''}`,
  );
}
