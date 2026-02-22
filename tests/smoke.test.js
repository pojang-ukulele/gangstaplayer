const { _electron: electron } = require('playwright');
const path = require('path');

jest.setTimeout(30000);

describe('Gangsta Player Pro 3 Smoke Test', () => {
    let electronApp;
    let window;

    beforeAll(async () => {
        electronApp = await electron.launch({
            args: [path.join(__dirname, '../main.js')],
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
});
