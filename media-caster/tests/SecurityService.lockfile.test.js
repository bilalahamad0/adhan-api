const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');

// Fix mode runs npm on a copy of the manifests in a mkdtemp dir. npm names a
// lockfile after its folder when package.json has no "name", so with an
// unnamed root package every run rewrote package-lock.json to
// "adhan-security-<random>" and pushed it: a commit on main, and a redeploy,
// every night. The mocked SecurityService tests cannot see this; real npm can.
//
// `install --package-lock-only` rewrites the lockfile the same way `audit fix`
// does, and with --offline and an empty cache it needs no registry.
describe('real npm on the real manifests in a randomly named dir', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhan-security-'));
    fs.mkdirSync(path.join(dir, 'media-caster'));
    for (const rel of ['package.json', 'package-lock.json', 'media-caster/package.json', 'media-caster/package-lock.json']) {
      fs.copyFileSync(path.join(REPO, rel), path.join(dir, rel));
    }
    fs.cpSync(path.join(REPO, 'media-caster/ip-patch'), path.join(dir, 'media-caster/ip-patch'), { recursive: true });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.each(['.', 'media-caster'])('leaves %s/package-lock.json byte-identical', (workspace) => {
    const cwd = path.join(dir, workspace);
    const npm = spawnSync(
      'npm',
      ['install', '--package-lock-only', '--offline', '--no-audit', '--no-fund', '--cache', path.join(dir, '.npm-cache')],
      { cwd, encoding: 'utf8' }
    );
    expect({ status: npm.status, stderr: npm.status === 0 ? '' : npm.stderr }).toEqual({ status: 0, stderr: '' });

    const before = fs.readFileSync(path.join(REPO, workspace, 'package-lock.json'), 'utf8');
    const after = fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8');
    expect(after).toBe(before);
  }, 60_000);
});
