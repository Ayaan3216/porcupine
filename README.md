# 🦔 Porcupine

> **Direct. Private. No cloud.**  
> Send files device-to-device using a 6-character code. No accounts. No uploads. Files travel directly between browsers via WebRTC.

[![Live App](https://img.shields.io/badge/Live%20App-GitHub%20Pages-F5A623?style=for-the-badge&logo=github)](https://ayaan3216.github.io/porcupine)
[![Server](https://img.shields.io/badge/Server-Render-46E3B7?style=for-the-badge&logo=render)](https://porcupine-server-31gi.onrender.com/health)

---

## How It Works

```
Sender opens app → selects file → gets code: K7M-3QX
Receiver opens app → enters code → download starts directly
```

- The **signaling server** only exchanges a handshake (~5 KB total). It never sees the file.
- The **file bytes** travel directly between the two browsers via WebRTC DataChannel (encrypted).
- Both parties must be **online simultaneously**. No file is stored anywhere.

---

## Features

- 🔑 Alphanumeric codes (e.g. `K7M-3QX`) — 2.1 billion combinations
- 📁 Any file type, any size (streamed in 64 KB chunks — no RAM limit)
- 📲 Background transfer — Wake Lock + silent audio keep-alive for mobile
- 🔔 Push notification when transfer completes
- 💾 Streams directly to disk on Chrome (File System Access API)
- ⏱️ 10-minute code expiry, single-use
- ❌ No accounts, no cloud, no upload

---

## Architecture

```
[Browser A]  ←──── WebRTC DataChannel (direct, encrypted) ────→  [Browser B]
     ↕                                                                  ↕
     └──────── Socket.IO (signaling only, ~5KB) ──────────────────────┘
                            [Render Server]
```

---

## Deployment

### 1. Deploy Signaling Server → Render

1. Fork this repo
2. Go to [render.com](https://render.com) → New Web Service
3. Connect your GitHub repo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Environment:** Node
5. Deploy → copy the URL (e.g. `https://porcupine-server.onrender.com`)

### 2. Update Frontend → Point to Your Server

In `docs/index.html` and `docs/js/app.js`, replace:
```
https://porcupine-server.onrender.com
```
with your actual Render URL.

### 3. Enable GitHub Pages

1. Go to repo **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: `main` / Folder: `/docs`
4. Save → your app is live at `https://YOUR_USERNAME.github.io/porcupine`

---

## Local Development

```bash
git clone https://github.com/YOUR_USERNAME/porcupine
cd porcupine
npm install
node server.js
# Open http://localhost:3000
```

---

## Tech Stack

| Layer | Tech |
|---|---|
| P2P Transfer | WebRTC DataChannel |
| Signaling | Node.js + Socket.IO |
| Frontend | Vanilla HTML/CSS/JS |
| Hosting (frontend) | GitHub Pages |
| Hosting (server) | Render (free tier) |
| Background keep-alive | Wake Lock API + silent AudioContext |
| Large files | File System Access API (Chrome) |

---

## Browser Support

| Browser | Works | Large files (>2GB) |
|---|---|---|
| Chrome / Edge | ✅ | ✅ (streams to disk) |
| Firefox | ✅ | 🟡 (memory limit) |
| Safari | 🟡 (iOS background limited) | 🟡 |

---

*Made with 🦔 — No cloud. Just a code.*
