module.exports = {
  testEnvironment: 'node',
  // V8 provider instead of the default babel instrumentation: the bundled
  // babel-plugin-istanbul crashes on current Node
  // (TypeError in test-exclude at transform time). V8 coverage needs no
  // extra dependencies and remaps via ts-jest sourcemaps.
  coverageProvider: 'v8',
  testMatch: ['**/tests/**/*.test.{js,ts}'],
  testPathIgnorePatterns: ['/node_modules/', '/app-build/', '/dist/', '/dist_source/', 'smoke\\.test\\.js$'],
  verbose: true,
  collectCoverage: true,
  collectCoverageFrom: ['js/**/*.ts', 'main.ts', 'preload.ts', 'sonetra-bridge.ts', 'db-manager.ts', 'log-manager.ts'],
  coveragePathIgnorePatterns: ['/node_modules/', '/tests/'],
  // NOTE: no coverageThreshold — Jest 29's threshold check crashes on V8
  // coverage maps (TypeError reading 'sync' in CoverageReporter).
  // Reintroduce only after upgrading to Jest 30+.
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/dist_source/', '<rootDir>/app-build/'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        module: 'commonjs',
        esModuleInterop: true,
        strict: true,
        target: 'ES2020',
        lib: ['ES2020', 'DOM'],
        types: ['jest'],
        skipLibCheck: true,
        resolveJsonModule: true,
        isolatedModules: true,
      },
    }],
  },
};
