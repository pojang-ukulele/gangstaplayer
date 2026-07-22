/**
 * Modal utilities for Gangsta Player Pro 3
 * Unified modal open/close with focus management.
 * Uses CSS .active class for visibility (instead of inline style.display).
 */

/** Track the last focused element before a modal opened, for focus restoration */
let _lastFocused: HTMLElement | null = null;

/**
 * Opens a modal with focus management.
 * Uses CSS .active class to show the modal.
 */
export function openModal(modal: HTMLElement): void {
    _lastFocused = document.activeElement as HTMLElement;
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    // Focus the first focusable element inside the modal
    const firstFocusable = modal.querySelector<HTMLElement>(
        'button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (firstFocusable) {
        setTimeout(() => firstFocusable.focus(), 50);
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
    if (_lastFocused) {
        _lastFocused.focus();
        _lastFocused = null;
    }
}

/**
 * Opens a modal by element ID with focus management.
 */
export function showModalById(modalId: string): void {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    openModal(modal);
}

/**
 * Closes a modal by element ID with focus restoration.
 */
export function closeModalById(modalId: string): void {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    closeModal(modal);
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
