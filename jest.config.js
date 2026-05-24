export default {
  testEnvironment: 'node',
  transform: {},
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'api/**/*.js',
    'media-caster/**/*.js',
    'chrome-extension/lib/**/*.js',
    '!**/node_modules/**',
  ],
};
