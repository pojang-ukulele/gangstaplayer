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

// UI Helper for Confirmation Modal
export function showConfirm(title: string, message: string, onYes: () => void): void {
    const modal = document.getElementById('confirmModal');
    if (!modal) return;
    const titleEl = document.getElementById('confirmTitle');
    const msgEl = document.getElementById('confirmMessage');
    const yesBtn = document.getElementById('confirmYes');
    const noBtn = document.getElementById('confirmNo');

    if (titleEl) titleEl.innerText = title;
    if (msgEl) msgEl.innerText = message;
    
    const close = () => { closeModal(modal); };
    
    if (yesBtn) {
        yesBtn.onclick = () => { onYes(); close(); };
    }
    if (noBtn) {
        noBtn.onclick = close;
    }
    openModal(modal);
}
