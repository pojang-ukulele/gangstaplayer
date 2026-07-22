module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.{js,ts}'],
  verbose: true,
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
