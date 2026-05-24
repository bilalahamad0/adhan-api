// Pre-publish qualification checks for the packaged extension.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const exists = (p) => existsSync(join(EXT, p));

describe('manifest qualification', () => {
  it('is Manifest V3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('has name, semver version, and a store-length description', () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.description.length).toBeGreaterThan(0);
    expect(manifest.description.length).toBeLessThanOrEqual(132); // Web Store limit
  });

  it('declares a module service worker that exists', () => {
    expect(manifest.background.type).toBe('module');
    expect(exists(manifest.background.service_worker)).toBe(true);
  });

  it('references action popup + icons that exist and are real PNGs', () => {
    expect(exists(manifest.action.default_popup)).toBe(true);
    for (const size of ['16', '48', '128']) {
      const p = manifest.icons[size];
      expect(p).toBeTruthy();
      expect(exists(p)).toBe(true);
      expect(readFileSync(join(EXT, p)).subarray(0, 4)).toEqual(PNG_MAGIC);
    }
  });

  it('content scripts reference existing js/css', () => {
    for (const cs of manifest.content_scripts) {
      for (const f of [...(cs.js || []), ...(cs.css || [])]) {
        expect(exists(f)).toBe(true);
      }
    }
  });

  it('requests only the expected permissions (no scope creep)', () => {
    expect(new Set(manifest.permissions)).toEqual(
      new Set(['storage', 'alarms', 'notifications', 'scripting', 'tabs'])
    );
  });

  it('host permissions cover the prayer-times API and all http/https sites', () => {
    expect(manifest.host_permissions).toEqual(
      expect.arrayContaining(['https://adhan-api-mauve.vercel.app/*', 'http://*/*', 'https://*/*'])
    );
  });

  it('defines the toggle-focus command with a suggested key', () => {
    const cmd = manifest.commands['toggle-focus'];
    expect(cmd).toBeTruthy();
    expect(cmd.suggested_key.default).toBeTruthy();
  });
});

describe('package hygiene (pre-publish)', () => {
  it('has no leftover dev preview file in the extension root', () => {
    expect(exists('index.html')).toBe(false);
  });

  it('popup only references files that exist (no dead links)', () => {
    const html = readFileSync(join(EXT, manifest.action.default_popup), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((r) => !r.startsWith('http') && !r.startsWith('data:') && !r.startsWith('#'));
    for (const r of refs) expect(exists(r.split('?')[0])).toBe(true);
  });

  it('the popup loads as an ES module (so lib imports resolve)', () => {
    const html = readFileSync(join(EXT, manifest.action.default_popup), 'utf8');
    expect(html).toMatch(/<script[^>]+type="module"[^>]+popup\.js/);
  });
});
