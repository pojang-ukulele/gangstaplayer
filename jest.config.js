module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.{js,ts}'],
  testPathIgnorePatterns: ['/node_modules/', '/app-build/', '/dist/', '/dist_source/', 'smoke\\.test\\.js$'],
  verbose: true,
  collectCoverage: true,
  collectCoverageFrom: ['js/**/*.ts', 'main.ts', 'preload.ts', 'sonetra-bridge.ts', 'db-manager.ts', 'log-manager.ts'],
  coveragePathIgnorePatterns: ['/node_modules/', '/tests/'],
  coverageThreshold: {
    global: { branches: 20, functions: 25, lines: 25, statements: 25 },
  },
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
