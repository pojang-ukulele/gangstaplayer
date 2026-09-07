const { _electron: electron } = require('playwright');
const path = require('path');

jest.setTimeout(60000);

describe('Gangsta Player Pro 3 Smoke Test', () => {
    let electronApp;
    let window;

    beforeAll(async () => {
        electronApp = await electron.launch({
            args: [path.join(__dirname, '../app-build/main.js')],
        });
        window = await electronApp.firstWindow();
        window.on('console', msg => console.log('PAGE LOG:', msg.text()));
    });

    afterAll(async () => {
        await electronApp.close();
    });

    test('should launch the app', async () => {
        const title = await window.title();
        expect(title).toBe('GANGSTA PLAYER PRO 3');
    });

    test('should render sampler pads', async () => {
        await window.waitForSelector('.pad');
        const pads = await window.locator('.pad');
        const count = await pads.count();
        expect(count).toBe(16);
    });

    test('should have a functional play button', async () => {
        const playBtn = await window.locator('#playPauseBtn');
        expect(await playBtn.isVisible()).toBe(true);
        expect(await playBtn.textContent()).toBe('PLAY');
    });

    describe('Playlist context menu (DJ actions)', () => {
        const MENU_ITEMS = [
            'ctxFocusPlaying', 'ctxLoadToSampler', 'ctxAnalyzeBPM', 'ctxTrackInfo',
            'ctxShowInFolder', 'ctxCopyPath', 'ctxMoveUp', 'ctxMoveDown',
            'ctxSelectAll', 'ctxRemove', 'ctxClearPlaylist',
        ];

        test('menu contains the full DJ action layout', async () => {
            const ids = await window.evaluate(() =>
                [...document.querySelectorAll('#contextMenu .context-item')].map(el => el.id)
            );
            for (const id of MENU_ITEMS) expect(ids).toContain(id);
            // Sampler submenu shell exists (populated on menu open)
            expect(await window.locator('#samplerSubmenu').count()).toBe(1);
            // Track Info modal exists and starts hidden
            expect(await window.locator('#trackInfoModal:not(.active)').count()).toBe(1);
        });

        test('seeded track appears as a playlist row', async () => {
            const fixture = path.join(__dirname, '..', 'assets', 'gun-load.wav');
            await window.evaluate(async (fp) => {
                await window.database.upsertTrack({
                    id: 'smoke-seed-1', path: fp,
                    name: 'SMOKE-SEED-GUN-LOAD.wav', duration: 0, bpm: 0,
                });
            }, fixture);
            await window.reload();
            // A crash-restore prompt gates playlist init — dismiss it first
            // if it appears, otherwise init proceeds directly. (Fixed order:
            // waiting for rows before dismissing deadlocks when prompted.)
            try {
                await window.waitForSelector('#confirmModal.active #confirmNo', { timeout: 15000 });
                await window.locator('#confirmModal.active #confirmNo').click();
            } catch { /* no prompt — init proceeds directly */ }
await window.waitForFunction(() => document.querySelectorAll('#playlist li').length > 0, { timeout: 20000 });
             const text = await window.locator('#playlist li', { hasText: 'SMOKE-SEED' }).textContent();
            expect(text).toContain('SMOKE-SEED-GUN-LOAD');
        });

        test('right-click opens the menu; Track Info modal opens and ESC-closes', async () => {
            await window.locator('#playlist li', { hasText: 'SMOKE-SEED' }).click({ button: 'right' });
            await window.waitForSelector('#contextMenu:not(.hidden)', { timeout: 5000 });
            await window.locator('#ctxTrackInfo').click({ force: true });
            await window.waitForSelector('#trackInfoModal.active', { timeout: 5000 });
            const filename = await window.locator('#infoFilename').textContent();
            expect(filename).toContain('gun-load.wav');
            await window.keyboard.press('Escape');
            await window.waitForSelector('#trackInfoModal', { state: 'hidden', timeout: 5000 });
        });

        test('sampler submenu lists 16 pads and loads the track to Pad 1', async () => {
            await window.locator('#playlist li', { hasText: 'SMOKE-SEED' }).click({ button: 'right' });
            await window.waitForSelector('#contextMenu:not(.hidden)', { timeout: 5000 });
            await window.locator('#ctxLoadToSampler').hover({ force: true });
            await window.waitForSelector('#samplerSubmenu:not(.hidden)', { timeout: 5000 });
            expect(await window.locator('#samplerSubmenu .context-item').count()).toBe(16);
            console.log('DEBUG click target rect:', await window.evaluate(() => document.querySelectorAll('#samplerSubmenu .context-item')[0]?.getBoundingClientRect()));
            await window.locator('#samplerSubmenu .context-item').first().click({ force: true });
            await window.waitForFunction(() => document.querySelectorAll('#padGrid .pad')[0]?.classList.contains('loaded'), { timeout: 15000 });
        });

        test('Analyze re-queues BPM detection with a toast', async () => {
            await window.locator('#playlist li', { hasText: 'SMOKE-SEED' }).click({ button: 'right' });
            await window.waitForSelector('#contextMenu:not(.hidden)', { timeout: 5000 });
            await window.locator('#ctxAnalyzeBPM').click({ force: true });
            await window.waitForSelector('#toastContainer :text("ANALYZING")', { timeout: 5000 });
        });

        test('Copy Path confirms via toast; Show-in-Folder bridge exists', async () => {
            const hasBridge = await window.evaluate(
                () => typeof window.fileSystem?.showItemInFolder === 'function'
            );
            expect(hasBridge).toBe(true);
            await window.locator('#playlist li', { hasText: 'SMOKE-SEED' }).click({ button: 'right' });
            await window.waitForSelector('#contextMenu:not(.hidden)', { timeout: 5000 });
            await window.locator('#ctxCopyPath').click({ force: true });
            await window.waitForSelector('#toastContainer :text("FILE PATH COPIED")', { timeout: 5000 });
        });

        test('External file dropped on a row reaches the playlist (routing)', async () => {
            // Rows used to stopPropagation() every drop, silently swallowing
            // external files. A synthetic file has no disk path, so the
            // container must reject it loudly (SKIPPED toast) — not silence.
            await window.evaluate(() => {
                const li = [...document.querySelectorAll('#playlist li')]
                    .find(el => (el.textContent ?? '').includes('SMOKE-SEED'));
                const dt = new DataTransfer();
                dt.items.add(new File(['x'], 'fakefile.mp3', { type: 'audio/mpeg' }));
                li.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
                li.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
            });
            await window.waitForSelector('#toastContainer :text("SKIPPED")', { timeout: 5000 });
            // Queue unchanged — the file was rejected, not added
            expect(await window.locator('#playlist li', { hasText: 'SMOKE-SEED' }).count()).toBe(1);
        });

        test('File dropped on a pad loads the sample', async () => {
            await window.evaluate(() => {
                const sr = 8000, n = Math.floor(sr * 0.25);
                const buf = new ArrayBuffer(44 + n * 2);
                const v = new DataView(buf);
                const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
                wstr(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); wstr(8, 'WAVE');
                wstr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
                v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
                v.setUint16(32, 2, true); v.setUint16(34, 16, true);
                wstr(36, 'data'); v.setUint32(40, n * 2, true);
                for (let i = 0; i < n; i++) {
                    v.setInt16(44 + i * 2, Math.round(Math.sin((i / n) * Math.PI * 8) * 12000), true);
                }
                const file = new File([buf], 'drop-test.wav', { type: 'audio/wav' });
                const pad = document.querySelectorAll('#padGrid .pad')[2];
                const dt = new DataTransfer();
                dt.items.add(file);
                pad.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
                pad.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
            });
            await window.waitForFunction(
                () => document.querySelectorAll('#padGrid .pad')[2]?.classList.contains('loaded'),
                { timeout: 15000 }
            );
        });

        test('Clear Playlist empties the queue without a confirm when idle', async () => {
            await window.locator('#playlist li', { hasText: 'SMOKE-SEED' }).click({ button: 'right' });
            await window.waitForSelector('#contextMenu:not(.hidden)', { timeout: 5000 });
            await window.locator('#ctxClearPlaylist').click({ force: true });
            await window.waitForFunction(() => document.querySelectorAll('#playlist li').length === 0, { timeout: 5000 });
        });
    });
});


