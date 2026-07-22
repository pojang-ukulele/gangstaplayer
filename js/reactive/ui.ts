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
    private disposables: Map<number, () => void> = new Map();
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
        this.updateItems(this.items);
    }

    public updateItems(newItems: T[]) {
        this.items = newItems;
        this.overflowEl.style.height = `${this.items.length * this.itemHeight}px`;
        this.refresh(true);
    }

    public refresh(force = false) {
        const scrollTop = this.container.scrollTop;
        const viewportHeight = this.container.clientHeight;
        const startIdx = Math.max(0, Math.floor(scrollTop / this.itemHeight) - 5);
        const endIdx = Math.min(this.items.length - 1, Math.ceil((scrollTop + viewportHeight) / this.itemHeight) + 5);

        // Remove items no longer visible
        for (const [idx, el] of this.visibleItems) {
            if (idx < startIdx || idx > endIdx || idx >= this.items.length) {
                // Clean up row-level disposables before removing the element
                const dispose = this.disposables.get(idx);
                if (dispose) { try { dispose(); } catch { /* ignore */ } this.disposables.delete(idx); }
                el.remove();
                this.visibleItems.delete(idx);
            } else if (force) {
                // Update in place if forced (e.g. selection state changed)
                this.renderItem(this.items[idx], idx, el);
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
    }

    public scrollTo(index: number) {
        this.container.scrollTop = index * this.itemHeight;
    }

    /**
     * Register a cleanup callback for a visible row index.
     * Called automatically when the row scrolls out of view.
     */
    public registerDisposable(index: number, cleanup: () => void): void {
        this.disposables.set(index, cleanup);
    }

    /** Destroy the scroller — cleans up all disposables and DOM. */
    public destroy(): void {
        this.container.removeEventListener('scroll', this._onScroll);
        for (const [, cleanup] of this.disposables) {
            try { cleanup(); } catch { /* ignore */ }
        }
        this.disposables.clear();
        this.visibleItems.clear();
        this.container.innerHTML = '';
    }
}
