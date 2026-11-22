const LIM3RD_SERVER_BUSY_MSG =
    "Lim3rd server\n\nWe are busy fixing the server, please wait patiently";

const translations = {
    en: {
        subtitle: "Download videos and music instantly in high quality.",
        placeholder: "Paste YouTube link here...",
        paste: "Paste",
        download: "Fetch Media",
        downloadNow: "Download File",
        videoTab: "Video",
        audioTab: "Audio",
        regionPrefix: "REGION",
        processing: "Fetching media details, please wait...",
        errorLink: "Please input a YouTube link",
        errorClipboard: "Clipboard access blocked. Please paste manually.",
        errorProcess: LIM3RD_SERVER_BUSY_MSG,
        errorConn: LIM3RD_SERVER_BUSY_MSG
    },
    tl: {
        subtitle: "Mag-download ng mga video at musika nang mabilis at mataas ang kalidad.",
        placeholder: "I-paste ang YouTube link dito...",
        paste: "I-paste",
        download: "Kunin ang Media",
        downloadNow: "I-download ang File",
        videoTab: "Video",
        audioTab: "Audio",
        regionPrefix: "REHIYON",
        processing: "Kinukuha ang detalye, mangyaring maghintay...",
        errorLink: "Please input a YouTube link",
        errorClipboard: "Hindi ma-access ang clipboard. I-paste nang mano-mano.",
        errorProcess: LIM3RD_SERVER_BUSY_MSG,
        errorConn: LIM3RD_SERVER_BUSY_MSG
    },
    zh: {
        subtitle: "立即以高清格式下载视频和音乐。",
        placeholder: "在此粘贴 YouTube 链接...",
        paste: "粘贴",
        download: "获取媒体",
        downloadNow: "下载文件",
        videoTab: "视频",
        audioTab: "音频",
        regionPrefix: "地区",
        processing: "正在获取媒体详情，请稍候...",
        errorLink: "Please input a YouTube link",
        errorClipboard: "剪贴板访问被阻止，请手动粘贴。",
        errorProcess: LIM3RD_SERVER_BUSY_MSG,
        errorConn: LIM3RD_SERVER_BUSY_MSG
    }
};

const BACKEND_BASE_URL = 'https://music-and-video-downloader.onrender.com';

let currentLang = 'en';
let activeDownloadUrl = '';
let activeDownloadExt = 'mp4';
let activeMediaTitle = 'Lim3rd_Media';
let globalData = null;
let currentRegionCode = 'PH';

function updateLiveClock() {
    const clockEl = document.getElementById('liveClock');
    if (!clockEl) return;

    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    clockEl.innerText = `${hours}:${minutes}:${seconds}`;
}

function updateRegionBadge() {
    const regionEl = document.getElementById('regionBadge');
    if (!regionEl) return;
    const prefix = translations[currentLang]?.regionPrefix || 'REGION';
    regionEl.innerText = `${prefix}: ${currentRegionCode}`;
}

async function detectUserRegion() {
    try {
        const res = await fetchWithTimeout(`${BACKEND_BASE_URL}/region`, {}, 8000);
        if (res.ok) {
            const info = await res.json();
            if (info && info.countryCode) {
                currentRegionCode = String(info.countryCode).toUpperCase();
                updateRegionBadge();
                return;
            }
        }
    } catch (e) {
        // Fallback to timezone region detection
    }

    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
        if (tz.includes('Manila')) currentRegionCode = 'PH';
        else if (tz.includes('Tokyo')) currentRegionCode = 'JP';
        else if (tz.includes('Seoul')) currentRegionCode = 'KR';
        else if (tz.includes('Singapore')) currentRegionCode = 'SG';
        else if (tz.includes('Shanghai')) currentRegionCode = 'CN';
        else if (tz.includes('Los_Angeles') || tz.includes('New_York')) currentRegionCode = 'US';
    } catch (e) {
        currentRegionCode = 'PH';
    }
    updateRegionBadge();
}

function playIntroAnimation() {
    const splash = document.getElementById('introSplash');
    const container = document.querySelector('.container');
    const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reducedMotion) {
        if (splash) splash.remove();
        if (container) container.classList.add('ready');
        return;
    }

    const revealApp = () => {
        if (splash) splash.classList.add('hide');
        if (container) container.classList.add('ready');
        setTimeout(() => {
            if (splash && splash.parentNode) splash.remove();
        }, 500);
    };

    if (splash) {
        splash.addEventListener('click', revealApp, { once: true });
    }

    setTimeout(revealApp, 1150);
}

window.addEventListener('DOMContentLoaded', () => {
    playIntroAnimation();
    updateLiveClock();
    setInterval(updateLiveClock, 1000);
    updateRegionBadge();
    detectUserRegion();

    const langSelect = document.getElementById('langSelect');
    if (langSelect) langSelect.addEventListener('change', changeLanguage);

    const mediaInput = document.getElementById('mediaInput');
    if (mediaInput) mediaInput.addEventListener('input', toggleClear);

    const clearBtn = document.getElementById('clearBtn');
    if (clearBtn) clearBtn.addEventListener('click', clearInput);

    const pasteBtn = document.getElementById('pasteBtn');
    if (pasteBtn) pasteBtn.addEventListener('click', pasteText);

    const fetchBtn = document.getElementById('fetchBtn');
    if (fetchBtn) fetchBtn.addEventListener('click', fetchMedia);

    const modeButtons = document.querySelectorAll('.mode-switch .mode-btn');
    if (modeButtons[0]) modeButtons[0].addEventListener('click', () => switchTab('video'));
    if (modeButtons[1]) modeButtons[1].addEventListener('click', () => switchTab('audio'));
});

function changeLanguage() {
    const select = document.getElementById('langSelect');
    if (!select) return;
    currentLang = select.value;
    const t = translations[currentLang];

    if (document.getElementById('uiSubtitle')) document.getElementById('uiSubtitle').innerText = t.subtitle;
    if (document.getElementById('mediaInput')) document.getElementById('mediaInput').placeholder = t.placeholder;
    if (document.getElementById('uiPaste')) document.getElementById('uiPaste').innerText = t.paste;
    if (document.getElementById('uiDownload')) document.getElementById('uiDownload').innerText = t.download;
    if (document.getElementById('uiDownloadNow')) document.getElementById('uiDownloadNow').innerText = t.downloadNow;

    const videoTabText = document.getElementById('uiVideoTab');
    const audioTabText = document.getElementById('uiAudioTab');
    if (videoTabText) videoTabText.innerText = t.videoTab;
    if (audioTabText) audioTabText.innerText = t.audioTab;

    updateRegionBadge();
}

function toggleClear() {
    const input = document.getElementById('mediaInput');
    const clearBtn = document.getElementById('clearBtn');
    if (input && clearBtn) {
        clearBtn.style.display = input.value.length > 0 ? 'block' : 'none';
    }
}

function clearInput() {
    const input = document.getElementById('mediaInput');
    if (!input) return;
    input.value = '';
    toggleClear();
    input.focus();
}

async function pasteText() {
    const t = translations[currentLang];
    try {
        const text = await navigator.clipboard.readText();
        if (text && document.getElementById('mediaInput')) {
            document.getElementById('mediaInput').value = text.trim();
            toggleClear();
        }
    } catch (err) {
        alert(t.errorClipboard);
    }
}

function extractUrl(rawText) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const matches = rawText.match(urlRegex);
    return matches ? matches[0] : null;
}

function isValidYouTubeUrl(url) {
    return /^(https?:\/\/)?(www\.)?(m\.)?(youtube\.com\/(watch\?v=|shorts\/|live\/|embed\/)|youtu\.be\/)[\w-]+/i.test(url);
}

function setActiveFormat(url, type = 'mp4') {
    activeDownloadUrl = url;
    activeDownloadExt = (type || 'mp4').toLowerCase();
}

function renderFormatCards(gridElement, formats, badgeClass) {
    if (!gridElement) return;
    gridElement.innerHTML = '';

    if (!Array.isArray(formats) || formats.length === 0) {
        gridElement.innerHTML = `<p style="opacity:0.8; font-size:0.9rem;">No stream returned for this tab yet.</p>`;
        setActiveFormat('', badgeClass);
        return;
    }

    formats.forEach((fmt, index) => {
        const card = document.createElement('div');
        card.className = `format-card ${index === 0 ? 'selected' : ''}`;
        card.innerHTML = `
            <span class="q-text">${fmt.quality}</span>
            <span class="badge ${badgeClass}">${fmt.type}</span>
        `;
        card.onclick = () => {
            gridElement.querySelectorAll('.format-card').forEach((c) => c.classList.remove('selected'));
            card.classList.add('selected');
            setActiveFormat(fmt.url, fmt.type);
        };
        gridElement.appendChild(card);
    });
}

function switchTab(type) {
    if (!globalData) return;

    const modeButtons = document.querySelectorAll('.mode-switch .mode-btn');
    const videoTabBtn = modeButtons[0] || null;
    const audioTabBtn = modeButtons[1] || null;
    const videoTabContent = document.getElementById('videoTabContent');
    const audioTabContent = document.getElementById('audioTabContent');
    const videoGrid = document.getElementById('videoGrid');
    const audioGrid = document.getElementById('audioGrid');

    if (videoTabBtn) videoTabBtn.classList.remove('active');
    if (audioTabBtn) audioTabBtn.classList.remove('active');
    if (videoTabContent) videoTabContent.classList.remove('active');
    if (audioTabContent) audioTabContent.classList.remove('active');

    if (type === 'video') {
        if (videoTabBtn) videoTabBtn.classList.add('active');
        if (videoTabContent) {
            videoTabContent.style.display = 'block';
            videoTabContent.classList.add('active');
        }
        if (audioTabContent) {
            audioTabContent.style.display = 'none';
        }
        renderFormatCards(videoGrid, globalData.videoFormats || [], 'mp4');
        if (globalData.videoFormats && globalData.videoFormats.length > 0) {
            setActiveFormat(globalData.videoFormats[0].url, globalData.videoFormats[0].type);
        } else {
            setActiveFormat('', 'mp4');
        }
    } else {
        if (audioTabBtn) audioTabBtn.classList.add('active');
        if (audioTabContent) {
            audioTabContent.style.display = 'block';
            audioTabContent.classList.add('active');
        }
        if (videoTabContent) {
            videoTabContent.style.display = 'none';
        }
        renderFormatCards(audioGrid, globalData.audioFormats || [], 'mp3');
        if (globalData.audioFormats && globalData.audioFormats.length > 0) {
            setActiveFormat(globalData.audioFormats[0].url, globalData.audioFormats[0].type);
        } else {
            setActiveFormat('', 'mp3');
        }
    }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function fetchMedia() {
    const t = translations[currentLang];
    const rawInput = document.getElementById('mediaInput')?.value.trim() || '';
    const cleanUrl = extractUrl(rawInput) || rawInput;

    const resultBox = document.getElementById('resultBox');
    const statusMsg = document.getElementById('statusMsg');
    const previewCard = document.getElementById('previewCard');
    const mediaOptionsSection = document.getElementById('mediaOptionsSection');
    const videoGrid = document.getElementById('videoGrid');
    const audioGrid = document.getElementById('audioGrid');
    const fetchBtn = document.getElementById('fetchBtn');

    if (!cleanUrl || !isValidYouTubeUrl(cleanUrl)) {
        alert(t.errorLink);
        return;
    }

    if (fetchBtn) fetchBtn.disabled = true;
    if (resultBox) resultBox.style.display = 'block';
    if (statusMsg) {
        statusMsg.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right: 8px;"></i> ${t.processing}`;
    }

    if (previewCard) previewCard.style.display = 'none';
    if (mediaOptionsSection) mediaOptionsSection.style.display = 'none';
    if (videoGrid) videoGrid.innerHTML = '';
    if (audioGrid) audioGrid.innerHTML = '';

    try {
        const geoParam = encodeURIComponent(currentRegionCode || 'PH');
        const backendUrl = `${BACKEND_BASE_URL}/download?url=${encodeURIComponent(cleanUrl)}&cgeo=${geoParam}`;
        let response;

        try {
            response = await fetchWithTimeout(backendUrl, {}, 30000);
        } catch (firstErr) {
            if (statusMsg) {
                statusMsg.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right: 8px;"></i> Waking up server, please wait...`;
            }
            response = await fetchWithTimeout(backendUrl, {}, 35000);
        }

        const data = await response.json();

        if (response.ok && data.status === 'success') {
            const hasVideo = Array.isArray(data.videoFormats) && data.videoFormats.length > 0;
            const hasAudio = Array.isArray(data.audioFormats) && data.audioFormats.length > 0;

            if (!hasVideo && !hasAudio) {
                alert(t.errorProcess);
                if (resultBox) resultBox.style.display = 'none';
                return;
            }

            globalData = data;
            activeMediaTitle = data.title || 'Lim3rd_Media';
            if (statusMsg) statusMsg.innerText = '';
            if (document.getElementById('titleText')) document.getElementById('titleText').innerText = data.title;
            if (document.getElementById('authorText')) document.getElementById('authorText').innerText = data.author;

            const thumbImg = document.getElementById('thumbImg');
            if (thumbImg) {
                if (data.thumbnail) {
                    thumbImg.src = data.thumbnail;
                    thumbImg.style.display = 'block';
                } else {
                    thumbImg.style.display = 'none';
                }
            }

            if (previewCard) previewCard.style.display = 'flex';
            if (mediaOptionsSection) mediaOptionsSection.style.display = 'block';

            const modeButtons = document.querySelectorAll('.mode-switch .mode-btn');
            const videoTabBtn = modeButtons[0] || null;
            const audioTabBtn = modeButtons[1] || null;

            if (videoTabBtn) {
                videoTabBtn.disabled = false;
                videoTabBtn.style.display = 'flex';
            }
            if (audioTabBtn) {
                audioTabBtn.disabled = false;
                audioTabBtn.style.display = 'flex';
            }

            if (hasVideo) {
                switchTab('video');
            } else if (hasAudio) {
                switchTab('audio');
            }
        } else {
            alert(t.errorProcess);
            if (resultBox) resultBox.style.display = 'none';
        }
    } catch (err) {
        alert(t.errorConn);
        if (resultBox) resultBox.style.display = 'none';
    } finally {
        if (fetchBtn) fetchBtn.disabled = false;
    }
}

const downloadNowBtnEl = document.getElementById('downloadNowBtn');
if (downloadNowBtnEl) {
    downloadNowBtnEl.onclick = async (e) => {
        e.preventDefault();
        if (!activeDownloadUrl) return;

        const downloadBtn = downloadNowBtnEl;
        const originalText = downloadBtn.innerHTML;
        downloadBtn.disabled = true;
        downloadBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Preparing...`;

        const cleanBaseTitle = (activeMediaTitle || 'Lim3rd_Media')
            .replace(/\s*-\s*Lim3rd$/i, '')
            .trim();
        const finalTitleWithBrand = `${cleanBaseTitle} - Lim3rd`;
        const filename = `${finalTitleWithBrand}.${activeDownloadExt}`;

        const proxiedUrl = `${BACKEND_BASE_URL}/proxy-download?url=${encodeURIComponent(activeDownloadUrl)}&title=${encodeURIComponent(finalTitleWithBrand)}&ext=${encodeURIComponent(activeDownloadExt)}`;

        try {
            const res = await fetch(proxiedUrl);
            if (!res.ok) {
                alert(LIM3RD_SERVER_BUSY_MSG);
                return;
            }

            const blob = await res.blob();
            if (!blob || blob.size < 1024) {
                alert(LIM3RD_SERVER_BUSY_MSG);
                return;
            }

            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.setAttribute('download', filename);
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
        } catch (err) {
            alert(LIM3RD_SERVER_BUSY_MSG);
        } finally {
            downloadBtn.disabled = false;
            downloadBtn.innerHTML = originalText;
        }
    };
}
