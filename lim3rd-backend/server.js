const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { execFile, spawn } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

const MAX_CONCURRENT_YTDLP = 1;
const MAX_QUEUE_SIZE = 2;
const INFO_CACHE_TTL_MS = 15 * 60 * 1000;
const BUILT_FILE_TTL_MS = 10 * 60 * 1000;
const YTDLP_JSON_TIMEOUT_MS = 35000;
const RATE_LIMIT_COOLDOWN_MS = 3 * 60 * 1000;

let cookiesFilePath = null;
if (process.env.YTDLP_COOKIES_B64) {
    try {
        const cleanB64 = String(process.env.YTDLP_COOKIES_B64).replace(/\s+/g, '');
        const tmpCookies = path.join(os.tmpdir(), 'ytdlp_cookies.txt');
        fs.writeFileSync(tmpCookies, Buffer.from(cleanB64, 'base64'));
        cookiesFilePath = tmpCookies;
        console.log('[Cookies] Loaded YTDLP_COOKIES_B64 to:', tmpCookies, 'Size:', fs.statSync(tmpCookies).size, 'bytes');
    } catch (e) {
        console.error('[Cookies] Failed to write yt-dlp cookies file:', e.message || e);
    }
} else {
    console.log('[Cookies] No YTDLP_COOKIES_B64 found in environment.');
}

let activeYtDlpJobs = 0;
let rateLimitUntil = 0;
const ytdlpWaitQueue = [];
const infoCache = new Map();
const inFlightInfo = new Map();
const builtFileCache = new Map();
const inFlightBuild = new Map();

function triggerRateLimitCooldown(reason = '') {
    rateLimitUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    console.warn(`[RateLimit] Activated 3-minute cooldown (${reason}).`);
}

function acquireYtDlpSlot() {
    return new Promise((resolve, reject) => {
        if (activeYtDlpJobs < MAX_CONCURRENT_YTDLP) {
            activeYtDlpJobs += 1;
            resolve(() => {
                activeYtDlpJobs = Math.max(0, activeYtDlpJobs - 1);
                const next = ytdlpWaitQueue.shift();
                if (next) next();
            });
            return;
        }
        if (ytdlpWaitQueue.length >= MAX_QUEUE_SIZE) {
            return reject(new Error('SERVER_BUSY'));
        }
        ytdlpWaitQueue.push(() => {
            activeYtDlpJobs += 1;
            resolve(() => {
                activeYtDlpJobs = Math.max(0, activeYtDlpJobs - 1);
                const next = ytdlpWaitQueue.shift();
                if (next) next();
            });
        });
    });
}

async function withYtDlpSlot(fn) {
    const release = await acquireYtDlpSlot();
    try {
        return await fn();
    } finally {
        release();
    }
}

function getYtDlpBaseArgs(extraArgs = [], useCookies = true) {
    const args = [
        '--no-playlist',
        '--no-warnings',
        '--js-runtimes', 'deno',
        '--remote-components', 'ejs:github',
        '--extractor-args', 'youtube:player_client=web'
    ];
    if (useCookies && cookiesFilePath) {
        args.push('--cookies', cookiesFilePath);
    }
    return [...args, ...extraArgs];
}

function sanitizeFilename(name) {
    return (name || 'Lim3rd_Media')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100) || 'Lim3rd_Media';
}

function formatTitleWithLim3rd(rawTitle) {
    const base = sanitizeFilename(rawTitle)
        .replace(/\s*-\s*Lim3rd$/i, '')
        .trim() || 'Lim3rd_Media';
    return `${base} - Lim3rd`;
}

function extractYouTubeId(rawUrl = '') {
    try {
        const cleaned = rawUrl.trim();
        const nestedMatch = cleaned.match(/(?:youtu\.be\/|[?&]v=|\/(?:embed|shorts|v)\/)([a-zA-Z0-9_-]{11})(?:[?&/]|$)/g);
        if (nestedMatch && nestedMatch.length > 0) {
            const lastChunk = nestedMatch[nestedMatch.length - 1];
            const idOnly = lastChunk.match(/([a-zA-Z0-9_-]{11})/);
            if (idOnly && /^[a-zA-Z0-9_-]{11}$/.test(idOnly[1])) {
                return idOnly[1];
            }
        }
        if (/^[a-zA-Z0-9_-]{11}$/.test(cleaned)) {
            return cleaned;
        }
    } catch (_) {}
    return null;
}

function extractThumbnail(payload, videoId = '') {
    if (Array.isArray(payload?.thumbnail) && payload.thumbnail.length > 0) {
        const best = payload.thumbnail[payload.thumbnail.length - 1];
        if (best?.url) return best.url;
    }
    const thumb =
        (typeof payload?.thumbnail === 'string' ? payload.thumbnail : '') ||
        payload?.thumb ||
        payload?.image ||
        payload?.videoDetails?.thumbnail?.thumbnails?.slice(-1)?.[0]?.url ||
        payload?.result?.thumbnail ||
        payload?.result?.thumb ||
        payload?.data?.thumbnail ||
        '';
    if (thumb) return thumb;
    return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '';
}

function isRateLimitedText(text = '') {
    return text.includes('HTTP Error 429') || text.includes('Too Many Requests');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function resolveRedirectUrl(url) {
    try {
        const response = await fetchWithTimeout(url, {
            method: 'GET',
            redirect: 'follow',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            }
        }, 8000);
        return response.url || url;
    } catch (err) {
        console.warn('[Redirect] Failed to resolve URL:', err.message || err);
        return url;
    }
}

async function fetchYouTubeOEmbed(youtubeUrl) {
    const videoId = extractYouTubeId(youtubeUrl);
    const fallbackThumb = videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '';
    try {
        const res = await fetchWithTimeout(
            `https://www.youtube.com/oembed?url=${encodeURIComponent(youtubeUrl)}&format=json`,
            {},
            6000
        );
        if (!res.ok) {
            return { title: 'Lim3rd Media File', thumbnail: fallbackThumb };
        }
        const data = await res.json();
        return {
            title: data?.title || 'Lim3rd Media File',
            thumbnail: data?.thumbnail_url || fallbackThumb
        };
    } catch (_) {
        return { title: 'Lim3rd Media File', thumbnail: fallbackThumb };
    }
}

function runYtDlpJsonOnce(youtubeUrl, useCookies = true) {
    return new Promise((resolve) => {
        const modeLabel = useCookies && cookiesFilePath ? 'WITH_COOKIES' : 'NO_COOKIES';
        const args = getYtDlpBaseArgs(['--dump-single-json', youtubeUrl], useCookies);
        console.log(`[yt-dlp] Running (${modeLabel}) for:`, youtubeUrl);

        execFile('yt-dlp', args, { timeout: YTDLP_JSON_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
            const stderrClean = String(stderr || '').trim();
            const errMsg = String(err?.message || '').trim();
            const errText = stderrClean || errMsg || 'Unknown error';

            if (err || !stdout) {
                console.warn(`[yt-dlp] Failed (${modeLabel}):`, {
                    code: err?.code ?? null,
                    signal: err?.signal ?? null,
                    killed: Boolean(err?.killed),
                    stderr: stderrClean.slice(-800) || '(empty)'
                });
                return resolve({ data: null, rateLimited: isRateLimitedText(errText) });
            }
            try {
                const info = JSON.parse(stdout);
                const formats = Array.isArray(info.formats) ? info.formats : [];
                const videoCandidates = [];

                for (const f of formats) {
                    const ext = String(f.ext || '').toLowerCase();
                    const hasVideo = Boolean(f.vcodec && f.vcodec !== 'none');
                    if (!hasVideo || !f.format_id) continue;

                    const height = Number(f.height) || 0;
                    const label = height ? `${height}p` : (f.format_note || 'Video');
                    const existingIdx = videoCandidates.findIndex((item) => item.label === label);
                    const isMp4 = ext === 'mp4';

                    if (existingIdx === -1) {
                        videoCandidates.push({
                            label,
                            height,
                            isMp4,
                            format: {
                                quality: label,
                                type: 'MP4',
                                url: `ytdlp://${f.format_id}|${youtubeUrl}`
                            }
                        });
                    } else if (isMp4 && !videoCandidates[existingIdx].isMp4) {
                        videoCandidates[existingIdx] = {
                            label,
                            height,
                            isMp4,
                            format: {
                                quality: label,
                                type: 'MP4',
                                url: `ytdlp://${f.format_id}|${youtubeUrl}`
                            }
                        };
                    }
                }

                videoCandidates.sort((a, b) => (b.height - a.height) || (Number(b.isMp4) - Number(a.isMp4)));
                const videoFormats = videoCandidates.map((item) => item.format);

                const audioFormats = [
                    { quality: 'High Quality', type: 'MP3', url: `ytdlp-audio://bestaudio[ext=m4a]/bestaudio|${youtubeUrl}` },
                    { quality: 'Standard Quality', type: 'MP3', url: `ytdlp-audio://bestaudio[ext=m4a]/bestaudio|${youtubeUrl}` }
                ];

                console.log(`[yt-dlp] Success (${modeLabel}) -> videoFormats: ${videoFormats.length}, audioFormats: ${audioFormats.length}`);

                resolve({
                    data: {
                        title: info.title || '',
                        author: info.uploader || info.channel || '',
                        thumbnail: info.thumbnail || extractThumbnail(info, extractYouTubeId(youtubeUrl)),
                        videoFormats,
                        audioFormats
                    },
                    rateLimited: false
                });
            } catch (parseErr) {
                console.warn(`[yt-dlp] JSON parse failed (${modeLabel}):`, parseErr.message || parseErr);
                resolve({ data: null, rateLimited: false });
            }
        });
    });
}

async function fetchYtDlpInfo(youtubeUrl) {
    const videoId = extractYouTubeId(youtubeUrl);
    const cacheKey = videoId || youtubeUrl.trim();

    const cached = infoCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < INFO_CACHE_TTL_MS) {
        console.log('[yt-dlp] Cache hit for:', cacheKey);
        return cached.value;
    }

    if (Date.now() < rateLimitUntil) {
        console.warn('[yt-dlp] Skipping call during 429 cooldown.');
        return { rateLimited: true };
    }

    if (inFlightInfo.has(cacheKey)) {
        console.log('[yt-dlp] Joining in-flight request for:', cacheKey);
        return await inFlightInfo.get(cacheKey);
    }

    const jobPromise = (async () => {
        try {
            return await withYtDlpSlot(async () => {
                const useCookies = Boolean(cookiesFilePath);
                const result = await runYtDlpJsonOnce(youtubeUrl, useCookies);
                if (result.rateLimited) {
                    triggerRateLimitCooldown(`info ${useCookies ? 'WITH_COOKIES' : 'NO_COOKIES'} 429`);
                    return { rateLimited: true };
                }
                return result.data || null;
            });
        } catch (err) {
            if (err.message === 'SERVER_BUSY') {
                return { busy: true };
            }
            return null;
        } finally {
            inFlightInfo.delete(cacheKey);
        }
    })();

    inFlightInfo.set(cacheKey, jobPromise);
    const result = await jobPromise;

    if (result && !result.rateLimited && !result.busy && (result.videoFormats?.length > 0 || result.title)) {
        infoCache.set(cacheKey, { ts: Date.now(), value: result });
    }

    return result;
}

function cleanupTempPrefix(tmpBase) {
    try {
        const prefix = path.basename(tmpBase);
        const dirFiles = fs.readdirSync(os.tmpdir());
        for (const f of dirFiles) {
            if (f.startsWith(prefix)) {
                try {
                    fs.unlinkSync(path.join(os.tmpdir(), f));
                } catch (_) {}
            }
        }
    } catch (_) {}
}

function getCachedBuiltFile(cacheKey) {
    const entry = builtFileCache.get(cacheKey);
    if (!entry) return null;
    if (Date.now() - entry.ts > BUILT_FILE_TTL_MS || !fs.existsSync(entry.filePath)) {
        builtFileCache.delete(cacheKey);
        try {
            if (fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath);
        } catch (_) {}
        return null;
    }
    return entry.filePath;
}

function setCachedBuiltFile(cacheKey, filePath) {
    builtFileCache.set(cacheKey, { ts: Date.now(), filePath });
}

function runYtDlpMp4Once(ytUrl, selector, tmpOutput, useCookies = true) {
    return new Promise((resolve) => {
        const modeLabel = useCookies && cookiesFilePath ? 'WITH_COOKIES' : 'NO_COOKIES';
        const args = getYtDlpBaseArgs([
            '-f', selector,
            '--merge-output-format', 'mp4',
            '-o', tmpOutput,
            ytUrl
        ], useCookies);

        console.log(`[MP4 Build] Starting (${modeLabel}) selector: ${selector}`);
        const proc = spawn('yt-dlp', args);
        let stderrText = '';

        const killTimer = setTimeout(() => {
            try {
                proc.kill('SIGKILL');
            } catch (_) {}
        }, 50000);

        proc.stderr.on('data', (chunk) => {
            stderrText += chunk.toString();
        });

        proc.on('error', (err) => {
            clearTimeout(killTimer);
            resolve({ ok: false, code: -1, stderrText: String(err?.message || err) });
        });

        proc.on('close', (code) => {
            clearTimeout(killTimer);
            const exists = fs.existsSync(tmpOutput);
            const size = exists ? fs.statSync(tmpOutput).size : 0;
            const ok = code === 0 && exists && size >= 1024;
            console.log(`[MP4 Build] Finished (${modeLabel}) code=${code}, ok=${ok}, size=${size}`, ok ? '' : stderrText.trim().slice(-500));
            resolve({ ok, code, stderrText });
        });
    });
}

async function buildOrGetCachedMp4(ytUrl, formatId) {
    const videoId = extractYouTubeId(ytUrl) || ytUrl;
    const cacheKey = `mp4:${videoId}:${formatId}`;
    const existingPath = getCachedBuiltFile(cacheKey);
    if (existingPath) {
        console.log('[MP4 Build] Cache hit:', cacheKey);
        return { ok: true, filePath: existingPath, stderrText: '' };
    }

    if (inFlightBuild.has(cacheKey)) {
        console.log('[MP4 Build] Joining in-flight build:', cacheKey);
        return await inFlightBuild.get(cacheKey);
    }

    const buildPromise = (async () => {
        if (Date.now() < rateLimitUntil) {
            return { ok: false, filePath: null, stderrText: 'HTTP Error 429: Too Many Requests' };
        }
        return await withYtDlpSlot(async () => {
            const tmpBase = path.join(os.tmpdir(), `lim3rd_vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
            const tmpOutput = `${tmpBase}.mp4`;
            const selector = `${formatId}+bestaudio[ext=m4a]/${formatId}/best[ext=mp4]/b`;
            const useCookies = Boolean(cookiesFilePath);

            const res = await runYtDlpMp4Once(ytUrl, selector, tmpOutput, useCookies);
            if (res.ok) {
                setCachedBuiltFile(cacheKey, tmpOutput);
                return { ok: true, filePath: tmpOutput, stderrText: '' };
            }
            cleanupTempPrefix(tmpBase);
            if (isRateLimitedText(res.stderrText)) {
                triggerRateLimitCooldown(`mp4 ${useCookies ? 'WITH_COOKIES' : 'NO_COOKIES'} 429`);
            }
            return { ok: false, filePath: null, stderrText: res.stderrText };
        });
    })().finally(() => {
        inFlightBuild.delete(cacheKey);
    });

    inFlightBuild.set(cacheKey, buildPromise);
    return await buildPromise;
}

function runYtDlpAudioOnce(ytUrl, selector, tmpBase, tmpOutput, useCookies = true) {
    return new Promise((resolve) => {
        const modeLabel = useCookies && cookiesFilePath ? 'WITH_COOKIES' : 'NO_COOKIES';
        const args = getYtDlpBaseArgs([
            '-f', selector,
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '5',
            '-o', `${tmpBase}.%(ext)s`,
            ytUrl
        ], useCookies);

        console.log(`[MP3 Build] Starting (${modeLabel}) selector: ${selector}`);
        const proc = spawn('yt-dlp', args);
        let stderrText = '';

        const killTimer = setTimeout(() => {
            try {
                proc.kill('SIGKILL');
            } catch (_) {}
        }, 45000);

        proc.stderr.on('data', (chunk) => {
            stderrText += chunk.toString();
        });

        proc.on('error', (err) => {
            clearTimeout(killTimer);
            resolve({ ok: false, stderrText: String(err?.message || err) });
        });

        proc.on('close', (code) => {
            clearTimeout(killTimer);
            const ok = code === 0 && fs.existsSync(tmpOutput) && fs.statSync(tmpOutput).size >= 1024;
            console.log(`[MP3 Build] Finished (${modeLabel}) code=${code}, ok=${ok}`, ok ? '' : stderrText.trim().slice(-500));
            resolve({ ok, stderrText });
        });
    });
}

async function buildOrGetCachedAudio(ytUrl, audioSelector) {
    const videoId = extractYouTubeId(ytUrl) || ytUrl;
    const cacheKey = `mp3:${videoId}:${audioSelector}`;
    const existingPath = getCachedBuiltFile(cacheKey);
    if (existingPath) {
        console.log('[MP3 Build] Cache hit:', cacheKey);
        return { ok: true, filePath: existingPath, stderrText: '' };
    }

    if (inFlightBuild.has(cacheKey)) {
        console.log('[MP3 Build] Joining in-flight build:', cacheKey);
        return await inFlightBuild.get(cacheKey);
    }

    const buildPromise = (async () => {
        if (Date.now() < rateLimitUntil) {
            return { ok: false, filePath: null, stderrText: 'HTTP Error 429: Too Many Requests' };
        }
        return await withYtDlpSlot(async () => {
            const tmpBase = path.join(os.tmpdir(), `lim3rd_aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
            const tmpOutput = `${tmpBase}.mp3`;
            const useCookies = Boolean(cookiesFilePath);

            const res = await runYtDlpAudioOnce(ytUrl, audioSelector, tmpBase, tmpOutput, useCookies);
            if (res.ok) {
                setCachedBuiltFile(cacheKey, tmpOutput);
                return { ok: true, filePath: tmpOutput, stderrText: '' };
            }
            cleanupTempPrefix(tmpBase);
            if (isRateLimitedText(res.stderrText)) {
                triggerRateLimitCooldown(`mp3 ${useCookies ? 'WITH_COOKIES' : 'NO_COOKIES'} 429`);
            }
            return { ok: false, filePath: null, stderrText: res.stderrText };
        });
    })().finally(() => {
        inFlightBuild.delete(cacheKey);
    });

    inFlightBuild.set(cacheKey, buildPromise);
    return await buildPromise;
}

app.get('/region', (req, res) => {
    const cfCountry = req.headers['cf-ipcountry'];
    const vercelCountry = req.headers['x-vercel-ip-country'];
    const renderCountry = req.headers['x-country-code'];

    const countryCode = (cfCountry || vercelCountry || renderCountry || 'PH')
        .toString()
        .trim()
        .toUpperCase();

    return res.json({ countryCode });
});

app.get('/proxy-download', async (req, res) => {
    const fileUrl = req.query.url;
    const rawTitle = req.query.title || 'Lim3rd_Media';
    const ext = (req.query.ext || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';

    if (!fileUrl) {
        return res.status(400).json({ error: 'Missing media URL' });
    }

    if (fileUrl.startsWith('ytdlp://')) {
        const rawPayload = fileUrl.slice('ytdlp://'.length);
        const pipeIdx = rawPayload.indexOf('|');
        const formatId = pipeIdx !== -1 ? rawPayload.slice(0, pipeIdx) : 'best[ext=mp4]';
        const ytUrl = pipeIdx !== -1 ? rawPayload.slice(pipeIdx + 1) : '';

        if (!ytUrl) {
            return res.status(400).json({ error: 'Invalid yt-dlp MP4 target' });
        }

        const safeTitle = formatTitleWithLim3rd(rawTitle);
        const filename = `${safeTitle}.mp4`;
        const result = await buildOrGetCachedMp4(ytUrl, formatId);

        if (!result.ok || !result.filePath || !fs.existsSync(result.filePath)) {
            if (!res.headersSent) {
                const hit429 = isRateLimitedText(result.stderrText);
                res.status(hit429 ? 429 : 502).json({
                    error: hit429
                        ? 'YouTube rate-limited the server (HTTP 429). Please wait a few minutes and try again.'
                        : 'yt-dlp failed to build playable MP4.'
                });
            }
            return;
        }

        try {
            const stat = fs.statSync(result.filePath);
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Length', stat.size);
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`
            );
            fs.createReadStream(result.filePath).pipe(res);
        } catch (_) {
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to stream generated MP4.' });
            }
        }
        return;
    }

    if (fileUrl.startsWith('ytdlp-audio://')) {
        const rawPayload = fileUrl.slice('ytdlp-audio://'.length);
        const pipeIdx = rawPayload.indexOf('|');
        const audioSelector = pipeIdx !== -1 ? rawPayload.slice(0, pipeIdx) : 'bestaudio';
        const ytUrl = pipeIdx !== -1 ? rawPayload.slice(pipeIdx + 1) : '';

        if (!ytUrl) {
            return res.status(400).json({ error: 'Invalid yt-dlp audio target' });
        }

        const safeTitle = formatTitleWithLim3rd(rawTitle);
        const filename = `${safeTitle}.mp3`;
        const attempt = await buildOrGetCachedAudio(ytUrl, audioSelector);

        if (!attempt.ok || !attempt.filePath || !fs.existsSync(attempt.filePath)) {
            if (!res.headersSent) {
                const hit429 = isRateLimitedText(attempt.stderrText);
                res.status(hit429 ? 429 : 502).json({
                    error: hit429
                        ? 'YouTube rate-limited the server (HTTP 429). Please wait a few minutes and try again.'
                        : 'Failed to build MP3 audio.'
                });
            }
            return;
        }

        try {
            const stat = fs.statSync(attempt.filePath);
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Content-Length', stat.size);
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`
            );
            fs.createReadStream(attempt.filePath).pipe(res);
        } catch (_) {
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to stream generated MP3.' });
            }
        }
        return;
    }

    if (ext === 'mp4' && (fileUrl.includes('.m3u8') || fileUrl.includes('/manifest/hls_'))) {
        return res.status(400).json({
            error: 'HLS playlist (.m3u8) cannot be saved directly as a playable MP4 file.'
        });
    }

    try {
        const upstream = await fetchWithTimeout(fileUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': 'https://www.youtube.com/',
                'Origin': 'https://www.youtube.com',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        }, 20000);

        const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
        const isInvalidMediaType =
            contentType.includes('text/html') ||
            contentType.includes('application/json') ||
            contentType.includes('text/plain') ||
            contentType.includes('mpegurl');

        if (!upstream.ok || !upstream.body || isInvalidMediaType) {
            return res.status(502).json({
                error: `YouTube/GoogleVideo blocked server proxy (${upstream.status}). Try another format or audio MP3.`,
                directUrl: fileUrl
            });
        }

        const safeTitle = formatTitleWithLim3rd(rawTitle);
        const filename = `${safeTitle}.${ext}`;
        const finalContentType = contentType || (ext === 'mp3' ? 'audio/mpeg' : 'video/mp4');
        const contentLength = upstream.headers.get('content-length');

        res.setHeader('Content-Type', finalContentType);
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`
        );
        if (contentLength) {
            res.setHeader('Content-Length', contentLength);
        }

        Readable.fromWeb(upstream.body).pipe(res);
    } catch (_) {
        return res.status(500).json({ error: 'Failed to stream media file.' });
    }
});

app.get('/download', async (req, res) => {
    const rawURL = req.query.url;
    console.log('[GET /download] Request URL:', rawURL || 'MISSING');

    if (!rawURL) {
        return res.status(400).json({ error: 'Please input a YouTube link' });
    }

    try {
        const isDirectYouTube =
            rawURL.includes('youtube.com') ||
            rawURL.includes('youtu.be');

        const targetURL = isDirectYouTube ? rawURL : await resolveRedirectUrl(rawURL);

        if (targetURL.includes('youtube.com') || targetURL.includes('youtu.be')) {
            const videoId = extractYouTubeId(targetURL);
            const cacheKey = videoId || targetURL.trim();
            const cachedInfo = infoCache.get(cacheKey);

            let oembedData = { title: 'Lim3rd Media File', thumbnail: '' };
            let ytDlpData = null;

            if (cachedInfo && Date.now() - cachedInfo.ts < INFO_CACHE_TTL_MS) {
                ytDlpData = cachedInfo.value;
            } else {
                [oembedData, ytDlpData] = await Promise.all([
                    fetchYouTubeOEmbed(targetURL).catch(() => ({ title: 'Lim3rd Media File', thumbnail: '' })),
                    fetchYtDlpInfo(targetURL).catch(() => null)
                ]);
            }

            if (ytDlpData?.rateLimited) {
                return res.status(429).json({
                    error: 'YouTube temporarily rate-limited the server (429). Please wait a few minutes and try again.'
                });
            }

            if (ytDlpData?.busy) {
                return res.status(429).json({
                    error: 'Server is busy processing another request. Please wait a few seconds.'
                });
            }

            const videoFormats = ytDlpData?.videoFormats || [];
            const audioFormats = ytDlpData?.audioFormats || [
                { quality: 'High Quality', type: 'MP3', url: `ytdlp-audio://bestaudio[ext=m4a]/bestaudio|${targetURL}` },
                { quality: 'Standard Quality', type: 'MP3', url: `ytdlp-audio://bestaudio[ext=m4a]/bestaudio|${targetURL}` }
            ];

            const title = ytDlpData?.title || oembedData?.title || 'Lim3rd Media File';
            const author = ytDlpData?.author || 'Lim3rd Universal Downloader';
            const thumbnail = ytDlpData?.thumbnail || oembedData?.thumbnail || '';

            console.log('[GET /download] Done -> title:', title, '| videoFormats:', videoFormats.length, '| audioFormats:', audioFormats.length);

            return res.json({
                status: 'success',
                title,
                author,
                thumbnail,
                videoFormats,
                audioFormats
            });
        }

        return res.status(400).json({ error: 'Please input a YouTube link' });
    } catch (err) {
        console.error('[GET /download] API error:', err.message || err);
        return res.status(500).json({ error: 'Server processing error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`[Server] Running on port ${PORT}`));
