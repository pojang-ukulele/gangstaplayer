/**
 * Reactor Core - A minimalist high-performance reactive UI engine
 * Optimized for high-frequency audio application updates.
 */

/**
 * Virtual Scroller Engine
 * Only renders what is visible.
 */
export class VirtualScroller<T> {
    private container: HTMLElement;
    private items: T[];
    private itemHeight: number;
    private renderItem: (item: T, index: number, existing?: HTMLElement) => HTMLElement;
    private overflowEl: HTMLElement;
    private contentEl: HTMLElement;
    private visibleItems: Map<number, HTMLElement> = new Map();
    private resizeObserver: ResizeObserver | null = null;
    private _onScroll: () => void;

    constructor(options: {
        container: HTMLElement;
        items: T[];
        itemHeight: number;
        renderItem: (item: T, index: number, existing?: HTMLElement) => HTMLElement;
    }) {
        this.container = options.container;
        this.items = options.items;
        this.itemHeight = options.itemHeight;
        this.renderItem = options.renderItem;

        // Container setup
        this.container.style.position = 'relative';
        this.container.style.overflowY = 'auto';

        // Overflow element to create physical scroll length
        this.overflowEl = document.createElement('div');
        this.overflowEl.className = 'vs-overflow';
        this.overflowEl.style.position = 'absolute';
        this.overflowEl.style.top = '0';
        this.overflowEl.style.left = '0';
        this.overflowEl.style.width = '1px';
        this.overflowEl.style.visibility = 'hidden';

        // Visible content container
        this.contentEl = document.createElement('div');
        this.contentEl.className = 'vs-content';
        this.contentEl.style.position = 'absolute';
        this.contentEl.style.top = '0';
        this.contentEl.style.left = '0';
        this.contentEl.style.width = '100%';

        this.container.innerHTML = '';
        this.container.appendChild(this.overflowEl);
        this.container.appendChild(this.contentEl);

        this._onScroll = () => this.refresh();
        this.container.addEventListener('scroll', this._onScroll);

        // Without this, resizing/maximizing the window leaves stale viewport
        // math and rows go missing until the next scroll event.
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.refresh());
            this.resizeObserver.observe(this.container);
        }

        this.updateItems(this.items);
    }

    public updateItems(newItems: T[]) {
        this.items = newItems;
        this.overflowEl.style.height = `${this.items.length * this.itemHeight}px`;
        // Clamp scrollTop: a shorter list previously left the viewport blank.
        const maxTop = Math.max(0, this.items.length * this.itemHeight - this.container.clientHeight);
        if (this.container.scrollTop > maxTop) this.container.scrollTop = maxTop;
        this.refresh(true);
    }

    private _refreshing = false;
    public refresh(force = false) {
        if (this._refreshing) return;
        this._refreshing = true;
        try {
        const scrollTop = this.container.scrollTop;
        const viewportHeight = this.container.clientHeight;
        const startIdx = Math.max(0, Math.floor(scrollTop / this.itemHeight) - 5);
        const endIdx = Math.min(this.items.length - 1, Math.ceil((scrollTop + viewportHeight) / this.itemHeight) + 5);

        // Remove items no longer visible
        for (const [idx, el] of Array.from(this.visibleItems)) {
            if (idx < startIdx || idx > endIdx || idx >= this.items.length) {
                el.remove();
                this.visibleItems.delete(idx);
            } else if (force) {
                // Update in place if forced (e.g. selection state changed).
                // Re-assert geometry: reused rows keep stale top/height after
                // reorder/resize if the callback doesn't set them.
                // If the callback returns a NEW node (contract violation),
                // replace instead of orphaning the new node + leaking the old.
                const out = this.renderItem(this.items[idx], idx, el);
                const node = out ?? el;
                if (node !== el) {
                    node.style.position = 'absolute';
                    node.style.top = `${idx * this.itemHeight}px`;
                    node.style.width = '100%';
                    node.style.height = `${this.itemHeight}px`;
                    el.replaceWith(node);
                    this.visibleItems.set(idx, node);
                } else {
                    el.style.position = 'absolute';
                    el.style.top = `${idx * this.itemHeight}px`;
                    el.style.width = '100%';
                    el.style.height = `${this.itemHeight}px`;
                }
            }
        }

        // Add visible items
        for (let i = startIdx; i <= endIdx; i++) {
            if (!this.visibleItems.has(i)) {
                const el = this.renderItem(this.items[i], i);
                el.style.position = 'absolute';
                el.style.top = `${i * this.itemHeight}px`;
                el.style.width = '100%';
                el.style.height = `${this.itemHeight}px`;
                this.contentEl.appendChild(el);
                this.visibleItems.set(i, el);
            }
        }
        } finally { this._refreshing = false; }
    }

    public scrollTo(index: number) {
        if (!Number.isFinite(index)) return;
        const clamped = Math.max(0, Math.min(this.items.length - 1, Math.floor(index)));
        this.container.scrollTop = clamped * this.itemHeight;
    }

    /** Destroy the scroller — cleans up listeners and DOM. */
    public destroy(): void {
        this.container.removeEventListener('scroll', this._onScroll);
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        this.visibleItems.clear();
        this.container.innerHTML = '';
    }
}
