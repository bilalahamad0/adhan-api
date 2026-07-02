const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('dns');
const CoreScheduler = require('../services/CoreScheduler');

// The cache methods only touch this._castCachePath and this.playbackLogger, so
// a scheduler built with null collaborators is enough to exercise them.
function makeScheduler(tmpFile) {
  const s = new CoreScheduler({}, null, null, null, null, null, null);
  s._castCachePath = tmpFile;
  return s;
}

describe('CoreScheduler cast cache — IP resolution', () => {
  let tmpFile;
  let scheduler;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cast-cache-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
    scheduler = makeScheduler(tmpFile);
  });
  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
    jest.restoreAllMocks();
  });

  it('passes a literal IPv4 through unchanged', async () => {
    await expect(scheduler._resolveHostToIpv4('10.0.0.213')).resolves.toBe('10.0.0.213');
  });

  it('strips a trailing dot and resolves via mDNS first', async () => {
    scheduler._resolveViaMdns = jest.fn().mockResolvedValue('10.0.0.213');
    await expect(scheduler._resolveHostToIpv4('fuchsia-abc.local.')).resolves.toBe('10.0.0.213');
    expect(scheduler._resolveViaMdns).toHaveBeenCalledWith('fuchsia-abc.local');
  });

  it('falls back to dns.lookup when mDNS returns nothing', async () => {
    scheduler._resolveViaMdns = jest.fn().mockResolvedValue(null);
    jest.spyOn(dns, 'lookup').mockImplementation((name, opts, cb) => cb(null, '10.0.0.99'));
    await expect(scheduler._resolveHostToIpv4('fuchsia-abc.local')).resolves.toBe('10.0.0.99');
  });

  it('returns null when every resolver fails', async () => {
    scheduler._resolveViaMdns = jest.fn().mockResolvedValue(null);
    jest.spyOn(dns, 'lookup').mockImplementation((name, opts, cb) => cb(new Error('ENOTFOUND')));
    await expect(scheduler._resolveHostToIpv4('fuchsia-abc.local')).resolves.toBeNull();
  });
});

describe('CoreScheduler cast cache — write/read/touch', () => {
  let tmpFile;
  let scheduler;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cast-cache-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
    scheduler = makeScheduler(tmpFile);
  });
  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
    jest.restoreAllMocks();
  });

  it('persists the resolved IP (not the mDNS host) and keeps mdnsHost', async () => {
    scheduler._resolveHostToIpv4 = jest.fn().mockResolvedValue('10.0.0.213');
    await scheduler._writeCastCache({ friendlyName: 'Google Display', host: 'fuchsia-abc.local', port: 8009 });

    const written = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    expect(written.host).toBe('10.0.0.213');
    expect(written.mdnsHost).toBe('fuchsia-abc.local');
    expect(written.resolved).toBe(true);
    expect(written.friendlyName).toBe('Google Display');
    expect(written.port).toBe(8009);

    // read-back exposes the IP as host so the warm probe is pure unicast
    expect(scheduler._readCastCache().host).toBe('10.0.0.213');
  });

  it('falls back to the raw host (resolved:false) when resolution fails', async () => {
    scheduler._resolveHostToIpv4 = jest.fn().mockResolvedValue(null);
    await scheduler._writeCastCache({ friendlyName: 'Google Display', host: 'fuchsia-abc.local' });

    const written = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    expect(written.host).toBe('fuchsia-abc.local');
    expect(written.resolved).toBe(false);
  });

  it('writes nothing when the device lacks host or friendlyName', async () => {
    scheduler._resolveHostToIpv4 = jest.fn().mockResolvedValue('10.0.0.213');
    await scheduler._writeCastCache({ friendlyName: 'Google Display' }); // no host
    await scheduler._writeCastCache({ host: '10.0.0.213' });             // no name
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it('honours a 24h default TTL (fresh entry is not expired)', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      friendlyName: 'Google Display', host: '10.0.0.213', port: 8009,
      lastSuccessIso: new Date(Date.now() - 20 * 3600 * 1000).toISOString(), // 20h ago
    }));
    const data = scheduler._readCastCache();
    expect(data).not.toBeNull();
    expect(data._expired).toBeFalsy();
  });

  it('expires an entry older than 24h (covers the Fajr→Dhuhr gap that a 6h TTL broke)', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      friendlyName: 'Google Display', host: '10.0.0.213', port: 8009,
      lastSuccessIso: new Date(Date.now() - 25 * 3600 * 1000).toISOString(), // 25h ago
    }));
    const data = scheduler._readCastCache();
    expect(data._expired).toBe(true);
  });

  it('_touchCastCache slides lastSuccessIso forward on a warm hit', () => {
    const old = new Date(Date.now() - 10 * 3600 * 1000).toISOString();
    fs.writeFileSync(tmpFile, JSON.stringify({
      friendlyName: 'Google Display', host: '10.0.0.213', port: 8009, lastSuccessIso: old,
    }));
    scheduler._touchCastCache();
    const after = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    expect(after.lastSuccessIso).not.toBe(old);
    expect(Date.now() - Date.parse(after.lastSuccessIso)).toBeLessThan(5000);
  });
});
