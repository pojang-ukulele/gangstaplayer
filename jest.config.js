module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  verbose: true,
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/dist_source/', '<rootDir>/app-build/'],
};
