/**
 * Toast Notification System for Gangsta Player Pro 3
 */

export type ToastType = 'info' | 'error' | 'success';

interface ToastSystem {
    container: HTMLElement | null;
    init(): void;
    show(message: string, type?: ToastType, duration?: number): void;
    error(msg: string): void;
    success(msg: string): void;
    info(msg: string): void;
}

export const toast: ToastSystem = {
    container: null,
    
    init() {
        this.container = document.createElement('div');
        this.container.id = 'toastContainer';
        this.container.className = 'toast-container';
        document.body.appendChild(this.container);
    },
    
    show(message: string, type: ToastType = 'info', duration: number = 3000) {
        if (!this.container) this.init();
        
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
