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
        this.container = document.createElement('div');
        this.container.id = 'toastContainer';
        this.container.className = 'toast-container';
        document.body.appendChild(this.container);
    },
    
    show(message: string, type: ToastType = 'info', duration: number = TOAST_DURATION_MS) {
        if (!this.container) this.init();
        
        // Cap the stack — error storms previously piled toasts indefinitely
        while (this.container && this.container.children.length >= MAX_VISIBLE_TOASTS) {
            this.container.firstElementChild?.remove();
        }

        const toastEl = document.createElement('div');
        toastEl.className = `toast toast-${type}`;
        toastEl.innerText = message;
        
        if (this.container) {
            this.container.appendChild(toastEl);
        }
        
        // Animation end cleanup
        setTimeout(() => {
            toastEl.classList.add('fade-out');
            setTimeout(() => {
                toastEl.remove();
            }, 500);
        }, duration);
    },
    
    error(msg: string) { this.show(msg, 'error', 5000); },
    success(msg: string) { this.show(msg, 'success', 3000); },
    info(msg: string) { this.show(msg, 'info', 3000); }
};
