const express = require('express');
const cors = require('cors');
const { Readable } = require('stream');

const app = express();
app.use(cors());
app.use(express.json());

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || process.env.key;
const AUDIO_API_HOST = 'yt-search-and-download-mp3.p.rapidapi.com';

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
    const thumb =
        payload?.thumbnail ||
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

    if (ext === 'mp4' && (fileUrl.includes('.m3u8') || fileUrl.includes('/manifest/hls_'))) {
        return res.status(400).json({
            error: 'HLS playlist (.m3u8) cannot be saved directly as a playable MP4 file.'
        });
    }

    try {
        const upstream = await fetchWithTimeout(fileUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': 'https://www.youtube.com/'
            }
        }, 25000);

        const contentType = upstream.headers.get('content-type') || '';
        const isInvalidMediaType =
            contentType.includes('text/html') ||
            contentType.includes('application/json') ||
            contentType.includes('text/plain') ||
            contentType.includes('mpegurl');

        if (!upstream.ok || !upstream.body || isInvalidMediaType) {
            return res.status(502).json({
                error: 'Media stream is unavailable or not a direct playable file.'
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
        console.error('Proxy download error:', err);
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

        if (targetURL.includes('facebook.com') || targetURL.includes('fb.watch') || targetURL.includes('fb.me')) {
            const fbApiResponse = await fetchWithTimeout(
                `https://apis.davidcyriltech.my.id/download/fbdl?url=${encodeURIComponent(targetURL)}`,
                {},
                12000
            );
            const fbResult = await fbApiResponse.json();

            if (fbResult && fbResult.status === 200 && fbResult.result) {
                const videoData = fbResult.result;
                const videoFormats = [];
                if (videoData.hd || videoData.url) {
                    videoFormats.push({ quality: 'HD / 720p', type: 'MP4', url: videoData.hd || videoData.url });
                }
                if (videoData.sd) {
                    videoFormats.push({ quality: 'SD / 360p', type: 'MP4', url: videoData.sd });
                }

                const audioFormats = videoData.audio
                    ? [{ quality: 'Audio Stream', type: 'MP3', url: videoData.audio }]
                    : [];

                return res.json({
                    status: 'success',
                    title: videoData.title || 'Lim3rd Facebook Media',
                    author: 'Lim3rd Universal Downloader',
                    thumbnail: videoData.thumbnail || '',
                    videoFormats,
                    audioFormats
                });
            }
        }

        if (targetURL.includes('youtube.com') || targetURL.includes('youtu.be')) {
            const [oembedData, audioData] = await Promise.all([
                fetchYouTubeOEmbed(targetURL).catch(() => ({ title: 'Lim3rd Media File', thumbnail: '' })),
                fetchYouTubeAudio(targetURL).catch(() => null)
            ]);

            const audioFormats = audioData ? audioData.formats : [];
            const title = audioData?.title || oembedData?.title || 'Lim3rd Media File';
            const thumbnail = audioData?.thumbnail || oembedData?.thumbnail || '';

            return res.json({
                status: 'success',
                title,
                author: 'Lim3rd Universal Downloader',
                thumbnail,
                videoFormats: [],
                audioFormats
            });
        }

        return res.status(400).json({ error: 'Please input a YouTube link' });
    } catch (err) {
        console.error('API error:', err);
        return res.status(500).json({ error: 'Server processing error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
