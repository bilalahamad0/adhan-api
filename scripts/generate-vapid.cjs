#!/usr/bin/env node
/*
 * Generate a VAPID key pair for the prayer-time Web Push, ONCE.
 *
 *   cd media-caster && node ../scripts/generate-vapid.cjs
 *
 * (run from media-caster so it can resolve the installed `web-push`, or run
 *  `npx web-push generate-vapid-keys` anywhere).
 *
 * Then:
 *   - put VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY in the Pi's media-caster/.env
 *   - paste the PUBLIC key into dashboard.html:
 *       <meta name="vapid-public-key" content="<PUBLIC KEY>">
 *
 * NEVER regenerate after devices have subscribed — it invalidates every
 * existing subscription. Keep the private key secret (Pi only).
 */
'use strict';

let webpush;
try {
  webpush = require('web-push');
} catch (_) {
  try {
    webpush = require('../media-caster/node_modules/web-push');
  } catch {
    console.error('web-push not found. Run inside media-caster (npm i) or use: npx web-push generate-vapid-keys');
    process.exit(1);
  }
}

const keys = webpush.generateVAPIDKeys();
console.log('\nVAPID key pair generated — store these securely.\n');
console.log('# --- Pi: media-caster/.env ---');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('VAPID_SUBJECT=mailto:bilalahamad0@gmail.com');
console.log('\n# --- dashboard.html <head> ---');
console.log(`<meta name="vapid-public-key" content="${keys.publicKey}">`);
console.log('');
