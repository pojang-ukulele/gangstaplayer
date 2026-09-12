/**
 * Reactor Core - A minimalist high-performance reactive UI engine
 * Optimized for high-frequency audio application updates.
 */

import { Disposable } from '../utils';

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
    private readonly disposables = new Disposable();
    private _onScroll: () => void;

    private keyOf: ((item: T, index: number) => string) | null;

    constructor(options: {
        container: HTMLElement;
        items: T[];
        itemHeight: number;
        renderItem: (item: T, index: number, existing?: HTMLElement) => HTMLElement;
        /**
         * Stable row identity (e.g. track id). When present, a visible node
         * whose key no longer matches the item at its index is discarded
         * and recreated instead of being re-rendered in place — index reuse
         * after reorder/filter previously showed stale rows for a frame.
         */
        keyOf?: (item: T, index: number) => string;
    }) {
        this.container = options.container;
        this.items = options.items;
        this.itemHeight = options.itemHeight;
        this.renderItem = options.renderItem;
        this.keyOf = typeof options.keyOf === 'function' ? options.keyOf : null;

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
        this.disposables.on(this.container, 'scroll', this._onScroll);

        // Without this, resizing/maximizing the window leaves stale viewport
        // math and rows go missing until the next scroll event.
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.refresh());
            const ro = this.resizeObserver;
            const target = this.container;
            try { ro.observe(target); } catch { /* ignore */ }
            this.disposables.add(() => {
                try { ro.disconnect(); } catch { /* ignore */ }
            });
        }

        this.updateItems(this.items);
    }

    public updateItems(newItems: T[]) {
        // Defensive copy: callers mutating the array post-update previously
        // corrupted scroller length/geometry with a stale blank viewport.
        this.items = Array.isArray(newItems) ? [...newItems] : [];
        this.overflowEl.style.height = `${this.items.length * this.itemHeight}px`;
        // Clamp scrollTop: a shorter list previously left the viewport blank.
        const maxTop = Math.max(0, this.items.length * this.itemHeight - this.container.clientHeight);
        if (this.container.scrollTop > maxTop) this.container.scrollTop = maxTop;
        this.refresh(true);
    }

    private _refreshing = false;
    private _refreshQueued = false;
    private _refreshQueuedForce = false;
    public refresh(force = false) {
        // M33: coalesce re-entrant refreshes instead of silently dropping them
        // (renderItem -> state.update -> refresh during a refresh lost a frame).
        if (this._refreshing) {
            this._refreshQueued = true;
            if (force) this._refreshQueuedForce = true;
            return;
        }
        this._refreshing = true;
        try {
        const scrollTop = this.container.scrollTop;
        const viewportHeight = this.container.clientHeight;
        const startIdx = Math.max(0, Math.floor(scrollTop / this.itemHeight) - 5);
        const endIdx = Math.min(this.items.length - 1, Math.ceil((scrollTop + viewportHeight) / this.itemHeight) + 5);

        // Key of the item currently at an index ('': unknown when keyless).
        const keyAt = (idx: number): string => {
            if (!this.keyOf) return '';
            try {
                const item = this.items[idx];
                if (item === undefined) return '';
                return this.keyOf(item, idx) ?? '';
            } catch { return ''; }
        };
        // Remove items no longer visible — or whose key moved away (reorder
        // swapped in a different item under a recycled index).
        for (const [idx, el] of Array.from(this.visibleItems)) {
            if (idx < startIdx || idx > endIdx || idx >= this.items.length) {
                el.remove();
                this.visibleItems.delete(idx);
            } else if (this.keyOf && (el as HTMLElement).dataset.vsKey !== undefined && (el as HTMLElement).dataset.vsKey !== keyAt(idx)) {
                el.remove();
                this.visibleItems.delete(idx);
            } else if (force) {
                // Update in place if forced (e.g. selection state changed).
                // Re-assert geometry: reused rows keep stale top/height after
                // reorder/resize if the callback doesn't set them.
                // If the callback returns a NEW node (contract violation),
                // replace instead of orphaning the new node + leaking the old.
                // A throwing renderer previously left half-pruned rows and
                // recursed into the same throw via the queued refresh.
                let out: HTMLElement | undefined;
                try {
                    out = this.renderItem(this.items[idx], idx, el);
                } catch {
                    try { el.remove(); } catch { /* ignore */ }
                    this.visibleItems.delete(idx);
                    continue;
                }
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
                    if (this.keyOf) {
                        try { el.dataset.vsKey = keyAt(idx); } catch { /* ignore */ }
                    }
                }
            }
        }

        // Add visible items
        for (let i = startIdx; i <= endIdx; i++) {
            if (!this.visibleItems.has(i)) {
                let el: HTMLElement;
                try {
                    el = this.renderItem(this.items[i], i);
                } catch {
                    continue; // one bad row must not blank the viewport
                }
                el.style.position = 'absolute';
                el.style.top = `${i * this.itemHeight}px`;
                el.style.width = '100%';
                el.style.height = `${this.itemHeight}px`;
                if (this.keyOf) {
                    try { el.dataset.vsKey = keyAt(i); } catch { /* ignore */ }
                }
                this.contentEl.appendChild(el);
                this.visibleItems.set(i, el);
            }
        }
        } finally { this._refreshing = false; }
        if (this._refreshQueued) {
            const f = this._refreshQueuedForce;
            this._refreshQueued = false;
            this._refreshQueuedForce = false;
            this.refresh(f);
        }
    }

    public scrollTo(index: number) {
        if (!Number.isFinite(index)) return;
        // Empty-list guard: length - 1 is -1 and the old clamp resolved to
        // index 0 on an empty viewport (scrollTop write into a void list).
        if (this.items.length === 0) return;
        const clamped = Math.max(0, Math.min(this.items.length - 1, Math.floor(index)));
        this.container.scrollTop = clamped * this.itemHeight;
    }

    /** Destroy the scroller — cleans up listeners and DOM. */
    public destroy(): void {
        this.disposables.dispose();
        this.resizeObserver = null;
        this.visibleItems.clear();
        this.container.innerHTML = '';
    }
}
