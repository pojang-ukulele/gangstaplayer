/**
 * Toast Notification System for Gangsta Player Pro 3
 */

export type ToastType = 'info' | 'error' | 'success';

import { TOAST_DURATION_MS } from './constants';

interface ToastSystem {
    container: HTMLElement | null;
    init(): void;
    show(message: string, type?: ToastType, duration?: number): void;
    error(msg: string): void;
    success(msg: string): void;
    info(msg: string): void;
}

const MAX_VISIBLE_TOASTS = 6;
const MAX_TOAST_LENGTH = 500;
/** Early-boot queue: show() before document.body previously dropped critical
 * errors onto a detached node. Queued here, flushed on init(). */
const pendingToasts: Array<{ message: string; type: ToastType; duration: number }> = [];

export const toast: ToastSystem = {
    container: null,

    init() {
        if (this.container && document.body.contains(this.container)) return;
        if (!document.body) return;
        this.container = document.createElement('div');
        this.container.id = 'toastContainer';
        this.container.className = 'toast-container';
        this.container.setAttribute('role', 'status');
        this.container.setAttribute('aria-live', 'polite');
        document.body.appendChild(this.container);
        // Flush early-boot queue (bounded — a boot storm can't pile unbounded).
        try {
            const queued = pendingToasts.splice(0, MAX_VISIBLE_TOASTS);
            pendingToasts.length = 0;
            for (const q of queued) this.show(q.message, q.type, q.duration);
        } catch { /* ignore */ }
    },

    show(message: string, type: ToastType = 'info', duration: number = TOAST_DURATION_MS) {
        const clean = typeof message === 'string' ? message.slice(0, MAX_TOAST_LENGTH) : String(message ?? '').slice(0, MAX_TOAST_LENGTH);
        if (!this.container) this.init();
        if (!this.container) {
            // Still no body — queue instead of dropping on a detached node.
            if (pendingToasts.length < MAX_VISIBLE_TOASTS) {
                pendingToasts.push({ message: clean, type, duration });
            }
            return;
        }
        // Dedup across the whole queue (not just the last toast): repeat
        // storms coalesce into a counted badge instead of flooding the stack.
        try {
            const kids = this.container ? Array.from(this.container.children) as HTMLElement[] : [];
            for (const kid of kids) {
                if (kid.textContent?.replace(/ \(x\d+\)$/, '') === clean && kid.classList.contains(`toast-${type}`)) {
                    const rec = kid as unknown as Record<string, number>;
                    const t = Date.now();
                    if (t - (rec.__ugToastAt || 0) < 1500) {
                        const n = (rec.__ugToastCount || 1) + 1;
                        rec.__ugToastCount = n;
                        rec.__ugToastAt = t;
                        kid.innerText = n > 1 ? `${clean} (x${n})` : clean;
                        // Re-arm the fade so the coalesced toast stays visible.
                        const oldTimer = (kid as any).__ugToastTimer;
                        if (oldTimer) clearTimeout(oldTimer);
                        const oldFade = (kid as any).__ugToastFadeTimer;
                        if (oldFade) clearTimeout(oldFade);
                        const timer = setTimeout(() => {
                            if (!kid.isConnected) return;
                            kid.classList.add('fade-out');
                            const fade = setTimeout(() => {
                                if (kid.isConnected) kid.remove();
                            }, 500);
                            (kid as any).__ugToastFadeTimer = fade;
                        }, duration);
                        (kid as any).__ugToastTimer = timer;
                        return;
                    }
                }
            }
        } catch { /* ignore */ }

        // Cap the stack — error storms previously piled toasts indefinitely.
        // Clear evicted toasts' timers so they don't fire on detached nodes.
        while (this.container && this.container.children.length >= MAX_VISIBLE_TOASTS) {
            const first = this.container.firstElementChild as HTMLElement | null;
            try {
                const t = (first as any)?.__ugToastTimer;
                if (t) clearTimeout(t);
                const t2 = (first as any)?.__ugToastFadeTimer;
                if (t2) clearTimeout(t2);
            } catch { /* ignore */ }
            first?.remove();
        }

        const toastEl = document.createElement('div');
        toastEl.className = `toast toast-${type}`;
        toastEl.innerText = clean;

        if (this.container) {
            this.container.appendChild(toastEl);
        }

        // Animation end cleanup
        (toastEl as unknown as Record<string, number>).__ugToastAt = Date.now();
        (toastEl as unknown as Record<string, number>).__ugToastCount = 1;
        const timer = setTimeout(() => {
            if (!toastEl.isConnected) return;
            toastEl.classList.add('fade-out');
            const fade = setTimeout(() => {
                if (toastEl.isConnected) toastEl.remove();
            }, 500);
            (toastEl as any).__ugToastFadeTimer = fade;
        }, duration);
        (toastEl as any).__ugToastTimer = timer;
    },
    
    error(msg: string) { this.show(msg, 'error', 5000); },
    success(msg: string) { this.show(msg, 'success', 3000); },
    info(msg: string) { this.show(msg, 'info', 3000); }
};
