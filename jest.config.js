/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Reset the module registry before every test so module-level singletons
  // (NativeSsdp, emitter) are re-created fresh and can be controlled per-test.
  resetModules: true,
  // Clear mock state (calls, instances) between tests.
  clearMocks: true,
  // Map the 'expo' import to our manual mock so no native bindings are needed.
  moduleNameMapper: {
    '^expo$': '<rootDir>/__mocks__/expo.ts',
  },
};
