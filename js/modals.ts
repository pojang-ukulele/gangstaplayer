/**
 * Modal utilities for Gangsta Player Pro 3
 * Unified modal open/close with focus management.
 * Uses CSS .active class for visibility (instead of inline style.display).
 */

/** Focus stack for nested modals (crash prompt over settings, etc.) */
const _focusStack: HTMLElement[] = [];

/**
 * Opens a modal with focus management.
 * Uses CSS .active class to show the modal.
 */
export function openModal(modal: HTMLElement): void {
    // Double-open previously pushed focus twice, unbalancing the stack.
    if (modal.classList.contains('active')) return;
    _focusStack.push(document.activeElement as HTMLElement);
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
    // Restore focus to the element that was focused before the modal opened
    const prev = _focusStack.pop();
    // Only steal focus back if the modal still held it (50ms delayed focus
    // in openModal can otherwise yank focus after the user moved on).
    if (prev && document.activeElement && modal.contains(document.activeElement)) {
        try { prev.focus(); } catch { /* ignore */ }
    }
}

// UI Helper for Confirmation Modal (queued — concurrent callers no longer
// clobber each other's onYes; pending confirms run in order).
type ConfirmReq = { title: string; message: string; onYes: () => void; onNo?: () => void };
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
        yesBtn.onclick = () => { try { next.onYes(); } finally { close(); } };
    }
    if (noBtn) {
        noBtn.onclick = () => { try { next.onNo?.(); } finally { close(); } };
    }
    openModal(modal);
}

export function showConfirm(title: string, message: string, onYes: () => void, onNo?: () => void): void {
    _confirmQueue.push({ title, message, onYes, onNo });
    _drainConfirmQueue();
}
