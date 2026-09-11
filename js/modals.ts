/**
 * Modal utilities for Gangsta Player Pro 3
 * Unified modal open/close with focus management.
 * Uses CSS .active class for visibility (instead of inline style.display).
 */

/** Focus stack for nested modals (crash prompt over settings, etc.) */
// M25: paired entries so closing out of order (click-outside on a lower
// modal) removes the CORRECT modal instead of popping an unrelated top.
const _focusStack: Array<{ modal: HTMLElement; prev: HTMLElement | null }> = [];

function getPlaylistFocusHook(): {
    __ugGetPlaylistFocused?: () => boolean;
    __ugSetPlaylistFocused?: (v: boolean) => void;
} | null {
    try {
        if (typeof window === 'undefined') return null;
        return window as unknown as {
            __ugGetPlaylistFocused?: () => boolean;
            __ugSetPlaylistFocused?: (v: boolean) => void;
        };
    } catch { return null; }
}

function isVisibleFocusable(el: HTMLElement): boolean {
    if ((el as HTMLInputElement).disabled) return false;
    // M24: offsetParent is null for position:fixed — which previously
    // excluded fixed children (sticky modal footers/close buttons) from
    // the trap. Treat fixed as visible.
    try {
        if (el.offsetParent !== null) return true;
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') return true;
        // Fallback: element has layout (open modal content).
        const r = el.getBoundingClientRect();
        return r.width > 0 || r.height > 0;
    } catch { return el.offsetParent !== null; }
}

/**
 * Opens a modal with focus management.
 * Uses CSS .active class to show the modal.
 */
export function openModal(modal: HTMLElement): void {
    // Double-open previously pushed focus twice, unbalancing the stack.
    if (modal.classList.contains('active')) return;
    const prev = (document.activeElement as HTMLElement) || null;
    _focusStack.push({ modal, prev });
    // M21: playlist shortcuts disengage while any modal is open.
    try {
        const hook = getPlaylistFocusHook();
        if (hook?.__ugGetPlaylistFocused && hook?.__ugSetPlaylistFocused) {
            (modal as unknown as Record<string, unknown>).__ugPrevPlaylistFocus =
                hook.__ugGetPlaylistFocused();
            hook.__ugSetPlaylistFocused(false);
        }
    } catch { /* non-browser boot */ }
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    // Focus the first focusable element inside the modal
    const firstFocusable = modal.querySelector<HTMLElement>(
        'button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (firstFocusable) {
        const target = modal;
        setTimeout(() => {
            if (target.classList.contains('active')) {
                try { firstFocusable.focus(); } catch { /* ignore */ }
            }
        }, 50);
    }
    // Focus trap: Tab cycles inside the topmost modal instead of escaping
    // to the deck behind it.
    if (!(modal as any).__ugTrapWired) {
        (modal as any).__ugTrapWired = true;
        modal.addEventListener('keydown', (e) => {
            if (e.key !== 'Tab') return;
            if (!modal.classList.contains('active')) return;
            const focusables = Array.from(
                modal.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')
            ).filter(isVisibleFocusable);
            if (focusables.length === 0) { e.preventDefault(); return; }
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        });
    }
}

/** Topmost open modal in DOM order (last .active wins, not first). */
export function getTopModal(): HTMLElement | null {
    const actives = Array.from(document.querySelectorAll<HTMLElement>('.modal.active'));
    return actives.length ? actives[actives.length - 1] : null;
}

/**
 * Closes a modal with focus restoration.
 * Uses CSS .active class to hide the modal.
 */
export function closeModal(modal: HTMLElement): void {
    // Stray closes previously popped focus that belonged to another modal.
    if (!modal.classList.contains('active')) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    // M25: remove THIS modal's entry, not the stack top, so click-outside
    // on a lower modal can't steal the focus owed to an upper one.
    let prev: HTMLElement | null = null;
    const idx = _focusStack.map(e => e.modal).lastIndexOf(modal);
    if (idx >= 0) {
        const entry = _focusStack[idx];
        prev = entry.prev;
        _focusStack.splice(idx, 1);
    }
    // M21: restore playlist focus captured at open (undefined = hook absent).
    try {
        const saved = (modal as unknown as Record<string, unknown>).__ugPrevPlaylistFocus;
        const hook = getPlaylistFocusHook();
        if (typeof saved === 'boolean' && hook?.__ugSetPlaylistFocused) {
            // Only restore `true` when no other modal is still open.
            if (saved && document.querySelector('.modal.active')) {
                /* keep disengaged while another modal holds the screen */
            } else {
                hook.__ugSetPlaylistFocused(saved);
            }
        }
        delete (modal as unknown as Record<string, unknown>).__ugPrevPlaylistFocus;
    } catch { /* ignore */ }
    // Restore focus to the element that was focused before the modal opened
    // Only steal focus back if the modal still held it (50ms delayed focus
    // in openModal can otherwise yank focus after the user moved on).
    if (prev && document.activeElement && modal.contains(document.activeElement)) {
        try { prev.focus(); } catch { /* ignore */ }
    }
}

// UI Helper for Confirmation Modal (queued — concurrent callers no longer
// clobber each other's onYes; pending confirms run in order).
type ConfirmReq = { title: string; message: string; onYes: () => void | Promise<void>; onNo?: () => void };
const _confirmQueue: ConfirmReq[] = [];
let _confirmOpen = false;

function _drainConfirmQueue(): void {
    if (_confirmOpen) return;
    const next = _confirmQueue.shift();
    if (!next) return;
    const modal = document.getElementById('confirmModal');
    if (!modal) {
        // Missing modal previously wedged the queue — every future confirm hung.
        try { next.onNo?.(); } catch { /* ignore */ }
        setTimeout(_drainConfirmQueue, 0);
        return;
    }
    const titleEl = document.getElementById('confirmTitle');
    const msgEl = document.getElementById('confirmMessage');
    const yesBtn = document.getElementById('confirmYes');
    const noBtn = document.getElementById('confirmNo');

    if (titleEl) titleEl.innerText = next.title;
    if (msgEl) msgEl.innerText = next.message;
    if (!yesBtn || !noBtn) {
        // Partial DOM must not wedge the queue open.
        try { next.onNo?.(); } catch { /* ignore */ }
        setTimeout(_drainConfirmQueue, 0);
        return;
    }
    _confirmOpen = true;

    const close = () => {
        closeModal(modal);
        _confirmOpen = false;
        // Defer drain so the current click stack unwinds first.
        setTimeout(_drainConfirmQueue, 0);
    };

    if (yesBtn) {
        // Async-aware + double-click guard: a second click while an async
        // onYes (crash restore) is in flight previously ran the work twice,
        // and close-then-drain previously raced the pending promise.
        let busy = false;
        yesBtn.onclick = async () => {
            if (busy) return;
            busy = true;
            try { await next.onYes(); } catch { /* caller surfaces via toast */ } finally { close(); }
        };
    }
    if (noBtn) {
        noBtn.onclick = () => { try { next.onNo?.(); } finally { close(); } };
    }
    openModal(modal);
}

export function showConfirm(title: string, message: string, onYes: () => void | Promise<void>, onNo?: () => void): void {
    _confirmQueue.push({ title, message, onYes, onNo });
    _drainConfirmQueue();
}
