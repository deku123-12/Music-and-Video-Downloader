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

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || process.env.key;
const AUDIO_API_HOST = 'yt-search-and-download-mp3.p.rapidapi.com';

let cookiesFilePath = null;
if (process.env.YTDLP_COOKIES_B64) {
    try {
        const cleanB64 = String(process.env.YTDLP_COOKIES_B64).replace(/\s+/g, '');
        const decodedBuffer = Buffer.from(cleanB64, 'base64');
        const tmpCookies = path.join(os.tmpdir(), 'ytdlp_cookies.txt');
        fs.writeFileSync(tmpCookies, decodedBuffer);
        cookiesFilePath = tmpCookies;
        console.error(`[LIM3RD] Loaded yt-dlp cookies (${decodedBuffer.length} bytes) from YTDLP_COOKIES_B64.`);
    } catch (e) {
        console.error('[LIM3RD] Failed to write yt-dlp cookies file:', e);
    }
}

function getYtDlpBaseArgs(extraArgs = []) {
    const args = [
        '--no-playlist',
        '--no-warnings',
        '--extractor-args',
        'youtube:player_client=android,web'
    ];
    if (cookiesFilePath) {
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

function isPlayableDirectUrl(url = '') {
    if (typeof url !== 'string' || !url.startsWith('http')) return false;

    if (
        url.includes('.m3u8') ||
        url.includes('/manifest/hls_') ||
        url.includes('/playlist/')
    ) {
        return false;
    }

    if (
        url.includes('ytimg.com') ||
        url.includes('googleusercontent.com') ||
        /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url)
    ) {
        return false;
    }

    return true;
}

function findAnyMediaUrl(obj) {
    if (!obj) return null;
    if (typeof obj === 'string') {
        if (isPlayableDirectUrl(obj)) {
            return obj;
        }
        return null;
    }
    if (Array.isArray(obj)) {
        for (const item of obj) {
            const found = findAnyMediaUrl(item);
            if (found) return found;
        }
    } else if (typeof obj === 'object') {
        const priorityKeys = ['download_url', 'downloadUrl', 'mp3', 'link', 'url', 'dlink', 'file', 'video', 'audio', 'mp4', 'href', 'src'];
        for (const key of priorityKeys) {
            if (obj[key]) {
                const found = findAnyMediaUrl(obj[key]);
                if (found) return found;
            }
        }
        for (const key of Object.keys(obj)) {
            if (key === 'manifest_url' || key.toLowerCase().includes('thumb') || key.toLowerCase().includes('image')) continue;
            const found = findAnyMediaUrl(obj[key]);
            if (found) return found;
        }
    }
    return null;
}

function extractTitle(payload, fallback = 'Lim3rd Media File') {
    return (
        payload?.title ||
        payload?.videoDetails?.title ||
        payload?.result?.title ||
        payload?.data?.title ||
        payload?.info?.title ||
        fallback
    );
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
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
        }, 10000);
        return response.url || url;
    } catch (err) {
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
            8000
        );
        if (!res.ok) return { title: 'Lim3rd Media File', thumbnail: fallbackThumb };
        const data = await res.json();
        return {
            title: data?.title || 'Lim3rd Media File',
            thumbnail: data?.thumbnail_url || fallbackThumb
        };
    } catch (_) {
        return { title: 'Lim3rd Media File', thumbnail: fallbackThumb };
    }
}

function fetchYtDlpInfo(youtubeUrl) {
    return new Promise((resolve) => {
        const args = getYtDlpBaseArgs(['--dump-single-json', youtubeUrl]);
        console.error(`[LIM3RD] Fetching yt-dlp metadata for: ${youtubeUrl}`);

        execFile('yt-dlp', args, { timeout: 35000, maxBuffer: 1024 * 1024 * 25 }, (err, stdout, stderr) => {
            if (err || !stdout) {
                console.error(`[LIM3RD] yt-dlp info failed: ${err?.message || err}`);
                if (stderr) {
                    console.error(`[LIM3RD] yt-dlp stderr: ${String(stderr).slice(-600)}`);
                }
                return resolve(null);
            }

            try {
                const info = JSON.parse(stdout);
                const formats = Array.isArray(info.formats) ? info.formats : [];
                const videoFormats = [];
                const seen = new Set();

                for (const f of formats) {
                    const ext = String(f.ext || '').toLowerCase();
                    const hasVideo = f.vcodec && f.vcodec !== 'none';
                    const hasAudio = f.acodec && f.acodec !== 'none';
                    if (ext === 'mp4' && hasVideo && hasAudio && f.format_id) {
                        const label = f.height ? `${f.height}p` : (f.format_note || 'MP4');
                        const key = `mp4-${label}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            videoFormats.push({
                                quality: label,
                                type: 'MP4',
                                url: `ytdlp://${f.format_id}|${youtubeUrl}`
                            });
                        }
                    }
                }

                for (const f of formats) {
                    const ext = String(f.ext || '').toLowerCase();
                    const hasVideo = f.vcodec && f.vcodec !== 'none';
                    const hasAudio = f.acodec && f.acodec !== 'none';
                    if (ext === 'mp4' && hasVideo && !hasAudio && f.format_id && f.height) {
                        const label = `${f.height}p`;
                        const key = `mp4-${label}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            videoFormats.push({
                                quality: label,
                                type: 'MP4',
                                url: `ytdlp://${f.format_id}|${youtubeUrl}`
                            });
                        }
                    }
                }

                if (videoFormats.length === 0 && formats.length > 0) {
                    videoFormats.push({
                        quality: 'Best MP4',
                        type: 'MP4',
                        url: `ytdlp://bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best|${youtubeUrl}`
                    });
                }

                const hasAnyAudioStream = formats.some((f) => f.acodec && f.acodec !== 'none' && f.format_id);
                const fallbackAudioFormats = hasAnyAudioStream
                    ? [
                        { quality: 'High Quality', type: 'MP3', url: `ytdlp-audio://bestaudio[ext=m4a]/bestaudio|${youtubeUrl}` },
                        { quality: 'Standard Quality', type: 'MP3', url: `ytdlp-audio://bestaudio[ext=m4a]/bestaudio|${youtubeUrl}` }
                    ]
                    : [];

                console.error(`[LIM3RD] yt-dlp info success: ${info.title || 'Unknown'} (${videoFormats.length} video formats)`);

                resolve({
                    title: info.title || '',
                    author: info.uploader || info.channel || '',
                    thumbnail: info.thumbnail || extractThumbnail(info, extractYouTubeId(youtubeUrl)),
                    videoFormats,
                    fallbackAudioFormats
                });
            } catch (parseErr) {
                console.error(`[LIM3RD] yt-dlp JSON parse failed: ${parseErr?.message || parseErr}`);
                resolve(null);
            }
        });
    });
}

async function fetchYouTubeAudio(youtubeUrl) {
    if (!RAPIDAPI_KEY) return null;

    const apiEndpoint = `https://${AUDIO_API_HOST}/mp3?url=${encodeURIComponent(youtubeUrl)}`;
    try {
        const apiResponse = await fetchWithTimeout(apiEndpoint, {
            method: 'GET',
            headers: {
                'x-rapidapi-host': AUDIO_API_HOST,
                'x-rapidapi-key': RAPIDAPI_KEY
            }
        }, 12000);

        const rawText = await apiResponse.text();
        let result = {};
        try {
            result = JSON.parse(rawText);
        } catch (e) {
            return null;
        }

        const audioUrl = findAnyMediaUrl(result);

        if (apiResponse.ok && audioUrl) {
            return {
                title: extractTitle(result, ''),
                thumbnail: extractThumbnail(result),
                formats: [
                    { quality: 'High Quality', type: 'MP3', url: audioUrl },
                    { quality: 'Standard Quality', type: 'MP3', url: audioUrl }
                ]
            };
        }
    } catch (_) {}

    return null;
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
        const tmpBase = path.join(os.tmpdir(), `lim3rd_vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
        const tmpOutput = `${tmpBase}.mp4`;

        const formatSelector = `${formatId}+bestaudio[ext=m4a]/${formatId}/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best`;
        const args = getYtDlpBaseArgs([
            '-f', formatSelector,
            '--merge-output-format', 'mp4',
            '--remux-video', 'mp4',
            '-o', tmpOutput,
            ytUrl
        ]);

        const proc = spawn('yt-dlp', args);
        let stderrText = '';

        proc.stderr.on('data', (chunk) => {
            stderrText += chunk.toString();
        });

        proc.on('error', (err) => {
            console.error('[LIM3RD] yt-dlp spawn error:', err);
            cleanupTempPrefix(tmpBase);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to start yt-dlp MP4 download.' });
            }
        });

        proc.on('close', (code) => {
            if (code !== 0 || !fs.existsSync(tmpOutput)) {
                console.error('[LIM3RD] yt-dlp MP4 build failed:', code, stderrText.slice(-500));
                cleanupTempPrefix(tmpBase);
                if (!res.headersSent) {
                    const isBotCheck = /not a bot|sign in to confirm/i.test(stderrText);
                    const isFormatUnavailable = /requested format is not available/i.test(stderrText);
                    res.status(502).json({
                        error: isBotCheck
                            ? 'YouTube bot check blocked MP4 build. Refresh YTDLP_COOKIES_B64 or try MP3 audio.'
                            : isFormatUnavailable
                                ? 'Requested video format is unavailable for this video. Try another quality or MP3 audio.'
                                : 'yt-dlp failed to build playable MP4.'
                    });
                }
                return;
            }

            try {
                const stat = fs.statSync(tmpOutput);
                if (!stat.size || stat.size < 1024) {
                    cleanupTempPrefix(tmpBase);
                    if (!res.headersSent) {
                        res.status(502).json({ error: 'Generated MP4 file is empty or incomplete.' });
                    }
                    return;
                }

                res.setHeader('Content-Type', 'video/mp4');
                res.setHeader('Content-Length', stat.size);
                res.setHeader(
                    'Content-Disposition',
                    `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`
                );

                const stream = fs.createReadStream(tmpOutput);
                stream.pipe(res);
                stream.on('close', () => cleanupTempPrefix(tmpBase));
                stream.on('error', () => {
                    cleanupTempPrefix(tmpBase);
                    if (!res.headersSent) res.status(500).end();
                });
            } catch (e) {
                cleanupTempPrefix(tmpBase);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Failed to read generated MP4.' });
                }
            }
        });

        req.on('close', () => {
            if (!proc.killed) {
                proc.kill('SIGKILL');
            }
            cleanupTempPrefix(tmpBase);
        });

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
        const tmpBase = path.join(os.tmpdir(), `lim3rd_aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
        const tmpOutput = `${tmpBase}.mp3`;

        const args = getYtDlpBaseArgs([
            '-f', audioSelector,
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '0',
            '-o', `${tmpBase}.%(ext)s`,
            ytUrl
        ]);

        const proc = spawn('yt-dlp', args);
        let stderrText = '';

        proc.stderr.on('data', (chunk) => {
            stderrText += chunk.toString();
        });

        proc.on('error', () => {
            cleanupTempPrefix(tmpBase);
            if (!res.headersSent) res.status(500).json({ error: 'Failed to extract audio.' });
        });

        proc.on('close', (code) => {
            if (code !== 0 || !fs.existsSync(tmpOutput)) {
                console.error('[LIM3RD] yt-dlp MP3 build failed:', code, stderrText.slice(-500));
                cleanupTempPrefix(tmpBase);
                if (!res.headersSent) res.status(502).json({ error: 'Failed to build MP3 audio.' });
                return;
            }

            try {
                const stat = fs.statSync(tmpOutput);
                res.setHeader('Content-Type', 'audio/mpeg');
                res.setHeader('Content-Length', stat.size);
                res.setHeader(
                    'Content-Disposition',
                    `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`
                );
                const stream = fs.createReadStream(tmpOutput);
                stream.pipe(res);
                stream.on('close', () => cleanupTempPrefix(tmpBase));
                stream.on('error', () => cleanupTempPrefix(tmpBase));
            } catch (_) {
                cleanupTempPrefix(tmpBase);
            }
        });

        req.on('close', () => {
            if (!proc.killed) proc.kill('SIGKILL');
            cleanupTempPrefix(tmpBase);
        });

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
        }, 25000);

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
    } catch (err) {
        console.error('[LIM3RD] Proxy download error:', err);
        return res.status(500).json({ error: 'Failed to stream media file.' });
    }
});

app.get('/download', async (req, res) => {
    const rawURL = req.query.url;
    if (!rawURL) {
        return res.status(400).json({ error: 'Please input a YouTube link' });
    }

    try {
        const isDirectYouTube =
            rawURL.includes('youtube.com') ||
            rawURL.includes('youtu.be');

        const targetURL = isDirectYouTube ? rawURL : await resolveRedirectUrl(rawURL);

        if (targetURL.includes('youtube.com') || targetURL.includes('youtu.be')) {
            const [oembedData, ytDlpData, audioData] = await Promise.all([
                fetchYouTubeOEmbed(targetURL).catch(() => ({ title: 'Lim3rd Media File', thumbnail: '' })),
                fetchYtDlpInfo(targetURL).catch(() => null),
                fetchYouTubeAudio(targetURL).catch(() => null)
            ]);

            let videoFormats = ytDlpData?.videoFormats || [];
            if (videoFormats.length === 0) {
                videoFormats = [
                    { quality: '720p', type: 'MP4', url: `ytdlp://bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[ext=mp4]|${targetURL}` },
                    { quality: '360p', type: 'MP4', url: `ytdlp://bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360][ext=mp4]/best[ext=mp4]|${targetURL}` }
                ];
            }

            const audioFormats =
                audioData && Array.isArray(audioData.formats) && audioData.formats.length > 0
                    ? audioData.formats
                    : (ytDlpData?.fallbackAudioFormats || [
                        { quality: 'High Quality', type: 'MP3', url: `ytdlp-audio://bestaudio[ext=m4a]/bestaudio|${targetURL}` },
                        { quality: 'Standard Quality', type: 'MP3', url: `ytdlp-audio://bestaudio[ext=m4a]/bestaudio|${targetURL}` }
                    ]);

            const title = ytDlpData?.title || audioData?.title || oembedData?.title || 'Lim3rd Media File';
            const author = ytDlpData?.author || 'Lim3rd Universal Downloader';
            const thumbnail = ytDlpData?.thumbnail || audioData?.thumbnail || oembedData?.thumbnail || '';

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
        console.error('[LIM3RD] API error:', err);
        return res.status(500).json({ error: 'Server processing error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`[LIM3RD] Server running on port ${PORT}`));
