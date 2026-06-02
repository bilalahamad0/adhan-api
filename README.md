# 🕌 Adhan Media Caster: AI-Native IoT Orchestration Engine

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![Last Commit](https://img.shields.io/github/last-commit/bilalahamad0/adhan-api)](https://github.com/bilalahamad0/adhan-api/commits/main)
[![Tests: Jest](https://img.shields.io/badge/tests-Jest-15c213?logo=jest&logoColor=white)](https://jestjs.io/)
[![Code Style: Prettier](https://img.shields.io/badge/code_style-Prettier-ff69b4?logo=prettier&logoColor=white)](https://prettier.io/)

[![Platform: Raspberry Pi 4](https://img.shields.io/badge/Platform-Raspberry%20Pi%204-c51a4a?logo=raspberrypi&logoColor=white)](https://www.raspberrypi.com/)
[![Local AI: Gemma 3 + Ollama](https://img.shields.io/badge/Local%20AI-Gemma%203%20%2B%20Ollama-0a0a0a?logo=ollama&logoColor=white)](https://ollama.com/)
[![Google Cast](https://img.shields.io/badge/Google%20Cast-Nest%20Hub-4285F4?logo=googlecast&logoColor=white)](https://developers.google.com/cast)
[![Android TV: ADB](https://img.shields.io/badge/Android%20TV-ADB-3ddc84?logo=android&logoColor=white)](https://developer.android.com/tools/adb)
[![FFmpeg](https://img.shields.io/badge/FFmpeg-007808?logo=ffmpeg&logoColor=white)](https://ffmpeg.org/)
[![PM2](https://img.shields.io/badge/PM2-2b037a?logo=pm2&logoColor=white)](https://pm2.keymetrics.io/)

> **The Invisible Conductor for the Intelligent Home Sanctuary.**
> _A masterclass in distributed I/O management, edge AI, and hardware interoperability._

### 🎬 Introductory Video: The Architecture of Automation

[![Watch the Video Overview](./images/video_thumbnail_with_play.jpg)](https://www.youtube.com/watch?v=GETyDnvZWog)

## 🌟 Overview

**Adhan Media Caster** is a high-performance Smart Home IoT Automation Platform that transforms standard household hardware into a precision, context-aware media ecosystem.

Developed using an **Agentic AI workflow**, the system runs on a **Raspberry Pi 4 core** that commands a complex multi-device lifecycle. It bridges the gap between digital entertainment and daily ritual by orchestrating a synchronized environment: broadcasting high-fidelity prayer audio and a live dashboard to **Google Nest Hubs** while using **ADB-level protocol injection** to intelligently manage the media state of **Sony Android TVs**.

It is also **local-first and AI-native at runtime**: a fully on-device **Gemma 3 (via Ollama)** model answers natural-language questions, explains failures, and advises on tuning — without any cloud dependency, API key, or data ever leaving the house, and **never touching the real-time cast path**.

![Dashboard Preview](./images/screenshots/final_maghrib_success.jpg)

---

## ✨ Key Engineering Features

### 🧠 **On-Device AI Layer (Gemma 3 + Ollama)**
A local LLM runs on the Pi itself via **[Ollama](https://ollama.com/)** — no cloud, no API keys, no data leaving the network. It is **architecturally fenced off the real-time cast path**: inference is forbidden inside the critical window (5 minutes before → 8 minutes after each prayer), so the Adhan always fires on time regardless of what the model is doing.
- **Natural-Language Status** (`POST /api/ask`): ask _"how long until Asr?"_ and get a grounded answer built strictly from the live schedule and playback log.
- **Self-Diagnosing Failures**: when a cast fails, the event is queued and explained in plain English during the next quiet window, then attached to the dashboard history.
- **Daily Dashboard Greeting**: a warm, cached one-liner generated once per day.
- **Advisory Tuning Loop**: reviews rolling 14-day reliability stats and proposes env-var tuning — surfaced for a human to review, **never auto-applied**.
- **Resilience**: single-flight serialization (a Pi 4 can't run two inferences at once), model warm-keeping, a **circuit breaker + watchdog** that restarts Ollama on repeated failure, and a deterministic fallback so `/api/ask` never hard-fails.

### 🤖 **Agentic AI Development Workflow**
This project also serves as a flagship for **AI-native hardware development**. The entire codebase was architected using an **Agentic AI workflow**, ensuring:
* **Rapid Prototyping**: Accelerating the bridge between low-level ADB commands and high-level Cast protocols.
* **Edge-Case Resilience**: AI-driven stress testing of "Cast Device Hanging" and network latency scenarios.

### 🎯 **Precision Deterministic Timing**
- **Zero-Latency Orchestration**: Features a "Pre-Flight" engine that renders dynamic visuals 5 minutes early, then holds the payload in a ready-state to trigger at the *exact millisecond* of the prayer time.
- **Adaptive Cast Lead**: Learns from a rolling history of cast-connect latencies (p75) to fire just early enough — compensating for processing overhead and network jitter.

### 📺 **Advanced Media & Power Management**
- **Composite "Ghost Power" Detection**: Solves the "Network Zombie" problem common in smart TVs. The system uses a multi-stage verification (Ping + ADB `dumpsys power`) to detect physical standby states even when the network interface remains active, transitioning to `SLEEPING` mode within 120 seconds to preserve resources.
- **ADB Protocol Injection**: Moves beyond simple "On/Off" commands. The system performs deep state-inspection of the Android TV, intelligently pausing active streams (Netflix/YouTube) and resuming them with zero user intervention post-broadcast.
- **Procedural Weather Engine**: Implements a high-fidelity rendering pipeline using FFmpeg `lut2` luminance-addition. Generates high-density, cinematic atmospheric effects (Rain, Snow, Fog) directly on top of mosque wallpapers with zero color-tinting and perfect channel fidelity.
- **Context-Aware Visuals**: Generates 1280x800 HD dashboards (optimized for Nest Hub Max) with real-time weather integration, the Islamic **Hijri calendar date**, and dynamic theme switching.

### 🛡️ **Industrial-Grade Reliability**
- **Hybrid Status Monitoring**: Implements a dual-layer watchdog using **Passive Event Listening** and **Serialized Active Polling** to mitigate the common "ghosting" issues found in standard Cast implementations.
- **Self-Healing Infrastructure**: Automated detection and transparent reconnection for ADB and Cast sessions.
- **Adaptive FFmpeg Pipeline**: Automatically detects system binary paths and hardware limitations to deliver optimized video "baking" in under 10 seconds.
- **Leak-Proof Concurrency**: Replaced traditional `setInterval` with **serialized recursive promises** to prevent memory leaks and listener exhaustion in long-running processes.

---

## 🛠️ Tech Stack & Engineering Mastery

| Layer | Technologies |
| :--- | :--- |
| **Core Logic** | Node.js (v18+), Asynchronous Event-Loop Architecture |
| **Edge AI** | Gemma 3 (1B) via Ollama — local inference, off the cast path |
| **Hardware** | Raspberry Pi 4, Sony Android TV, Google Nest Hub Max |
| **Protocols** | mDNS/Castv2 (Google Cast), ADB (Android Debug Bridge) |
| **API / Server** | Express 5, REST control + metrics endpoints |
| **Media Engine** | FFmpeg, Canvas API (Dynamic HD Rendering) |
| **Data & Dashboard** | Firebase Admin / Firestore, Open-Meteo API |
| **Infrastructure** | PM2 Process Management, GitHub Actions |
| **Quality** | Jest, ESLint, Prettier |

---

## 🔄 System Flow

<img src="./images/system_flow/flow_animation.webp" width="100%" alt="System Flow Animation" />

> **[🎛️ Open the Interactive Architecture & System Design ↗](https://bilalahamad0.github.io/adhan-api/architecture.html)**
> — a single-page, animated walkthrough of the **layered architecture**, the **data/control-flow map**, the **live prayer-cast lifecycle**, and the on-device AI **quiet-window fence**. ([source](./architecture.html))

## 📊 Development Analytics

This project features a **Live AI-Driven Engineering Dashboard** that tracks development metrics, AI utilization, and system health in real-time.

[![AI Development Dashboard](./images/dashboard_banner.svg)](https://bilalahamad0.github.io/adhan-api/dashboard.html)

> **[Open Interactive Dashboard (Live Sync) ↗](https://bilalahamad0.github.io/adhan-api/dashboard.html)**

---

## 🏗️ Deployment & Production Scaling

### 1. Artifact Generation
To bundle a production-ready artifact for the Raspberry Pi environment:
```bash
# 1. Initialize environment
cp media-caster/.env.example media-caster/.env

# 2. Build production tarball
npm run build:prod
```

### 2. Raspberry Pi Implementation
```bash
# Clone and initialize
git clone https://github.com/bilalahamad0/adhan-api.git
cd adhan-api/media-caster
npm install

# Deploy with PM2 for high availability
pm2 start boot.js --name adhan-caster
pm2 save
```

After you change any `media-caster` files on the Pi (`git pull`, tarball, or copy), **restart the process** or Node will still be running the old code:

```bash
pm2 restart adhan-caster --update-env
```

Then, if you rely on the [Operations Dashboard](https://bilalahamad0.github.io/adhan-api/dashboard.html) and Firestore metrics, trigger a sync from the Pi: `curl -sS -X POST "http://localhost:3001/api/metrics/sync"` (expect `"prayersScheduled":5` when the schedule file is current). See [DEPLOYMENT_GUIDE_PI.md](./DEPLOYMENT_GUIDE_PI.md) for full detail.

### 3. Optional: Enable the On-Device AI
The AI layer is entirely optional — the caster runs fully without it. To enable it, install [Ollama](https://ollama.com/) on the Pi, then build the resource-capped model the system expects by default (`OLLAMA_MODEL=gemma3-constrained`, `OLLAMA_URL` also configurable):
```bash
ollama pull gemma3:1b
ollama create gemma3-constrained -f ./Modelfile   # Modelfile detailed in the whitepaper
```
If Ollama is unavailable, every AI endpoint degrades gracefully to a deterministic, computed response. See the [Edge AI Whitepaper](./docs/blog/gemma-ollama-raspberry-pi-adhan.md) for the full Modelfile and rationale.

---

## 🌐 REST API

`boot.js` exposes a local control + telemetry API (default port `3001`, override with `SERVER_PORT`):

| Method & Path | Purpose |
| :--- | :--- |
| `GET /health` | Liveness probe + deployed build version / short SHA. |
| `GET /api/metrics?days=N` | Rolling multi-day playback summary (success rate, latency, streaks). |
| `GET /api/metrics/today` | Today's playback summary. |
| `POST /api/ask` | Natural-language status query (Gemma, with computed fallback). |
| `GET /api/ask/health` | Whether the local Gemma model is reachable. |
| `GET /api/blurb` | Cached daily dashboard greeting. |
| `GET /api/advisory` | Latest advisory-only tuning suggestions. |
| `POST /api/trigger/prayer` | Manually fire a prayer cast (`fajr`…`isha`) — useful for testing. |
| `POST /api/metrics/sync` | Push today's metrics + schedule to Firestore for the dashboard. |

---

## 🧪 Testing & Quality

A **Jest** suite covers the scheduler, media/hardware services, the Ollama circuit breaker, Firestore sync, and the visual generator.

```bash
npm test            # full Jest suite
npm run test:cov    # with coverage
npm run lint        # ESLint
npm run format      # Prettier
```

Verify the hardware handshake and media-state logic on real devices before deployment:

```bash
node media-caster/boot.js --test --debug   # live system test
npm run test:smoke                          # fast smoke check
npm run qa:sanity                           # config + schedule sanity
```

---

## 🏛️ System Architecture

| Module | Functional Responsibility |
| :--- | :--- |
| `media-caster/boot.js` | **Orchestration Core + REST API**. Wires services, exposes `/api/*`, and starts the scheduler. |
| `media-caster/services/CoreScheduler.js` | **Authoritative scheduler & player** — prayer timing, pre-flight rendering, cast lifecycle, and retries. |
| `media-caster/services/MediaService.js` | Audio cache, Adhan source selection, and fallback mirrors. |
| `media-caster/services/HardwareService.js` | ADB control of the Android TV (pause/resume, ghost-power detection). |
| `media-caster/services/DiscoveryService.js` | mDNS discovery of Google Cast / Nest devices. |
| `media-caster/services/OllamaService.js` | Local Gemma client — circuit breaker, watchdog, and quiet-window guard. |
| `media-caster/services/AdvisoryAgent.js` | Off-path AI — failure diagnosis, daily blurb, and tuning advisory. |
| `media-caster/services/PlaybackLogger.js` | Durable event log + rolling metrics (success rate, latency, adaptive lead). |
| `media-caster/services/FirestoreSync.js` | Pushes metrics + schedule to Firestore for the operations dashboard. |
| `media-caster/visual_generator.js` | **Rendering engine** — builds HD dashboards and procedural weather via Canvas/FFmpeg. |

---

## 🛡️ Automated Maintenance & Security

The platform is designed for "Set-and-Forget" reliability:
| Feature | Description |
| :--- | :--- |
| **Leak-Proof Concurrency** | Replaced `setInterval` with **serialized recursive promises** to prevent memory leaks in long-running processes. |
| **Stale State Watchdog** | If a device remains `PAUSED` for >3 minutes, the system forces a cleanup to prevent "stuck" states. |
| **Connection Watchdog** | If a device fails 3 consecutive polls, it is assumed disconnected, and the system attempts a hard reset. |
| **ADB Retry Logic** | Automatically retries ADB commands once upon detecting `device offline` errors. |
| **Ollama Circuit Breaker** | Trips after consecutive failures, fails fast during cooldown, and triggers an Ollama restart via watchdog. |
| **Automated Security** | Weekly `npm audit fix` via GitHub Actions and a local fixer script to maintain dependency hygiene. |

---

## 📱 Companion App

**[Adhan Caster Pro (Chrome Extension) ↗](https://github.com/bilalahamad0/adhan-ce)** — a browser companion that shows upcoming prayer times with a live countdown and auto-pauses media in every tab at Adhan time. (Previously bundled here; now maintained in its own repository.)

---

## 📚 Documentation

- [DEPLOYMENT_GUIDE_PI.md](./DEPLOYMENT_GUIDE_PI.md) — Comprehensive Raspberry Pi setup guide.
- [PROJECT_PLAN.md](./PROJECT_PLAN.md) — Original design, architecture evolution, and what's been retired.
- [Edge AI Whitepaper: Gemma 3 + Ollama](./docs/blog/gemma-ollama-raspberry-pi-adhan.md) — Deep dive into the on-device AI layer.
- [architecture.html](./architecture.html) — Interactive, animated architecture · system design · prayer-cast workflow ([live ↗](https://bilalahamad0.github.io/adhan-api/architecture.html)).

---

Designed & Engineered by Bilal Ahamad
