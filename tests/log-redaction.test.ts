import * as os from 'os';
import * as path from 'path';

const mockUserData = path.join(os.tmpdir(), 'gangsta-log-redaction-test');
jest.mock('electron', () => ({
    app: {
        isReady: () => true,
        getPath: () => mockUserData,
    },
}));

import { logManager } from '../log-manager';

afterAll(() => {
    logManager.close();
});

test('redacts home paths when they occur inside a log message', () => {
    const secretPath = path.join(os.homedir(), 'private', 'recording.wav');
    logManager.log('INFO', 'MAIN', `prefix ${secretPath} suffix`);
    const contents = logManager.getBufferContents();
    expect(contents).not.toContain(secretPath);
    expect(contents).toContain('<home>');
});
