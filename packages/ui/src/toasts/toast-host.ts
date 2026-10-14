import { Component, inject } from '@angular/core';
import { CircleAlert, CircleCheck, Info, X } from 'lucide';
import { Icon } from '../icon/icon';
import { Toasts } from './toasts';

const ICONS = { info: Info, success: CircleCheck, error: CircleAlert };

/** Renders the toasts. Mount once in the shell. */
@Component({
  selector: 'q-toast-host',
  imports: [Icon],
  templateUrl: './toast-host.html',
  host: { class: 'contents' },
})
export class ToastHost {
  protected readonly toasts = inject(Toasts);
  protected readonly icons = ICONS;
  protected readonly closeIcon = X;
}
