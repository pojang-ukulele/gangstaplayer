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

function readSource(fileName: string): string {
    return fs.readFileSync(path.join(__dirname, '..', fileName), 'utf8');
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

    test('navigation and permission handlers only trust the bundled document', () => {
        const src = readMainSource();
        expect(src).toContain("on('will-frame-navigate'");
        expect(src).toContain("on('will-redirect'");
        expect(src).toContain('setPermissionRequestHandler');
        expect(src).toContain('setPermissionCheckHandler');
        expect(src).not.toContain("u.protocol === 'file:'");
        expect(src).not.toContain("const allowed = ['about:blank']");
    });

    test('writes validate after open and truncate only after the checks', () => {
        const src = readMainSource();
        expect(src).toContain('fs.ftruncateSync(fd, 0)');
        expect(src).not.toContain('(c.O_TRUNC ?? fs.constants.O_TRUNC)');
    });
});

describe('binding: native File consent bridge', () => {
    test('renderer consent accepts File objects, not path strings', () => {
        const preload = readSource('preload.ts');
        const types = readSource(path.join('js', 'types.ts'));
        expect(preload).toContain('consentFile: (file: File)');
        expect(preload).toContain('webUtils.getPathForFile(candidate)');
        expect(preload).not.toMatch(/fileSystem[\s\S]{0,1200}consentFile:\s*\(path:/);
        expect(types).toContain('consentFile(file: File): Promise<boolean>');
        expect(types).not.toMatch(/FileSystemAPI[\s\S]{0,600}consentFile\(filePath/);
    });
});
