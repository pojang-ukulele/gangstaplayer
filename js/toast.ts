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
    },
    
    show(message: string, type: ToastType = 'info', duration: number = TOAST_DURATION_MS) {
        if (!this.container) this.init();
        // Dedup: error storms (N decode failures) previously flooded the stack.
        try {
            const last = this.container?.lastElementChild as HTMLElement | null;
            if (last && last.textContent === message && last.classList.contains(`toast-${type}`)) {
                const t = Date.now();
                const prev = (last as unknown as Record<string, number>).__ugToastAt || 0;
                if (t - prev < 1000) return;
                (last as unknown as Record<string, number>).__ugToastAt = t;
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
        toastEl.innerText = message;

        if (this.container) {
            this.container.appendChild(toastEl);
        }

        // Animation end cleanup
        (toastEl as unknown as Record<string, number>).__ugToastAt = Date.now();
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
