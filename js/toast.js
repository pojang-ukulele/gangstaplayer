/**
 * Toast Notification System for Gangsta Player Pro 3
 */

export const toast = {
    container: null,
    
    init() {
        this.container = document.createElement('div');
        this.container.id = 'toastContainer';
        this.container.className = 'toast-container';
        document.body.appendChild(this.container);
    },
    
    show(message, type = 'info', duration = 3000) {
        if (!this.container) this.init();
        
        const toastEl = document.createElement('div');
        toastEl.className = `toast toast-${type}`;
        toastEl.innerText = message;
        
        this.container.appendChild(toastEl);
        
        // Animation end cleanup
        setTimeout(() => {
            toastEl.classList.add('fade-out');
            setTimeout(() => {
                toastEl.remove();
            }, 500);
        }, duration);
    },
    
    error(msg) { this.show(msg, 'error', 5000); },
    success(msg) { this.show(msg, 'success', 3000); },
    info(msg) { this.show(msg, 'info', 3000); }
};
