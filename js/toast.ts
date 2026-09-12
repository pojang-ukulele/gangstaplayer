/**
 * Toast Notification System for Gangsta Player Pro 3
 */

export type ToastType = 'info' | 'error' | 'success';

import { TOAST_DURATION_MS } from './constants';
import { logger } from './logger';

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
const MIN_TOAST_MS = 1000;
const MAX_TOAST_MS = 15000;
const FADE_OUT_MS = 500;

/** Clamp to a finite display duration — Infinity/NaN/<=0 previously armed a
 * never-firing (or instant) timer and left stale toasts pinned. */
function clampDuration(d: unknown): number {
    const n = typeof d === 'number' ? d : Number(d);
    if (!Number.isFinite(n) || n <= 0) return TOAST_DURATION_MS;
    return Math.min(MAX_TOAST_MS, Math.max(MIN_TOAST_MS, Math.floor(n)));
}

/** Persist evicted error toasts so capping the stack never loses evidence. */
function persistEvicted(el: HTMLElement | null): void {
    try {
        if (!el || !el.classList.contains('toast-error')) return;
        const text = (el as unknown as { __ugToastFull?: string }).__ugToastFull
            ?? el.textContent ?? '(toast)';
        try { logger.error(`[Toast] evicted error toast (cap ${MAX_VISIBLE_TOASTS}): ${String(text).slice(0, 300)}`); }
        catch { try { console.error('[Toast] evicted error toast:', text); } catch { /* ignore */ } }
    } catch { /* ignore */ }
}
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
        // Never block the deck/modals: toasts are display-only.
        try { this.container.style.pointerEvents = 'none'; } catch { /* ignore */ }
        document.body.appendChild(this.container);
        // Flush early-boot queue (bounded — a boot storm can't pile unbounded).
        try {
            const queued = pendingToasts.splice(0, MAX_VISIBLE_TOASTS);
            pendingToasts.length = 0;
            for (const q of queued) this.show(q.message, q.type, q.duration);
        } catch { /* ignore */ }
    },

    show(message: string, type: ToastType = 'info', duration: number = TOAST_DURATION_MS) {
        const full = typeof message === 'string' ? message : String(message ?? '');
        const clean = full.slice(0, MAX_TOAST_LENGTH);
        const life = clampDuration(duration);
        if (!this.container) this.init();
        if (!this.container) {
            // Still no body — queue instead of dropping on a detached node.
            if (pendingToasts.length < MAX_VISIBLE_TOASTS) {
                pendingToasts.push({ message: clean, type, duration: life });
            }
            return;
        }
        // Dedup across the whole queue (not just the last toast): repeat
        // storms coalesce into a counted badge instead of flooding the stack.
        // Distinct filenames never merge: the key is the FULL untruncated
        // message + type (truncated display text alone would fuse two long
        // paths sharing a 500-char prefix).
        try {
            const kids = this.container ? Array.from(this.container.children) as HTMLElement[] : [];
            for (const kid of kids) {
                const kidFull = (kid as unknown as { __ugToastFull?: string }).__ugToastFull
                    ?? kid.textContent?.replace(/ \(x\d+\)$/, '');
                if (kidFull === full && kid.classList.contains(`toast-${type}`)) {
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
                            }, FADE_OUT_MS);
                            (kid as any).__ugToastFadeTimer = fade;
                        }, life);
                        (kid as any).__ugToastTimer = timer;
                        return;
                    }
                }
            }
        } catch { /* ignore */ }

        // Cap the stack — error storms previously piled toasts indefinitely.
        // Clear evicted toasts' timers so they don't fire on detached nodes.
        // Evicted errors persist to the log so the cap never loses evidence.
        while (this.container && this.container.children.length >= MAX_VISIBLE_TOASTS) {
            const first = this.container.firstElementChild as HTMLElement | null;
            try {
                const t = (first as any)?.__ugToastTimer;
                if (t) clearTimeout(t);
                const t2 = (first as any)?.__ugToastFadeTimer;
                if (t2) clearTimeout(t2);
            } catch { /* ignore */ }
            persistEvicted(first);
            first?.remove();
        }

        const toastEl = document.createElement('div');
        toastEl.className = `toast toast-${type}`;
        toastEl.innerText = clean;
        try { (toastEl as unknown as { __ugToastFull?: string }).__ugToastFull = full; } catch { /* ignore */ }
        try { toastEl.style.pointerEvents = 'none'; } catch { /* ignore */ }

        if (this.container) {
            this.container.appendChild(toastEl);
        }

        // Animation end cleanup (fade timing matches CSS toast-out 0.5s).
        (toastEl as unknown as Record<string, number>).__ugToastAt = Date.now();
        (toastEl as unknown as Record<string, number>).__ugToastCount = 1;
        const timer = setTimeout(() => {
            if (!toastEl.isConnected) return;
            toastEl.classList.add('fade-out');
            const fade = setTimeout(() => {
                if (toastEl.isConnected) toastEl.remove();
            }, FADE_OUT_MS);
            (toastEl as any).__ugToastFadeTimer = fade;
        }, life);
        (toastEl as any).__ugToastTimer = timer;
    },
    
    error(msg: string) { this.show(msg, 'error', 5000); },
    success(msg: string) { this.show(msg, 'success', 3000); },
    info(msg: string) { this.show(msg, 'info', 3000); }
};
