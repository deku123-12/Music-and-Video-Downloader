# ⚡ Lim3rd Downloader

A modern dark glassmorphic web utility built by **Lim3rd** for fetching and downloading YouTube media in **Video (MP4)** and **Audio (MP3)** formats.

## 🆕 What's New

* **Docker Support for Backend:** Added containerization support for the backend environment so dependencies (`Node.js`, `yt-dlp`, and `ffmpeg`) run consistently across deployments.
* **Playable MP4 Merging & Remuxing:** Updated `/proxy-download` for `ytdlp://` streams to build and merge/remux MP4 files in temporary storage (`/tmp`) before streaming, fixing `0:00` duration or unplayable video outputs.
* **MP3 Pipeline + Audio Fallback:** Kept RapidAPI MP3 extraction (`yt-search-and-download-mp3.p.rapidapi.com`) alongside a `yt-dlp` audio fallback when no RapidAPI audio link is returned.
* **Focused YouTube Pipeline:** Streamlined `/download` for YouTube links (`youtube.com` / `youtu.be`) with metadata, `MP4` quality options, and `MP3` audio options.
* **Refined UI & Typography:** Polished `index.html` and `style.css` with modern geometric sans-serif typography, steady layout alignment, clearer active format/tab states, and longer download fetch timeout handling in `script.js`.

## ✨ Features

* **Video & Audio Mode Switcher:** Switch seamlessly between `Video` (`MP4`) and `Audio` (`MP3`) formats after fetching a YouTube link.
* **Live Telemetry Bar:** Displays a real-time local clock (`HH:MM:SS`) alongside the detected region badge (`REGION: PH`).
* **Intro Splash & Smooth Motion:** Clean startup splash screen with card transitions and `prefers-reduced-motion` support.
* **Multi-Language UI:** Supports **English**, **Tagalog**, and **中文 (Chinese)**.
* **Quick Link Tools:** One-click clipboard **Paste**, input **Clear**, and YouTube URL validation.

## 🧱 Project Structure

```text
├── index.html      # Frontend UI layout, splash overlay & language selector
├── style.css       # Dark glassmorphic theme, layout rules & animations
├── script.js       # Client logic, tab switching, live clock & API integration
├── server.js       # Express backend handling /download, /proxy-download & /region
├── Dockerfile      # Backend container configuration (Node.js, yt-dlp, ffmpeg)
└── package.json    # Backend dependencies and start script
