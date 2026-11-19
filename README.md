# ⚡ Lim3rd Downloader

A sleek, dark glassmorphic web utility built by **Lim3rd** for fetching and downloading media with **Video (MP4)** and **Audio (MP3)** options.

## ✨ Features

* **Video & Audio Mode Switcher:** Toggle between `Video` and `Audio` formats after fetching a link.
* **Live Telemetry Bar:** Real-time local clock (`HH:MM:SS`) and detected region badge.
* **Intro Splash & Smooth Motion:** Clean startup splash screen with subtle card and format transitions (respects `prefers-reduced-motion`).
* **Multi-Language UI:** Supports **English**, **Tagalog**, and **中文 (Chinese)**.
* **Quick Link Tools:** One-click clipboard **Paste**, **Clear**, and input validation (`Please input a YouTube link`).

## 🧱 Project Structure

```text
├── index.html      # Frontend UI structure, splash overlay & language selector
├── style.css       # Dark glassmorphic theme, telemetry pill & animations
├── script.js       # Client logic, mode switching, live clock & API calls
├── server.js       # Express backend handling /download and /region routes
└── package.json    # Backend dependencies and start script
