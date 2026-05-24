export default {
  testEnvironment: 'node',
  transform: {},
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['api/**/*.js', 'media-caster/**/*.js', '!**/node_modules/**'],
};
