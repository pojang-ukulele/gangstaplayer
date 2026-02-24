/**
 * Shared utility functions
 */

/**
 * Standard debounce utility
 */
export function debounce<T extends (...args: any[]) => any>(fn: T, wait: number): (...args: Parameters<T>) => void {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return function(this: any, ...args: Parameters<T>) {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => fn.apply(this, args), wait);
    };
}

/**
 * Standard throttle utility
 */
export function throttle<T extends (...args: any[]) => any>(fn: T, wait: number): (...args: Parameters<T>) => void {
    let lastTime = 0;
    return function(this: any, ...args: Parameters<T>) {
        const now = Date.now();
        if (now - lastTime >= wait) {
            lastTime = now;
            fn.apply(this, args);
        }
    };
}
