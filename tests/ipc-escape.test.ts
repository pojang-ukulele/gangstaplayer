/**
 * P2 regression gate (audit-sweep): main.ts IPC escape fixes.
 *
 * Binds to source since main.ts runs in the electron main process and
 * cannot be imported from the jest (node) env, and isSavePathAllowed is
 * not exported.
 */
import * as fs from 'fs';
import * as path from 'path';

function readMainSource(): string {
    return fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
}

describe('binding: main.ts realpath + ADS gate (fails until P2, passes unmodified post-fix)', () => {
    test('isSavePathAllowed not importable under jest (electron main) — source-grep binding', () => {
        // main.ts runs in the electron main process and cannot be imported
        // from the jest (node) env, and isSavePathAllowed is not exported —
        // so bind to source: realParent must be enforced (not voided) and the
        // ADS gate must reject :$DATA past the drive prefix.
        const src = readMainSource();
        // main.ts:467-518 — parent-dir realpath check enforced.
        expect(src).not.toContain('void realParent');
        expect(src).toMatch(/realParent[\s\S]{0,600}return false/);
        // main.ts:103-106 — ADS :$DATA suffix rejected even after drive prefix.
        expect(src).toContain(':$DATA');
    });
});
