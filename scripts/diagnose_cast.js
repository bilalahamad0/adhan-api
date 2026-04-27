#!/usr/bin/env node
/**
 * One-shot diagnostic for Adhan-Caster latency investigations.
 * Confirms whether the Pi's current network can see + reach the Chromecast device,
 * which is the dominant variable in the post-scheduled-time latency window.
 *
 * Run on the Pi:
 *   node scripts/diagnose_cast.js
 *
 * Reports (in order):
 *   1) cached cast device (if a prayer has cast successfully since deploy)
 *   2) avahi-browse view of _googlecast._tcp on the local link
 *   3) TCP probe to cached host:8009
 *   4) gateway + cached-host ping RTT
 *
 * Exit code is always 0 — this is a read-only debug tool.
 */

const { exec, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '..', 'audio-caster', '.cast-cache.json');

function run(cmd, timeoutMs = 8000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').toString(), stderr: (stderr || '').toString() });
    });
  });
}

function tcpProbe(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = new net.Socket();
    let settled = false;
    const finish = (ok, msg) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) { /* ignore */ }
      resolve({ ok, ms: Date.now() - start, msg });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true, 'connected'));
    sock.once('timeout', () => finish(false, 'timeout'));
    sock.once('error', (e) => finish(false, e.code || e.message));
    sock.connect(port, host);
  });
}

function readCache() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch (e) {
    return { _error: e.message };
  }
}

function defaultGateway() {
  return new Promise((resolve) => {
    execFile('sh', ['-c', "ip route | awk '/^default/ {print $3; exit}'"], (err, stdout) => {
      if (err) return resolve(null);
      const ip = (stdout || '').trim();
      resolve(ip || null);
    });
  });
}

(async () => {
  const out = (s) => process.stdout.write(s + '\n');
  out('--- Adhan Cast Diagnostic ---');
  out(`When: ${new Date().toISOString()}`);

  const cache = readCache();
  if (!cache) {
    out('\n[1] Cast cache: not present');
    out('    (no successful cast since cache landed; cold-start mDNS still required)');
  } else if (cache._error) {
    out(`\n[1] Cast cache: unreadable (${cache._error})`);
  } else {
    out('\n[1] Cast cache:');
    out(`    friendlyName: ${cache.friendlyName}`);
    out(`    host:port:    ${cache.host}:${cache.port || 8009}`);
    out(`    lastSuccess:  ${cache.lastSuccessIso}`);
  }

  out('\n[2] avahi-browse _googlecast._tcp (5s):');
  const avahi = await run('avahi-browse -art _googlecast._tcp 2>&1 | head -200', 6000);
  if (!avahi.ok) {
    out('    avahi-browse failed (is avahi-utils installed? `sudo apt install avahi-utils`)');
    if (avahi.stderr.trim()) out(`    stderr: ${avahi.stderr.trim().split('\n')[0]}`);
  } else {
    const lines = avahi.stdout.split('\n').filter((l) => /googlecast|address|hostname|port/i.test(l));
    if (!lines.length) {
      out('    NO Cast devices visible to mDNS on this interface.');
      out('    (this is the failure mode H1 in the plan: Wi-Fi↔LAN multicast bridge dropped)');
    } else {
      lines.slice(0, 30).forEach((l) => out(`    ${l.replace(/^=*\s*/, '')}`));
    }
  }

  if (cache && cache.host) {
    out('\n[3] TCP probe to cached host:');
    const probe = await tcpProbe(cache.host, cache.port || 8009, 3000);
    out(`    ${cache.host}:${cache.port || 8009} -> ${probe.ok ? 'OK' : 'FAIL'} (${probe.ms}ms, ${probe.msg})`);

    out('\n[4] Ping RTT:');
    const gw = await defaultGateway();
    if (gw) {
      const gwPing = await run(`ping -c 2 -W 2 ${gw}`, 6000);
      const m = gwPing.stdout.match(/min\/avg\/max[^=]*=\s*[^/]+\/([^/]+)\//);
      out(`    gateway ${gw}: ${m ? m[1] + ' ms avg' : (gwPing.ok ? 'replied' : 'no reply')}`);
    } else {
      out('    (could not determine default gateway)');
    }
    const castPing = await run(`ping -c 2 -W 2 ${cache.host}`, 6000);
    const m2 = castPing.stdout.match(/min\/avg\/max[^=]*=\s*[^/]+\/([^/]+)\//);
    out(`    cast    ${cache.host}: ${m2 ? m2[1] + ' ms avg' : (castPing.ok ? 'replied' : 'no reply')}`);
  } else {
    out('\n[3] TCP probe: skipped (no cached host)');
    out('[4] Ping RTT:  skipped (no cached host)');
  }

  out('\nDone.');
})();
