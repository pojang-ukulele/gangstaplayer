/**
 * Gate-4: single Escape owner for queued confirms.
 *
 * Regression: js/main.ts setupGlobalKeyboardShortcuts and
 * js/modals.ts ensureEscapeHandler BOTH answered document Escape by
 * clicking #confirmNo without stopPropagation, so one Esc could answer
 * No twice on queued confirms. Oracle decision: main.ts is the single
 * Escape owner; modals.ts installs no document Escape handler.
 *
 * This test queues 2 confirms, fires a SINGLE Esc exactly the way the
 * main.ts owner does (topmost modal check + one #confirmNo click), and
 * proves exactly one No is answered while the second confirm stays
 * visible/pending.
 */

// --- Minimal fake DOM (node test env has no jsdom) ---
class FakeClassList {
    private set = new Set<string>();
    add(c: string): void { this.set.add(c); }
    remove(c: string): void { this.set.delete(c); }
    contains(c: string): boolean { return this.set.has(c); }
}

class FakeEl {
    id: string;
    classList = new FakeClassList();
    innerText = '';
    onclick: (() => void) | null = null;
    dataset: Record<string, string> = {};
    private listeners: Record<string, Array<(e: unknown) => void>> = {};
    __ugTrapWired?: boolean;
    constructor(id: string) { this.id = id; }
    setAttribute(_k: string, _v: string): void { /* noop */ }
    getAttribute(_k: string): string | null { return null; }
    addEventListener(t: string, h: (e: unknown) => void): void {
        (this.listeners[t] ??= []).push(h);
    }
    removeEventListener(_t: string, _h: (e: unknown) => void): void { /* noop */ }
    click(): void { try { this.onclick?.(); } catch { /* ignore */ } }
    focus(): void { /* noop */ }
    contains(_other: unknown): boolean { return false; }
    querySelector(_sel: string): FakeEl | null { return null; }
    querySelectorAll(_sel: string): FakeEl[] { return []; }
    getBoundingClientRect(): { width: number; height: number } {
        return { width: 0, height: 0 };
    }
    get offsetParent(): unknown { return null; }
}

const confirmModal = new FakeEl('confirmModal');
const titleEl = new FakeEl('confirmTitle');
const msgEl = new FakeEl('confirmMessage');
const yesBtn = new FakeEl('confirmYes');
const noBtn = new FakeEl('confirmNo');
const byId: Record<string, FakeEl> = {
    confirmModal, confirmTitle: titleEl, confirmMessage: msgEl, confirmYes: yesBtn, confirmNo: noBtn,
};

const docKeydownHandlers: Array<(e: unknown) => void> = [];
const mockDocument = {
    activeElement: null as unknown,
    getElementById: jest.fn((id: string) => byId[id] ?? null),
    querySelector: jest.fn((sel: string) => {
        if (sel === '.modal.active') {
            return confirmModal.classList.contains('active') ? confirmModal : null;
        }
        return null;
    }),
    querySelectorAll: jest.fn((sel: string) => {
        if (sel === '.modal.active' || sel === '.context-menu:not(.hidden), .context-submenu:not(.hidden)') {
            return confirmModal.classList.contains('active') ? [confirmModal] : [];
        }
        return [];
    }),
    addEventListener: jest.fn((type: string, handler: (e: unknown) => void) => {
        if (type === 'keydown') docKeydownHandlers.push(handler);
    }),
    removeEventListener: jest.fn(),
};
Object.defineProperty(global, 'document', { value: mockDocument, writable: true, configurable: true });

import { showConfirm, getTopModal } from '../js/modals';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Mirror of the main.ts single Escape owner (one No click, no propagation). */
function fireSingleEscapeAsMainOwner(): void {
    const activeModal = getTopModal() as unknown as FakeEl | null;
    if (!activeModal) return;
    if (activeModal.id === 'confirmModal') {
        const no = mockDocument.getElementById('confirmNo') as unknown as FakeEl | null;
        if (no) { no.click(); return; }
    }
}

describe('escape-confirm: single Esc answers exactly one queued confirm', () => {
    beforeEach(() => {
        docKeydownHandlers.length = 0;
        (mockDocument.addEventListener as jest.Mock).mockClear();
        confirmModal.classList.remove('active');
        titleEl.innerText = '';
        msgEl.innerText = '';
        yesBtn.onclick = null;
        noBtn.onclick = null;
    });

    test('modals.ts installs no document Escape handler (main.ts is sole owner)', () => {
        showConfirm('ONLY', 'probe', () => undefined);
        // openModal ran above: it may wire a per-modal Tab trap, but must
        // NOT add a document-level keydown (the deleted ensureEscapeHandler).
        const docKeydowns = (mockDocument.addEventListener as jest.Mock).mock.calls
            .filter((c) => c[0] === 'keydown');
        expect(docKeydowns).toHaveLength(0);
        // Cleanup the probe confirm so it cannot leak into the next test.
        fireSingleEscapeAsMainOwner();
        return sleep(20);
    });

    test('2-deep queue + single Esc answers exactly one No, second stays pending', async () => {
        const noCalls: string[] = [];
        showConfirm('FIRST', 'first message', () => undefined, () => { noCalls.push('first'); });
        showConfirm('SECOND', 'second message', () => undefined, () => { noCalls.push('second'); });

        // First confirm is showing; second is queued behind it.
        expect(confirmModal.classList.contains('active')).toBe(true);
        expect(titleEl.innerText).toBe('FIRST');

        // Single Esc from the sole owner: exactly one #confirmNo click.
        fireSingleEscapeAsMainOwner();

        // Drain (close() defers _drainConfirmQueue via setTimeout 0).
        await sleep(20);

        // Exactly one No answered...
        expect(noCalls).toEqual(['first']);
        // ...and the second confirm is still visible/pending, not swallowed.
        expect(confirmModal.classList.contains('active')).toBe(true);
        expect(titleEl.innerText).toBe('SECOND');
        expect(getTopModal() as unknown as FakeEl | null).not.toBeNull();

        // Cleanup: answer the leftover so later suites start un-wedged.
        fireSingleEscapeAsMainOwner();
        await sleep(20);
        expect(noCalls).toEqual(['first', 'second']);
    });
});
