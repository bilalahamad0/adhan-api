# Testing & Chrome Web Store qualification

How to verify Adhan Caster Pro before publishing a production build.

## Automated tests

Pure logic and packaging are covered by Jest (run from the repo root):

```bash
npm run test:ext            # unit + manifest qualification tests
npm run pack:ext            # runs the tests, then zips a clean build only if they pass
node --experimental-vm-modules node_modules/jest/bin/jest.js chrome-extension --coverage \
  --collectCoverageFrom='chrome-extension/lib/**/*.js'
```

| Suite | File | Covers |
| :--- | :--- | :--- |
| Unit | `tests/schedule.test.js` | `lib/schedule.js` — time parsing (AM/PM, midnight/noon, bad input), next-prayer selection incl. tomorrow-Fajr rollover, countdown formatting. ~100% line coverage. |
| Qualification | `tests/manifest.test.js` | MV3, semver version, ≤132-char description, module SW exists, icons exist + are real PNGs, popup/content files exist, permission set has no scope creep, host permissions, command defined, no leftover `index.html`, popup links resolve, popup is an ES module. |

`pack:ext` is the gate: it refuses to build the `.zip` if any test fails, and excludes dev-only files (`tests/`, `docs/`, `README.md`, the icon generator) while keeping the runtime `lib/`.

## Manual QA checklist (per release)

Load unpacked from `chrome://extensions` (Developer mode) and verify:

### Install & permissions
- [ ] Loads with no errors on the extension card; "Inspect service worker" console is clean.
- [ ] Permission prompt lists only storage/alarms/notifications/scripting/tabs + site access.

### Schedule & location
- [ ] Popup shows 5 prayers; next is highlighted; past ones are checked/dimmed.
- [ ] Setting **City + State/Province + Country** and **Save** reloads the schedule (header label updates, e.g. "Sunnyvale, California, US").
- [ ] State actually disambiguates (e.g. Sunnyvale CA vs. a same-named city) — requires the proxy API deployed with the `state` param.
- [ ] Countdown in the popup ticks down each second.

### Heads-up + pause flow (use **Run test Adhan (30s)** in dev)
- [ ] Bottom-right heads-up notification appears within the lead window and counts down. **No Resume button on it.**
- [ ] At zero, media pauses in the active tab **and** other tabs (test a 2nd tab + a same-site iframe).
- [ ] Desktop notification fires (OS must allow notifications for Chrome).
- [ ] Lead time honors the **Heads-up before Adhan** setting (15/30/60s).

### Focus mode
- [ ] With focus on, the full-screen focus screen takes over at Adhan time (no Resume-card flash beforehand).
- [ ] **Resume** button and **Esc** both dismiss it and resume media; page scroll is locked while it's up.
- [ ] `Ctrl/Cmd+Shift+Y` toggles the focus screen during an active Adhan.
- [ ] Auto-resume restores media after the configured delay.

### Build gating & theme
- [ ] **Run test Adhan** is visible when unpacked; confirm it's hidden in a packed/store build.
- [ ] Popup matches OS dark/light theme.

### Edge cases
- [ ] Restricted pages (`chrome://`, Web Store, PDF viewer) don't error — media there simply isn't paused.
- [ ] Day rollover: after the last prayer, "next" becomes tomorrow's Fajr.
- [ ] Toggling **Enable Adhan Caster** off stops notifications/pausing.

### Web Store listing requirements
- [ ] `version` bumped beyond the published one.
- [ ] Single-purpose description; broad host permission justified ("pause media in any tab").
- [ ] Privacy policy URL set; data-use disclosures completed.
- [ ] ≥1 screenshot (1280×800 or 640×400); 128px store icon.
- [ ] `npm run pack:ext` passes and the zip contains no dev files.
