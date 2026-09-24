import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'gangsta-audio-consent-'));

jest.mock('electron', () => ({
    app: {
        getPath: jest.fn(() => mockUserData),
    },
}));

const {
    addAllowedAudioFile,
    getDbManager,
    initDbManager,
    isAllowedAudioFile,
    loadAllowedAudioFiles,
} = require('../db-manager') as typeof import('../db-manager');

function makeAudioFile(name: string): string {
    const filePath = path.join(mockUserData, name);
    fs.writeFileSync(filePath, Buffer.from('RIFF0000WAVEfmt '));
    return filePath;
}

afterAll(() => {
    try { getDbManager()?.close(); } catch { /* ignore */ }
    try { fs.rmSync(mockUserData, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('durable native audio consent', () => {
    test('restores a consented audio path after the database is reopened', () => {
        const audioPath = makeAudioFile('library.wav');
        expect(addAllowedAudioFile(audioPath)).toBe(true);
        expect(isAllowedAudioFile(audioPath)).toBe(true);

        const firstDb = getDbManager();
        expect(firstDb).not.toBeNull();
        firstDb?.close();
        expect(isAllowedAudioFile(audioPath)).toBe(false);

        expect(initDbManager()).not.toBeNull();
        expect(loadAllowedAudioFiles()).toBe(1);
        expect(isAllowedAudioFile(audioPath)).toBe(true);
    });

    test('does not grant relative or missing paths', () => {
        expect(addAllowedAudioFile('relative.wav')).toBe(false);
        expect(addAllowedAudioFile(path.join(mockUserData, 'missing.wav'))).toBe(false);
        expect(isAllowedAudioFile(path.join(mockUserData, 'missing.wav'))).toBe(false);
    });

    test('zero-valued reindexing does not erase known metadata', () => {
        const audioPath = makeAudioFile('metadata.wav');
        expect(addAllowedAudioFile(audioPath)).toBe(true);
        const db = getDbManager();
        expect(db).not.toBeNull();
        db?.upsertTrack({ id: 'track-1', path: audioPath, name: 'Metadata.wav', duration: 120, bpm: 128, metadata: { source: 'analysis' } });
        db?.upsertTrack({ id: 'track-1', path: audioPath, name: 'Metadata.wav', duration: 0, bpm: 0 });
        const row = db?.getTrackByPath(audioPath);
        expect(row?.duration).toBe(120);
        expect(row?.bpm).toBe(128);
        expect(row?.metadata).toEqual({ source: 'analysis' });
    });
});
