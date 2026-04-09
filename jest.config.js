export default {
  testEnvironment: 'node',
  transform: {},
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['api/**/*.js', 'audio-caster/**/*.js', '!**/node_modules/**'],
};
