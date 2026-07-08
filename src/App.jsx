// ============================================================================
// OTONOM — v4.14 (v4.13 düzeltmesi: Gemini Live API TTS, @google/generative-ai paketi ile WebSocket tabanlı ses)
// Gemini AI Studio Canvas Uyumlu Versiyon
// ============================================================================
// Akış: S1 → M1 analiz → 2 AI görsel → S2 → M2 analiz → 2 AI görsel → ...
// Sabit görsel sadece 1. sahneye atanır, medyayı anlatan 2 görsel AI üretir
// Çoklu blokta süre sınırı yok — doğal okuma hızında bitir
// Seslendirme daima %80, arka plan müzik daima %30

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Download, RotateCcw, UploadCloud, Music, Trash2, Volume2, Clock, Loader2, Copy, AlertCircle, Activity, Server, Database, ShieldCheck, ImagePlus, Smartphone, Clapperboard, Type, Palette, Globe, MessageSquare, Monitor, Filter, Wand2, CloudRain, ChevronDown, Film, FileText, Layers, RefreshCw, Share2, Check, Link2, Newspaper, Scissors, ExternalLink, Eye } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, onSnapshot, collection, deleteDoc } from 'firebase/firestore';


// ============================================================================
// Sabitler (Constants)
// ============================================================================
const SAMPLE_RATE = 24000;
const WAV_HEADER_SIZE = 44;
const BGM_VOLUME = 0.3;
const VOICEOVER_VOLUME = 0.8;
const VIDEO_FPS = 30;
const AUDIO_BITRATE = 192000;
const VIDEO_BITRATE = 2000000;
const MIN_TTS_BYTES = 100;

// ============================================================================
// Gemini API — Tek model, tüm AI işlemleri için
// ============================================================================
const MIMO_BASE_URL = 'https://token-plan-sgp.xiaomimimo.com/v1';
const MIMO_API_KEY = 'tp-sb7y6c2s0bnowrp8y9imv5mfim3scjb8xrane8wt4hfrei6y'; // GÜVENLİK: Üretimde .env dosyasına taşıyın

function getMimoKey() {
    const envKey = typeof import.meta !== 'undefined' ? import.meta.env.VITE_MIMO_API_KEY : '';
    return envKey || localStorage.getItem('ns_mimo_api_key') || MIMO_API_KEY;
}

function getMimoUrl() {
    const envUrl = typeof import.meta !== 'undefined' ? import.meta.env.VITE_MIMO_BASE_URL : '';
    return envUrl || localStorage.getItem('ns_mimo_base_url') || MIMO_BASE_URL;
}

async function mimoOcr(imageB64, prompt, mimeType = 'image/jpeg', options = {}) {
    const { model = 'mimo-v2.5', maxTokens = 2048, temperature = 0.0 } = options;
    const b64 = imageB64.includes(',') ? imageB64.split(',')[1] : imageB64;
    const imgUrl = await compressImageB64(b64, mimeType, 1024, 0.8); // maxDim=1024, quality=0.8
    const r = await fetch(`${getMimoUrl()}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getMimoKey()}` },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: 'Görseldeki yazıyı oku. Sadece metni yaz, yorum ekleme.' },
                { role: 'user', content: [{ type: 'image_url', image_url: { url: imgUrl } }, { type: 'text', text: prompt }] }
            ],
            max_tokens: maxTokens,
            temperature
        })
    });
    if (!r.ok) throw new Error(`Mimo OCR hatası: ${r.status}`);
    const data = await r.json();
    let rawContent = data.choices?.[0]?.message?.content;
    let text = typeof rawContent === 'object' && rawContent !== null ? JSON.stringify(rawContent) : (rawContent || '');
    return text.trim();
}

async function mimoText(prompt, options = {}) {
    const { model = 'mimo-v2.5-pro', maxTokens = 4096, temperature = 0.0, responseFormat } = options;
    const payload = {
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature
    };
    if (responseFormat) payload.response_format = { type: 'json_object' };
    const r = await fetch(`${getMimoUrl()}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getMimoKey()}` },
        body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error(`Mimo text hatası: ${r.status}`);
    const data = await r.json();
    let rawContent = data.choices?.[0]?.message?.content;
    let text = typeof rawContent === 'object' && rawContent !== null ? JSON.stringify(rawContent) : (rawContent || '');
    return text.trim();
}

function compressImageB64(b64, mime, maxDim = 1024, quality = 0.8) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            let w = img.width, h = img.height;
            if (w <= maxDim && h <= maxDim) { resolve(`data:${mime};base64,${b64}`); return; }
            if (w > h) { if (w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; } }
            else { if (h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; } }
            const c = document.createElement('canvas'); c.width = w; c.height = h;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            resolve(c.toDataURL(mime === 'image/png' ? 'image/jpeg' : mime, quality));
        };
        img.onerror = () => resolve(`data:${mime};base64,${b64}`);
        img.src = `data:${mime};base64,${b64}`;
    });
}

async function callMimo(systemPrompt, userContent, options = {}) {
    const { temperature = 0.7, maxTokens = 8192, responseFormat, source = 'unknown', systemInstruction } = options;

    const messages = [];
    const sysText = systemInstruction?.parts?.[0]?.text || systemPrompt;
    if (sysText) messages.push({ role: 'system', content: sysText });

    const openaiContent = [];
    if (typeof userContent === 'string') {
        openaiContent.push({ type: 'text', text: userContent });
    } else if (Array.isArray(userContent)) {
        for (const p of userContent) {
            if (p.text) {
                openaiContent.push({ type: 'text', text: p.text });
            } else if (p.inlineData) {
                const mime = p.inlineData.mimeType || 'image/png';
                let b64 = p.inlineData.data.includes(',') ? p.inlineData.data.split(',')[1] : p.inlineData.data;
                const imgUrl = await compressImageB64(b64, mime, 1024, 0.8);
                openaiContent.push({ type: 'image_url', image_url: { url: imgUrl } });
            }
        }
    }
    const userMsg = openaiContent.length === 1 && openaiContent[0].type === 'text' ? openaiContent[0].text : openaiContent;
    messages.push({ role: 'user', content: userMsg });

    // Try pro first for less restrictive filtering, fall back to standard
    // If messages contain images and they might be rejected, prepare text-only fallback
    const hasImages = messages.some(m => typeof m.content !== 'string' && Array.isArray(m.content) && m.content.some(c => c.type === 'image_url'));
    const textOnlyMessages = hasImages ? messages.map(m => {
        if (typeof m.content === 'string') return m;
        const textParts = (Array.isArray(m.content) ? m.content : []).filter(c => c.type === 'text');
        return { ...m, content: textParts.map(c => c.text).join('\n') || 'Bu görseli analiz et.' };
    }) : null;

    const model = 'mimo-v2.5-pro';
    let lastError = null;

    const attempts = [
        { model: 'mimo-v2.5', messages },  // v2.5-pro doesn't support images, use v2.5 for image inputs
    ];
    if (textOnlyMessages) {
        attempts.push({ model: 'mimo-v2.5-pro', messages: textOnlyMessages });
        attempts.push({ model: 'mimo-v2.5', messages: textOnlyMessages });
    }

    let lastNonJsonText = null;

    for (const attempt of attempts) {
        const payload = {
            model: attempt.model,
            messages: attempt.messages,
            max_tokens: maxTokens,
            temperature,
        };
        if (responseFormat) payload.response_format = { type: 'json_object' };

        try {
            addSystemLog(`[${source}] Mimo ${attempt.model} ile analiz ediliyor...`, 'info');
            const r = await fetch(`${getMimoUrl()}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getMimoKey()}` },
                body: JSON.stringify(payload)
            });
            if (!r.ok) {
                const errText = await r.text().catch(() => '');
                throw new Error(`Mimo API hatası: ${r.status} ${errText.substring(0, 200)}`);
            }
            const data = await r.json();
            let rawContent = data.choices?.[0]?.message?.content;
            // Mimo bazen parsed JSON nesnesi döndürüyor (string değil)
            let text = typeof rawContent === 'object' && rawContent !== null ? JSON.stringify(rawContent) : rawContent;
            if (!text) throw new Error('Mimo boş yanıt döndürdü');
            // Check for safety rejection
            if (text.toLowerCase().includes('high risk') || text.toLowerCase().includes('rejected') || text.toLowerCase().includes('against policy')) {
                console.log('[MIMO REJECTED]', text.substring(0, 200));
                lastError = new Error('Mimo güvenlik filtresi');
                continue;
            }
            // If JSON expected but response is plain text, save for retry
            if (responseFormat && hasImages) {
                try {
                    JSON.parse(text);
                    console.log('[MIMO RAW]', text.substring(0, 500));
                } catch (_) {
                    console.log('[MIMO NON-JSON]', text.substring(0, 500));
                    lastNonJsonText = typeof text === 'string' ? text : JSON.stringify(text);
                    addSystemLog(`[${source}] Mimo düz metin döndürdü, JSON isteniyor...`, 'warn');
                    continue;
                }
            } else {
                try { const preview = JSON.parse(text); console.log('[MIMO RAW]', JSON.stringify(preview).substring(0, 500)); } catch(_) { console.log('[MIMO RAW TEXT]', text.substring(0, 500)); }
            }
            addSystemLog(`[${source}] Mimo başarılı.`, 'success');
            return {
                candidates: [{
                    content: { parts: [{ text }] },
                    finishReason: 'STOP'
                }]
            };
        } catch (e) {
            lastError = e;
            addSystemLog(`[${source}] Mimo ${attempt.model} hatası: ${e.message}`, 'warn');
        }
    }

    // Eğer Mimo düz metin döndürdüyse (JSON değil), bu metni kullanarak text-only Mimo ile JSON üret
    if (lastNonJsonText && responseFormat) {
        addSystemLog(`[${source}] Mimo düz metni JSON'a çevirmek için tekrar deneniyor...`, 'info');
        for (const retryModel of ['mimo-v2.5-pro', 'mimo-v2.5']) {
            try {
                const retryMessages = [];
                if (sysText) retryMessages.push({ role: 'system', content: sysText });
                    const nonJsonStr = typeof lastNonJsonText === 'string' ? lastNonJsonText : JSON.stringify(lastNonJsonText);
                    retryMessages.push({ role: 'user', content: `Görsel şöyle tarif edildi: "${nonJsonStr.substring(0, 1000)}"\n\nBu açıklamaya göre istenen JSON formatında video scripti oluştur.` });
                const r = await fetch(`${getMimoUrl()}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getMimoKey()}` },
                    body: JSON.stringify({ model: retryModel, messages: retryMessages, max_tokens: maxTokens, temperature, response_format: { type: 'json_object' } })
                });
                if (r.ok) {
                    const data2 = await r.json();
                    const rawContent2 = data2.choices?.[0]?.message?.content;
                    const text2 = typeof rawContent2 === 'object' && rawContent2 !== null ? JSON.stringify(rawContent2) : rawContent2;
                    if (text2 && text2.length > 20) {
                        console.log('[MIMO RETRY JSON]', text2.substring(0, 500));
                        addSystemLog(`[${source}] Mimo JSON retry başarılı.`, 'success');
                        return { candidates: [{ content: { parts: [{ text: text2 }] }, finishReason: 'STOP' }] };
                    }
                }
            } catch (e) {
                addSystemLog(`[${source}] Mimo JSON retry ${retryModel} hatası: ${e.message}`, 'warn');
            }
        }
    }

    // Mimo tamamen başarısız olduysa ve görsel varsa, ücretsiz HuggingFace ile dene
    if (hasImages) {
        addSystemLog(`[${source}] Mimo başarısız, HuggingFace görsel analizi deneniyor...`, 'info');
        try {
            // İlk görselin base64'ünü al
            let imgData = null;
            if (Array.isArray(userContent)) {
                for (const p of userContent) {
                    if (p.inlineData) {
                        imgData = p.inlineData;
                        break;
                    }
                }
            }
            if (imgData) {
                const hfCaption = await callHuggingFaceImageCaption(imgData.data, imgData.mimeType || 'image/png');
                if (hfCaption) {
                    const hfCaptionStr = typeof hfCaption === 'string' ? hfCaption : JSON.stringify(hfCaption);
                    addSystemLog(`[${source}] HF açıklama: "${hfCaptionStr.substring(0, 100)}"`, 'success');
                    // HF açıklamasını kullanarak Mimo text-only ile tekrar dene
                    for (const attemptModel of ['mimo-v2.5-pro', 'mimo-v2.5']) {
                        try {
                            const hfMessages = [];
                            if (sysText) hfMessages.push({ role: 'system', content: sysText });
                            const hfUserText = `Görsel şöyle tarif edildi: "${hfCaption}"\n\nBu açıklamaya göre video scripti oluştur.`;
                            hfMessages.push({ role: 'user', content: typeof userContent === 'string' ? `${hfUserText}\n\n${userContent}` : hfUserText });
                            const hfPayload = {
                                model: attemptModel,
                                messages: hfMessages,
                                max_tokens: maxTokens,
                                temperature
                            };
                            if (responseFormat) hfPayload.response_format = { type: 'json_object' };
                            addSystemLog(`[${source}] HF->Mimo ${attemptModel} deneniyor...`, 'info');
                            const r2 = await fetch(`${getMimoUrl()}/chat/completions`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getMimoKey()}` },
                                body: JSON.stringify(hfPayload)
                            });
                            if (r2.ok) {
                                const data2 = await r2.json();
                                const raw2 = data2.choices?.[0]?.message?.content;
                                const text2 = typeof raw2 === 'object' && raw2 !== null ? JSON.stringify(raw2) : raw2;
                                if (text2 && text2.length > 50) {
                                    console.log('[HF MIMO RAW]', text2.substring(0, 500));
                                    addSystemLog(`[${source}] HF->Mimo başarılı.`, 'success');
                                    return {
                                        candidates: [{ content: { parts: [{ text: text2 }] }, finishReason: 'STOP' }]
                                    };
                                }
                            }
                        } catch (e) {
                            addSystemLog(`[${source}] HF->Mimo ${attemptModel} hatası: ${e.message}`, 'warn');
                        }
                    }
                }
            }
        } catch (hfErr) {
            addSystemLog(`[${source}] HuggingFace hatası: ${hfErr.message}`, 'warn');
        }
    }

    addSystemLog(`[${source}] Mimo hatası: ${lastError?.message || 'bilinmeyen hata'}`, 'error');
    return {
        candidates: [{
            content: { parts: [{ text: '{"isContentUnreadable": true, "videoSlides": []}' }] },
            finishReason: 'STOP'
        }]
    };
}

// HuggingFace ücretsiz görsel açıklama API'si
async function callHuggingFaceImageCaption(b64Data, mimeType) {
    const base64 = b64Data.includes(',') ? b64Data.split(',')[1] : b64Data;
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType || 'image/png' });

    const models = [
        'Salesforce/blip-image-captioning-base',
        'Salesforce/blip-image-captioning-large',
        'nlpconnect/vit-gpt2-image-captioning'
    ];

    for (const model of models) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 20000);
            const r = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
                method: 'POST',
                body: blob,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!r.ok) {
                console.log(`[HF] ${model} hata: ${r.status}`);
                continue;
            }
            const result = await r.json();
            const text = result?.[0]?.generated_text || result?.generated_text;
            if (text && text.length > 5) return text;
        } catch (e) {
            console.log(`[HF] ${model} exception: ${e.message}`);
        }
    }
    return null;
}

async function callGemini(systemPrompt, userContent, options = {}) {
    return callMimo(systemPrompt, userContent, options);
}

// callAI alias (geriye uyumluluk)
const callAI = callGemini;

// JSON çıkarma yardımcısı — Gemini yanıtından güvenli JSON çıkarır
function extractJSON(responseText, source = 'unknown') {
    if (!responseText) throw new Error(`${source}: Boş yanıt`);

    // responseText string değilse string'e çevir
    const safeInput = typeof responseText === 'string' ? responseText : JSON.stringify(responseText);

    // Markdown kod bloklarını temizle
    let text = safeInput
        .replace(/```json\s*/gi, '')
        .replace(/```javascript\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim();

    // Doğrudan JSON parse dene (Gemini bazen sadece JSON döndürür)
    try { return JSON.parse(text); } catch (_) {}

    // Tüm { ... } bloklarını bul ve en büyüğünü seç
    const allObjects = [];
    let i = 0;
    while (i < text.length) {
        if (text[i] === '{') {
            let depth = 0;
            let start = i;
            for (let j = i; j < text.length; j++) {
                if (text[j] === '{') depth++;
                else if (text[j] === '}') {
                    depth--;
                    if (depth === 0) {
                        allObjects.push({ start, end: j, text: text.substring(start, j + 1) });
                        i = j + 1;
                        break;
                    }
                }
                if (j === text.length - 1) i = text.length; // kapanış yok
            }
        } else {
            i++;
        }
    }

    if (allObjects.length === 0) throw new Error(`${source}: JSON bulunamadı`);

    // En büyük JSON objesini seç (muhtemelen ana yanıt)
    allObjects.sort((a, b) => b.text.length - a.text.length);

    for (const obj of allObjects) {
        try {
            const parsed = JSON.parse(obj.text);
            // videoSlides veya headlines içeren objeyi tercih et
            if (parsed.videoSlides || parsed.headlines || parsed.isContentUnreadable !== undefined) {
                return parsed;
            }
        } catch (_) {}
    }

    // Hiçbiri çalışmadıysa en büyük objeyi dene
    try { return JSON.parse(allObjects[0].text); } catch (_) {}

    // Son çare: lastIndexOf
    const jsonStart = text.indexOf('{');
    const fallbackEnd = text.lastIndexOf('}');
    if (jsonStart !== -1 && fallbackEnd > jsonStart) {
        try { return JSON.parse(text.substring(jsonStart, fallbackEnd + 1)); } catch (_) {}
    }

    throw new Error(`${source}: JSON parse hatası`);
}

// Kanal logosu — kapanış sahnesinde ortada gösterilir
const CHANNEL_LOGO_URL = "data:image/png;base64,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";

// Google Drive Müzik Kütüphanesi (kaldırıldı)
const GOOGLE_DRIVE_MUSIC = [];



// ============================================================
// MÜZİK PROXY AYARLARI
// Music proxy URL
// Örnek: 'https://xxxx.ngrok-free.dev/music/proxy'
// Sunucu yoksa boş bırakın — CORS proxy denenir
// ============================================================
// Müzik proxy sunucu — otomatik algılama (localhost → ngrok → boş)
const MUSIC_PROXY_BASE = '';
const _detectMusicProxy = async () => {
    // 1. Localhost dene
    try { const r = await fetch('http://localhost:3000/music/list', { signal: AbortSignal.timeout(2000) }); if (r.ok) return 'http://localhost:3000'; } catch(e) {}
    // 2. ngrok dene
    try { const r = await fetch('https://impotence-powdery-replace.ngrok-free.dev/music/list', { headers: { 'ngrok-skip-browser-warning': 'true' }, signal: AbortSignal.timeout(5000) }); if (r.ok) return 'https://impotence-powdery-replace.ngrok-free.dev'; } catch(e) {}
    return '';
};
let _musicProxyUrl = '';
const getMusicProxyUrl = async () => {
    if (_musicProxyUrl) return _musicProxyUrl;
    _musicProxyUrl = await _detectMusicProxy();
    if (_musicProxyUrl) addSystemLog(`Müzik proxy bulundu: ${_musicProxyUrl}`, 'success');
    return _musicProxyUrl;
};



// Sunucu üzerinden müzik indir (CORS yok — sunucu tarafı fetch)
const fetchViaMusicProxy = async (fileId) => {
    const baseUrl = await getMusicProxyUrl();
    if (!baseUrl) throw new Error('Müzik proxy sunucusu bulunamadı');
    const proxyUrl = `${baseUrl}/music/proxy/${fileId}`;
    const r = await fetch(proxyUrl, {
        headers: { 'ngrok-skip-browser-warning': 'true' }
    });
    if (!r.ok) throw new Error(`Proxy hatası: ${r.status}`);
    return r;
};

// Wikimedia Commons'tan gerçek görsel çek (Atatürk vb. — Imagen üretemez)
// Wikimedia CORS header verdiği için proxy'ye gerek yok, doğrudan fetch
const fetchWikimediaImages = async (query, limit = 3) => {
    try {
        const searchUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=filetype:bitmap+${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=${limit}&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=1280&format=json`;
        const r = await fetch(searchUrl);
        if (!r.ok) return [];
        const data = await r.json();
        const images = [];
        const pages = data.query?.pages || {};
        for (const page of Object.values(pages)) {
            const ii = page.imageinfo?.[0];
            if (ii?.mime?.startsWith('image/')) {
                images.push(ii.thumburl || ii.url);
            }
        }
        return images;
    } catch (e) { return []; }
};

// Google Drive HTML sayfasından gerçek download URL'ini çıkar
const extractDriveDownloadUrl = (html) => {
    const actionMatch = html.match(/action="([^"]*drive\.usercontent\.google\.com[^"]*)"/);
    if (actionMatch) return actionMatch[1].replace(/&amp;/g, '&');
    const hrefMatch = html.match(/href="(\/uc\?export=download[^"]*)"/);
    if (hrefMatch) return 'https://drive.google.com' + hrefMatch[1].replace(/&amp;/g, '&');
    return null;
};

// CORS proxy listesi — son çare olarak denenir
const CORS_PROXIES = [
    (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

const fetchWithCorsProxy = async (url) => {
    // 1. Müzik proxy sunucusu varsa önce onu dene (en güvenilir)
    const fileId = new URL(url).searchParams.get('id');
    const proxyUrl = await getMusicProxyUrl();
    if (proxyUrl && fileId) {
        try { return await fetchViaMusicProxy(fileId); } catch(e) {}
    }
    // 2. Doğrudan dene
    try {
        const r = await fetch(url);
        if (r.ok) {
            const ct = r.headers.get('content-type') || '';
            if (!ct.includes('text/html')) return r;
            const html = await r.text();
            const realUrl = extractDriveDownloadUrl(html);
            if (realUrl) { const r2 = await fetch(realUrl); if (r2.ok) return r2; }
        }
    } catch(e) {}
    // 3. Proxy'lerle dene
    for (const proxy of CORS_PROXIES) {
        try {
            const r = await fetch(proxy(url));
            if (r.ok) {
                const ct = r.headers.get('content-type') || '';
                if (!ct.includes('text/html')) return r;
            }
        } catch(e) {}
    }
    throw new Error('Müzik indirilemedi. Sunucu çalıştığından ve Google Drive dosyasının herkese açık olduğundan emin olun.');
};

const getApiKey = () => {
    const envKey = typeof import.meta !== 'undefined' ? import.meta.env.VITE_GEMINI_API_KEY : '';
    return envKey || localStorage.getItem('ns_gemini_api_key') || '';
};

const SafeStorage = {
    memoryStore: {},
    getItem: (key) => { try { return localStorage.getItem(key); } catch (e) { return SafeStorage.memoryStore[key] || null; } },
    setItem: (key, value) => { try { localStorage.setItem(key, value); } catch (e) { SafeStorage.memoryStore[key] = value; } }
};

const _getAudioCtx = () => { if (!window._globalAudioCtx) window._globalAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); return window._globalAudioCtx; };

class EventBus {
    constructor() { this.listeners = {}; }
    on(event, callback) { if (!this.listeners[event]) this.listeners[event] = []; this.listeners[event].push(callback); }
    emit(event, data) { if (this.listeners[event]) this.listeners[event].forEach(cb => cb(data)); }
}
const sysEventBus = new EventBus();

const _logBuffer = [];
const addSystemLog = (text, type = 'info', detail = null, extra = null) => {
    const time = new Date().toLocaleTimeString('tr-TR');
    const entry = { text, type, timestamp: time, detail: detail || undefined, extra: extra || undefined };
    _logBuffer.push(entry);
    sysEventBus.emit('SYS_LOG_ADD', entry);
    const logStr = `[SYS_LOG] [${type.toUpperCase()}] ${text}${detail ? ' | ' + detail : ''}`;
    console.log(logStr);
    if (extra && typeof extra === 'object') console.log('  ├─', (JSON.stringify(extra) || '').substring(0, 200));
    try { fetch('/api/log', { method: 'POST', body: JSON.stringify(entry) }).catch(() => {}); } catch (e) {}
};
const logStep = (step, msg, data = null) => addSystemLog(`[${step}] ${msg}`, 'info', data ? JSON.stringify(data).substring(0, 300) : null);
const logError = (step, msg, err = null) => addSystemLog(`[${step}] ${msg}`, 'error', err?.message || err || null, err ? { stack: err.stack?.substring(0, 200) } : null);
const logWarn = (step, msg, data = null) => addSystemLog(`[${step}] ${msg}`, 'warn', data ? JSON.stringify(data).substring(0, 300) : null);
const logSuccess = (step, msg, data = null) => addSystemLog(`[${step}] ${msg}`, 'success', data ? JSON.stringify(data).substring(0, 300) : null);
window.addSystemLog = addSystemLog;

const exportWorkflowLog = (jobState) => {
    const lines = ['=== AI News Studio Workflow Log ===', `Tarih: ${new Date().toLocaleString('tr-TR')}`, `Versiyon: v1.0`, ''];
    lines.push('--- Sistem Logları ---');
    for (const e of _logBuffer) lines.push(`[${e.timestamp}] [${e.type.toUpperCase()}] ${e.text}`);
    lines.push('');
    lines.push('--- Workflow State ---');
    lines.push(`Job ID: ${jobState?.jobId || 'N/A'}`);
    lines.push(`Status: ${jobState?.status || 'N/A'}`);
    lines.push(`Slides: ${jobState?.script?.videoSlides?.length || 0}`);
    lines.push(`ImageBlocks: ${jobState?.script?.imageBlocks?.length || 0}`);
    lines.push(`Images generated: ${jobState?.assets?.images?.filter(Boolean).length || 0}/${jobState?.assets?.images?.length || 0}`);
    lines.push(`Audio generated: ${jobState?.assets?.audio?.filter(Boolean).length || 0}/${jobState?.assets?.audio?.length || 0}`);
    lines.push(`Config: ${JSON.stringify(jobState?.config || {}, null, 2)}`);
    lines.push('');
    lines.push('--- Slide Details ---');
    for (const [i, s] of (jobState?.script?.videoSlides || []).entries()) {
        lines.push(`S${i + 1}: "${(s.spokenText || '').substring(0, 80)}..." img=${!!jobState?.assets?.images?.[i]} aud=${!!jobState?.assets?.audio?.[i]}`);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `workflow_log_${Date.now()}.txt`;
    a.click();
};
window.exportWorkflowLog = exportWorkflowLog;

const getWPS = (lang) => ({ 'en': 2.5, 'es': 2.6, 'fr': 2.4, 'tr': 2.2, 'ar': 2.2, 'de': 2.0, 'ru': 2.0 }[lang] || 2.2);

const getDurationBounds = (dur) => {
    if (dur === '15') return { min: 15.0, max: 30.0 };
    if (dur === '30') return { min: 30.0, max: 60.0 };
    if (dur === '60') return { min: 60.0, max: 90.0 };
    if (dur === '90') return { min: 90.0, max: 120.0 };
    return { min: 0.0, max: 9999.0 };
};

let app, auth, db, appId;
const initFirebase = () => {
    try {
        const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
        if (Object.keys(firebaseConfig).length > 0) { app = initializeApp(firebaseConfig); auth = getAuth(app); db = getFirestore(app); appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; return true; }
    } catch (e) { console.warn("[INFRA] Firebase başlatılamadı, izole modda çalışılıyor."); }
    return false;
};
const isFirebaseActive = initFirebase();

const attemptSilentReauth = async () => {
    try {
        if (auth) {
            addSystemLog("Yetkilendirme anahtarı yenileniyor (Silent Re-Auth)...", "warn");
            if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) await signInWithCustomToken(auth, __initial_auth_token);
            else await signInAnonymously(auth);
            addSystemLog("Oturum anahtarı arka planda başarıyla tazelendi!", "success");
            return true;
        }
    } catch (e) { addSystemLog("Sessiz re-auth denemesi başarısız oldu: " + e.message, "error"); }
    return false;
};

const NetworkUtils = {
    fetchWithRetry: async (url, options, retries = 5) => {
        const delays = [1000, 2000, 4000, 8000, 16000];
        for (let i = 0; i < retries; i++) {
            try {
                const res = await fetch(url, options);
                if (res.ok) return res;
                if (res.status === 400 || res.status === 403 || res.status === 404) throw new Error(`HTTP_FAIL_${res.status}`);
                if (res.status === 401) {
                    addSystemLog(`Oturum hatası (401) algılandı, sessiz yenileme deneniyor...`, "warn");
                    const success = await attemptSilentReauth();
                    if (success) { addSystemLog(`Sessiz kimlik doğrulama tazelendi, istek yeniden deneniyor.`, "success"); continue; }
                    if (i === retries - 1) { sysEventBus.emit('AUTH_EXPIRED', true); throw new Error("Oturum süresi doldu (401)."); }
                    await new Promise(r => setTimeout(r, delays[i])); continue;
                }
                if (res.status === 429 || res.status >= 500) { addSystemLog(`Yavaşlık (HTTP ${res.status}). Yeniden deneme (${i + 1}/${retries}) - ${delays[i] / 1000}sn...`, "warn"); await new Promise(r => setTimeout(r, delays[i])); continue; }
                throw new Error(`HTTP Error ${res.status}`);
            } catch (err) {
                if (err.message.startsWith('HTTP_FAIL_') || err.message.includes('Oturum süresi doldu')) throw err;
                if (i === retries - 1) throw err;
                addSystemLog(`Bağlantı kesintisi. Yeniden deneniyor (${i + 1}/${retries}) - ${delays[i] / 1000}sn...`, "warn");
                await new Promise(r => setTimeout(r, delays[i]));
            }
        }
        throw new Error('fetchWithRetry: tüm denemeler başarısız');
    },
    loadImage: (src) => new Promise((resolve) => { if (!src) return resolve(null); const img = new Image(); if (src.startsWith('http')) img.crossOrigin = "Anonymous"; img.onload = () => resolve(img); img.onerror = () => resolve(null); img.src = src; }),
    fileToBase64: (file) => new Promise((resolve) => { const reader = new FileReader(); reader.onload = (e) => resolve(e.target.result); reader.readAsDataURL(file); }),
    compressImage: (file) => new Promise((resolve) => {
        if (!file.type.startsWith('image/')) { const reader = new FileReader(); reader.onload = (e) => resolve(e.target.result); reader.readAsDataURL(file); return; }
        const reader = new FileReader();
        reader.onload = (e) => { const img = new Image(); img.onload = () => { const canvas = document.createElement('canvas'); let w = img.width; let h = img.height; const maxW = 1080; if (w > maxW || h > maxW) { if (w > h) { h = Math.round((h / w) * maxW); w = maxW; } else { w = Math.round((w / h) * maxW); h = maxW; } } canvas.width = w; canvas.height = h; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, w, h); resolve(canvas.toDataURL('image/jpeg', 0.7)); }; img.src = e.target.result; };
        reader.readAsDataURL(file);
    })
};

const ASSET_DB = 'AINewsSaaS_Assets_v5';
const STORE_MEDIA = 'media_cache';
const STORE_JOBS = 'temporal_jobs';
const LIB_STORE = 'musicLib';
const DIR_STORE = 'dirHandles';

class AssetManagerService {
    static async getDB() { return new Promise((resolve, reject) => { const req = indexedDB.open(ASSET_DB, 2); req.onupgradeneeded = (e) => { const db = e.target.result; if (!db.objectStoreNames.contains(STORE_MEDIA)) db.createObjectStore(STORE_MEDIA, { keyPath: 'id' }); if (!db.objectStoreNames.contains(STORE_JOBS)) db.createObjectStore(STORE_JOBS, { keyPath: 'jobId' }); if (!db.objectStoreNames.contains(LIB_STORE)) db.createObjectStore(LIB_STORE, { keyPath: 'id' }); if (!db.objectStoreNames.contains(DIR_STORE)) db.createObjectStore(DIR_STORE, { keyPath: 'id' }); }; req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
    static async saveMedia(id, data) { try { const db = await this.getDB(); const tx = db.transaction(STORE_MEDIA, 'readwrite'); tx.objectStore(STORE_MEDIA).put({ id, data, timestamp: Date.now() }); return new Promise(r => tx.oncomplete = () => r(true)); } catch (e) { return false; } }
    static async loadMedia(id) { try { const db = await this.getDB(); const tx = db.transaction(STORE_MEDIA, 'readonly'); const req = tx.objectStore(STORE_MEDIA).get(id); return new Promise(r => req.onsuccess = () => r(req.result?.data || null)); } catch (e) { return null; } }
    static async deleteMedia(id) { try { const db = await this.getDB(); const tx = db.transaction(STORE_MEDIA, 'readwrite'); tx.objectStore(STORE_MEDIA).delete(id); return new Promise(r => tx.oncomplete = () => r(true)); } catch (e) { return false; } }
    static async saveJobState(jobData) { try { const db = await this.getDB(); const tx = db.transaction(STORE_JOBS, 'readwrite'); tx.objectStore(STORE_JOBS).put(jobData); return new Promise(r => tx.oncomplete = () => r(true)); } catch (e) { return false; } }
    static async getPendingJob() { try { const db = await this.getDB(); const tx = db.transaction(STORE_JOBS, 'readonly'); const req = tx.objectStore(STORE_JOBS).getAll(); return new Promise(r => req.onsuccess = () => { const jobs = req.result || []; const pending = jobs.find(j => j.status !== 'COMPLETED' && j.status !== 'FAILED'); r(pending || null); }); } catch (e) { return null; } }
    static async clearJob(jobId) { try { const db = await this.getDB(); const tx = db.transaction(STORE_JOBS, 'readwrite'); tx.objectStore(STORE_JOBS).delete(jobId); } catch (e) { } }
    static async saveMusicToLib(musicObj) { try { const db = await this.getDB(); const tx = db.transaction(LIB_STORE, 'readwrite'); tx.objectStore(LIB_STORE).put(musicObj); return new Promise(r => tx.oncomplete = () => r(true)); } catch (e) { return false; } }
    static async getAllMusicFromLib() { try { const db = await this.getDB(); const tx = db.transaction(LIB_STORE, 'readonly'); const req = tx.objectStore(LIB_STORE).getAll(); return new Promise(r => req.onsuccess = () => r(req.result || [])); } catch (e) { return []; } }
    static async getMusicFromLib(id) { try { const db = await this.getDB(); const tx = db.transaction(LIB_STORE, 'readonly'); const req = tx.objectStore(LIB_STORE).get(id); return new Promise(r => req.onsuccess = () => r(req.result || null)); } catch (e) { return null; } }
    static async getMusicByName(name) { try { const allMusic = await this.getAllMusicFromLib(); const found = allMusic.find(m => m.name && m.name.toLowerCase().includes(name.toLowerCase())); return found || null; } catch (e) { return null; } }
    static async removeMusicFromLib(id) { try { const db = await this.getDB(); const tx = db.transaction(LIB_STORE, 'readwrite'); tx.objectStore(LIB_STORE).delete(id); return new Promise(r => tx.oncomplete = () => r(true)); } catch (e) { return false; } }
    static async saveDirHandle(handle) { try { const db = await this.getDB(); const tx = db.transaction(DIR_STORE, 'readwrite'); tx.objectStore(DIR_STORE).put({ id: 'musicDir', handle, name: handle.name, lastSync: Date.now() }); return new Promise(r => tx.oncomplete = () => r(true)); } catch (e) { return false; } }
    static async getDirHandle() { try { const db = await this.getDB(); const tx = db.transaction(DIR_STORE, 'readonly'); const req = tx.objectStore(DIR_STORE).get('musicDir'); return new Promise(r => req.onsuccess = () => r(req.result || null)); } catch (e) { return null; } }
    static async removeDirHandle() { try { const db = await this.getDB(); const tx = db.transaction(DIR_STORE, 'readwrite'); tx.objectStore(DIR_STORE).delete('musicDir'); return new Promise(r => tx.oncomplete = () => r(true)); } catch (e) { return false; } }
    // İndirilenler klasörü için directory handle
    static async saveDownloadsDirHandle(handle) { try { const db = await this.getDB(); const tx = db.transaction(DIR_STORE, 'readwrite'); tx.objectStore(DIR_STORE).put({ id: 'downloadsDir', handle, name: handle.name, timestamp: Date.now() }); return new Promise(r => tx.oncomplete = () => r(true)); } catch (e) { return false; } }
    static async getDownloadsDirHandle() { try { const db = await this.getDB(); const tx = db.transaction(DIR_STORE, 'readonly'); const req = tx.objectStore(DIR_STORE).get('downloadsDir'); return new Promise(r => req.onsuccess = () => r(req.result || null)); } catch (e) { return null; } }
}

const syncMusicFromDir = async (dirHandle, existingMusic) => {
    const audioExts = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma'];
    const existingIds = new Set(existingMusic.map(m => m.id));
    let newCount = 0;
    try {
        for await (const entry of dirHandle.values()) {
            if (entry.kind === 'file' && audioExts.some(ext => entry.name.toLowerCase().endsWith(ext))) {
                const file = await entry.getFile();
                const id = "fm_" + file.name.replace(/[^a-zA-Z0-9]/g, '_') + "_" + file.size;
                if (existingIds.has(id)) continue;
                const b64 = await NetworkUtils.fileToBase64(file);
                await AssetManagerService.saveMusicToLib({ id, name: file.name, data: b64 });
                newCount++;
            }
        }
        if (dirHandle.name) {
            const db = await AssetManagerService.getDB();
            const tx = db.transaction(DIR_STORE, 'readwrite');
            tx.objectStore(DIR_STORE).put({ id: 'musicDir', handle: dirHandle, name: dirHandle.name, lastSync: Date.now() });
        }
    } catch (e) {
        console.warn("Otomatik senkronizasyon hatası:", e);
    }
    return newCount;
};

const analyzeQuoteEmotion = (text) => {
    const lower = text.toLowerCase();
    const mutluKelimeler = ['mutlu', 'sevinç', 'neşe', 'güle', 'eğlen', 'coşku', 'başarı', 'zafer', 'kazan', 'umut', 'güneş', 'aydınlık', 'güzel', 'sevgi', 'aşk', 'sev', 'tatlı', 'tat', 'bal', 'çiçek', 'bahar', 'yaz', 'dünya', 'yaşam', 'hayat'];
    const hüzünlüKelimeler = ['hüzün', 'üzgün', 'ağla', 'göz yaş', 'keder', 'acı', 'kayıp', 'ölüm', 'ayrılık', 'yalnız', 'yalnızlık', 'karanlık', 'gece', 'son', 'bitiş', 'veda', 'göç', 'hıçkırık', 'fırtına', 'yağmur', 'kış', 'soğuk', 'don', 'göz yaş'];
    const romantikKelimeler = ['aşk', 'sevda', 'sevgili', 'kalp', 'gönül', 'dudak', 'öp', 'sarı', 'kokla', 'tatlı', 'bal', 'gül', 'ay', 'yıldız', 'gece', 'rk', 'düş', 'rüya', 'özlem', 'bekle', 'hasret', 'vuslat', 'buluş'];
    let mutluSkor = 0, hüzünlüSkor = 0, romantikSkor = 0;
    mutluKelimeler.forEach(k => { if (lower.includes(k)) mutluSkor++; });
    hüzünlüKelimeler.forEach(k => { if (lower.includes(k)) hüzünlüSkor++; });
    romantikKelimeler.forEach(k => { if (lower.includes(k)) romantikSkor++; });
    const maxSkor = Math.max(mutluSkor, hüzünlüSkor, romantikSkor);
    if (maxSkor === 0) return 'notr';
    if (mutluSkor === maxSkor) return 'mutlu';
    if (hüzünlüSkor === maxSkor) return 'hüzünlü';
    return 'romantik';
};

const matchMusicToEmotion = (emotion, musicList) => {
    if (!musicList || musicList.length === 0) return null;
    const emotionKeywords = {
        'mutlu': ['happy', 'upbeat', 'energetic', 'pop', 'joy', 'dance', 'fun', 'bright', 'major', 'optimistic', 'mutlu', 'neşeli', 'coşkulu', 'eğlence'],
        'hüzünlü': ['sad', 'melancholy', 'emotional', 'piano', 'strings', 'slow', 'deep', 'minor', 'cry', 'sorrow', 'hüzün', 'üzüntü', 'agir', 'yavas', 'duygusal'],
        'romantik': ['romantic', 'love', 'soft', 'gentle', 'dream', 'ambient', 'chill', 'relax', 'calm', 'aşk', 'sevgi', 'roma', 'duygusal', 'yavas'],
        'notr': ['background', 'ambient', 'chill', 'lofi', 'calm', 'soft', 'neutral', 'minimal']
    };
    const keywords = emotionKeywords[emotion] || emotionKeywords['notr'];
    let bestMatch = null;
    let bestScore = -1;
    for (const track of musicList) {
        const name = (track.name || '').toLowerCase();
        let score = 0;
        for (const kw of keywords) {
            if (name.includes(kw)) score += 2;
        }
        const ext = name.split('.').pop();
        if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) score += 0.5;
        if (score > bestScore) { bestScore = score; bestMatch = track; }
    }
    if (bestScore <= 0) {
        const idx = Math.floor(Math.random() * musicList.length);
        return musicList[idx];
    }
    return bestMatch;
};

class LogicEngineService {
    static async analyzeContent(inputData, inputType, config) {
        addSystemLog('İçerik analiz ediliyor...', 'info');

        if (config.tip === 'guzel_soz') {
            return LogicEngineService._buildGuzelSozScript(inputData, inputType, config);
        }
        if (config.tip === 'spotify') {
            return LogicEngineService._buildSpotifyScript(inputData, inputType, config);
        }
        if (config.tip === 'nostalji') {
            return LogicEngineService._buildNostaljiScript(inputData, inputType, config);
        }
        if (config.tip === 'kelimesi') {
            return LogicEngineService._buildKelimesiKelimesineScript(inputData, inputType, config);
        }
        let isUnlimited = config.duration === 'unlimited';
        let targetSec = isUnlimited ? 0 : (config.duration === '15' ? 30 : config.duration === '30' ? 60 : config.duration === '60' ? 90 : config.duration === '90' ? 120 : 60);
        let sceneCount = 4; let words = "80-95";
        const useForceExact = !isUnlimited;
        if (useForceExact) {
            const wps = getWPS(config.language);
            if (config.duration === '15') { sceneCount = 4; words = `${Math.floor(15 * wps)}-${Math.floor(25 * wps)}`; }
            else if (config.duration === '30') { sceneCount = 6; words = `${Math.floor(30 * wps)}-${Math.floor(52 * wps)}`; }
            else if (config.duration === '60') { sceneCount = 9; words = `${Math.floor(60 * wps)}-${Math.floor(82 * wps)}`; }
            else if (config.duration === '90') { sceneCount = 13; words = `${Math.floor(90 * wps)}-${Math.floor(112 * wps)}`; }
        } else { sceneCount = "İçeriğe göre en az 10, ortalama 18-25 sahne"; words = "İçeriği eksiksiz anlatacak kadar esnek"; }

        let styleInstruction = "Video stili: Tarafsız, analitik, ciddi ve keskin bir haber editörü.";
        if (config.videoStyle === 'prompt_output') styleInstruction = "Video stili: Özel Prompt Çıktısı. Kullanıcının girdiği metni doğrudan uygula.";

        let langInstruction = "BÜTÜN SENARYOYU TÜRKÇE YAZACAKSIN.";
        if (config.language === 'en') langInstruction = "BÜTÜN SENARYOYU İNGİLİZCE YAZACAKSIN.";
        if (config.language === 'fr') langInstruction = "BÜTÜN SENARYOYU FRANSIZCA YAZACAKSIN.";
        if (config.language === 'de') langInstruction = "BÜTÜN SENARYOYU ALMANCA YAZACAKSIN.";
        if (config.language === 'es') langInstruction = "BÜTÜN SENARYOYU İSPANYOLCA YAZACAKSIN.";
        if (config.language === 'ar') langInstruction = "BÜTÜN SENARYOYU ARAPÇA YAZACAKSIN.";
        if (config.language === 'ru') langInstruction = "BÜTÜN SENARYOYU RUSÇA YAZACAKSIN.";

        const isImageOutput = config.outputType === 'image';
        let timeConstraint = isUnlimited ? `SÜRE SINIRI YOKTUR. Olayı detaylıca anlat.` : `DİNAMİK KISITLAYICI: Videonun hedef süresi ${config.duration === '15' ? '15-30' : config.duration === '30' ? '30-60' : config.duration === '60' ? '60-90' : '90-120'} saniyedir. Maksimum ${words.split('-')[1]} KELİME.`;

        let dynamicRules = "";
        if (config.analysisMode === 'yorumsuz') {
            dynamicRules = `BİRİNCİ KURAL (SADECE HABER - YORUMSUZ): Girdiyi dikkatlice incele. SADECE haberi tarafsızca anlat. 5N1K kurallarını uygula. Kendi yorumunu katma.\nİKİNCİ KURAL: 'mediaBlackout.show' değerini false yap.\nÜÇÜNCÜ KURAL: 'sonSoz' alanını tekrarlama.\nDÖRDÜNCÜ KURAL: Her sahnenin 'spokenText' metni NOKTA İLE BİTEN BİR CÜMLE OLMALIDIR.\n${timeConstraint}`;
        } else if (config.analysisMode === 'deep_analysis') {
            dynamicRules = `BİRİNCİ KURAL (DERİN ANALİZ): 5N1K dengesini sorgula ve sosyolojik/ekonomik etkileri analiz et.\nİKİNCİ KURAL: Skandalsa 'mediaBlackout.show' true yap.\nÜÇÜNCÜ KURAL: 'sonSoz' alanını tekrarlama.\nDÖRDÜNCÜ KURAL: Her sahnenin 'spokenText' metni NOKTA İLE BİTEN BİR CÜMLE OLMALIDIR.\n${timeConstraint}`;
        } else {
            dynamicRules = `BİRİNCİ KURAL (HABER 5N1K): Girdiyi incele, 5N1K kuralına sadık kalarak özetle.\nİKİNCİ KURAL: Skandal değilse 'mediaBlackout.show' false yap.\nÜÇÜNCÜ KURAL: 'sonSoz' alanını tekrarlama.\nDÖRDÜNCÜ KURAL: Her sahnenin 'spokenText' metni NOKTA İLE BİTEN BİR CÜMLE OLMALIDIR.\n${timeConstraint}`;
        }

        let sonSozInstruction = "";
        if (!isImageOutput) sonSozInstruction = `\n\nYEDİNCİ KURAL (SON SÖZ): Konuya cuk diye oturan çok vurucu bir ATASÖZÜ veya ÖZLÜ SÖZ belirle. Bunu 'sonSoz' alanına kaydet.`;

        const sysPrompt = `Sen TikTok ve Instagram Reels için viral içerikler üreten profesyonel bir içerik üreticisisin. Karakterin: Zeki, gerçekleri söyleyen, 20 yaşında dertli bir genç.\n\nSENARYOYU ${isImageOutput ? 1 : sceneCount} SAHNE olacak şekilde böl!\nToplam konuşma metni ${words} kelime aralığında olmalıdır.\n\nDİL KURALI: ${langInstruction}\n${styleInstruction}\n${dynamicRules}\n\nKAPAK DİLİ: 'thumbnailText' ${config.language} dilinde olmalıdır. Clickbait başlık olmalıdır.\nYOUTUBE: 'youtubeTitle' ve 'youtubeDescription' alanlarını ${config.language} dilinde oluştur. YouTube SEO kurallarına uygun, dikkat çekici başlık ve açıklayıcı açıklama yaz. 'youtubeHashtags' dizisine 5-8 adet ilgili hashtag ekle.\nGRAFİKLER: İstatistik yoksa 'chartData.show' false yap.\nGÖRSEL UYUMU: 'imagePrompts' alanına yazacağın İngilizce komutlar, spokenText'teki ana görsel unsurları birebir tanımlamalıdır. Kişi varsa yüz tanımlı, mekan varsa detaylı, nesne varsa belirgin olmalıdır. Her sahne için tek bir güçlü prompt yaz.\nSIFIR HALÜSİNASYON: Okuyamadıysan 'isContentUnreadable' true yap.\nATATÜRK HASSASİYETİ: 'Atatürk' geçerse 'imagePrompts' kısmına "Mustafa Kemal Atatürk, highly detailed, respectful portrait" ekle!${sonSozInstruction}\n\nDönüş ZORUNLU olarak JSON formatında olmalı.`;

        let parts = [];
        let extractStatsHint = "Olayı tam anla ve KISA BİR ÖZET ver.";
        if (config.analysisMode === 'yorumsuz') extractStatsHint = "SADECE haberi tarafsızca oku.";

        if (inputType === 'media' && Array.isArray(inputData)) {
            parts = inputData.map(file => { const b64 = file.data.split(',')[1]; return { inlineData: { mimeType: file.type || "application/octet-stream", data: b64 } }; });
            const isVideo = inputData.some(f => f.type?.startsWith('video'));
            const hasDoc = inputData.some(f => f.type && !f.type.startsWith('video') && !f.type.startsWith('image'));
            let introText = `Görselleri detaylıca incele.`;
            if (isVideo) introText = `Gönderilen medyaları izle.`;
            if (hasDoc) introText = `Gönderilen belgeleri oku, verileri analiz et.`;
            parts.unshift({ text: `${introText} ${extractStatsHint}` });
        } else if (inputType === 'prompt') { parts = [{ text: `AŞAĞIDAKİ TALİMATI UYGULA:\n\n${inputData}\n\n${extractStatsHint}` }]; }
        else if (inputType === 'url') { parts = [{ text: `[KRİTİK GÖREV]: URL'yi oku. \nURL: ${inputData}\n\nİçeriğe ulaştıysan haberi özetle. ${extractStatsHint}` }]; }
        else { parts = [{ text: `Aşağıdaki konuyu internette araştır. Haberi özetle. \n\n${inputData}\n\n${extractStatsHint}` }]; }

        // JSON schema tanımı
        const jsonSchemaDef = `{
            "isContentUnreadable": boolean,
            "videoSlides": [{"topText": string, "spokenText": string, "imagePrompts": [string]}],
            "thumbnailText": string,
            "sonSoz": string,
            "lastQuote": string,
            "thumbnailImagePrompt": string,
            "tiktokTitle": string,
            "tiktokDescription": string,
            "tiktokHashtags": [string],
            "youtubeTitle": string,
            "youtubeDescription": string,
            "youtubeHashtags": [string],
            "mediaBlackout": {"show": boolean, "percentageCovered": number, "percentageIgnored": number, "mediaNames": [string], "explanation": string},
            "chartData": {"show": boolean, "type": string, "title": string, "note": string, "items": [{"label": string, "value": number}]}
        }`;

        // Gemini ile analiz — medya varsa parts dizisini doğrudan geçir
        addSystemLog('AI ile analiz ediliyor...', 'info');
        const hasMediaParts = parts.some(p => p.inlineData);
        const contentSchema = {
            type: "OBJECT",
            properties: {
                isContentUnreadable: { type: "BOOLEAN" },
                videoSlides: { type: "ARRAY", items: { type: "OBJECT", properties: { topText: { type: "STRING" }, spokenText: { type: "STRING" }, imagePrompts: { type: "ARRAY", items: { type: "STRING" } } }, required: ["topText", "spokenText", "imagePrompts"] } },
                thumbnailText: { type: "STRING" },
                sonSoz: { type: "STRING" },
                lastQuote: { type: "STRING" },
                thumbnailImagePrompt: { type: "STRING" },
                tiktokTitle: { type: "STRING" },
                tiktokDescription: { type: "STRING" },
                tiktokHashtags: { type: "ARRAY", items: { type: "STRING" } },
                youtubeTitle: { type: "STRING" },
                youtubeDescription: { type: "STRING" },
                youtubeHashtags: { type: "ARRAY", items: { type: "STRING" } },
                mediaBlackout: { type: "OBJECT", properties: { show: { type: "BOOLEAN" }, percentageCovered: { type: "NUMBER" }, percentageIgnored: { type: "NUMBER" }, mediaNames: { type: "ARRAY", items: { type: "STRING" } }, explanation: { type: "STRING" } }, required: ["show", "percentageCovered", "percentageIgnored", "mediaNames", "explanation"] },
                chartData: { type: "OBJECT", properties: { show: { type: "BOOLEAN" }, type: { type: "STRING" }, title: { type: "STRING" }, note: { type: "STRING" }, items: { type: "ARRAY", items: { type: "OBJECT", properties: { label: { type: "STRING" }, value: { type: "NUMBER" } }, required: ["label", "value"] } } } }
            },
            required: ["isContentUnreadable", "videoSlides", "thumbnailText", "sonSoz", "lastQuote", "thumbnailImagePrompt", "tiktokTitle", "tiktokDescription", "tiktokHashtags", "youtubeTitle", "youtubeDescription", "youtubeHashtags", "mediaBlackout"]
        };

        // Medya varsa parts dizisini (inlineData dahil), yoksa metni gönder
        const data = await callGemini(
            sysPrompt + `\n\nJSON formatı:\n${jsonSchemaDef}`,
            hasMediaParts ? parts : parts.map(p => p.text || '').filter(Boolean).join('\n'),
            { responseFormat: true, responseSchema: contentSchema, temperature: 0.7, source: 'analyzeContent' }
        );
        if (data.candidates?.[0]?.finishReason === "SAFETY") throw new Error("İçerik güvenlik filtresine takıldı.");
        if (!data.candidates?.[0]?.content) throw new Error("Yapay Zeka API boş yanıt döndürdü.");
        try {
            const rawText = data.candidates[0].content.parts[0].text;
            console.log('[ANALYZE RAW] first 500:', rawText.substring(0, 500));
            const parsedData = extractJSON(rawText, 'analyzeContent');
            if (!parsedData.videoSlides && parsedData.scenes) {
                parsedData.videoSlides = parsedData.scenes.map(s => ({
                    topText: s.topText || s.sceneNumber?.toString() || "",
                    spokenText: s.spokenText || "",
                    imagePrompts: s.imagePrompts || [s.imagePrompt || ""]
                }));
                delete parsedData.scenes;
            }
            console.log('[ANALYZE PARSED] keys:', Object.keys(parsedData), 'slides:', parsedData.videoSlides?.length);
            if (parsedData.isContentUnreadable) throw new Error("Orijinal metne ulaşılamadı.");
            // spokenText'teki hata mesajlarını filtrele
            if (parsedData.videoSlides) {
                const errPatterns = [/görselde.*metin.*bulunmamaktadır/i, /no.*text.*found/i, /metin.*bulunamadı/i, /cannot.*read.*text/i];
                parsedData.videoSlides = parsedData.videoSlides.map(slide => {
                    if (slide.spokenText && errPatterns.some(p => p.test(slide.spokenText))) {
                        return { ...slide, spokenText: slide.topText || "Bu görseldeki içerik hakkında bilgi veriliyor." };
                    }
                    return slide;
                });
            }
            return parsedData;
        } catch (e) { if (e.message.includes('metne ulaşılamadı')) throw e; throw new Error(`JSON format hatası: ${e.message}`); }
    }

    // Tek bir görsel için 2-3 sahne üretir (sıralı akış için)
    static async analyzeContentForImage(inputData, inputType, config, imageIndex, totalImages, previousContext) {
        addSystemLog(`Görsel ${imageIndex + 1}/${totalImages} için sahneler üretiliyor...`, 'info');

        let styleInstruction = "Video stili: Tarafsız, analitik, ciddi ve keskin bir haber editörü.";
        if (config.videoStyle === 'prompt_output') styleInstruction = "Video stili: Özel Prompt Çıktısı. Kullanıcının girdiği metni doğrudan uygula.";

        let langInstruction = "BÜTÜN SENARYOYU TÜRKÇE YAZACAKSIN.";
        if (config.language === 'en') langInstruction = "BÜTÜN SENARYOYU İNGİLİZCE YAZACAKSIN.";
        if (config.language === 'fr') langInstruction = "BÜTÜN SENARYOYU FRANSIZCA YAZACAKSIN.";
        if (config.language === 'de') langInstruction = "BÜTÜN SENARYOYU ALMANCA YAZACAKSIN.";
        if (config.language === 'es') langInstruction = "BÜTÜN SENARYOYU İSPANYOLCA YAZACAKSIN.";
        if (config.language === 'ar') langInstruction = "BÜTÜN SENARYOYU ARAPÇA YAZACAKSIN.";
        if (config.language === 'ru') langInstruction = "BÜTÜN SENARYOYU RUSÇA YAZACAKSIN.";

        let dynamicRules = "";
        if (config.analysisMode === 'yorumsuz') {
            dynamicRules = `BİRİNCİ KURAL (SADECE HABER - YORUMSUZ): Girdiyi dikkatlice incele. SADECE haberi tarafsızca anlat. 5N1K kurallarını uygula. Kendi yorumunu katma.\nİKİNCİ KURAL: 'mediaBlackout.show' değerini false yap.\nÜÇÜNCÜ KURAL: Her sahnenin 'spokenText' metni NOKTA İLE BİTEN BİR CÜMLE OLMALIDIR.`;
        } else if (config.analysisMode === 'deep_analysis') {
            dynamicRules = `BİRİNCİ KURAL (DERİN ANALİZ): 5N1K dengesini sorgula ve sosyolojik/ekonomik etkileri analiz et.\nİKİNCİ KURAL: Skandalsa 'mediaBlackout.show' true yap.\nÜÇÜNCÜ KURAL: Her sahnenin 'spokenText' metni NOKTA İLE BİTEN BİR CÜMLE OLMALIDIR.`;
        } else {
            dynamicRules = `BİRİNCİ KURAL (HABER 5N1K): Girdiyi incele, 5N1K kuralına sadık kalarak özetle.\nİKİNCİ KURAL: Skandal değilse 'mediaBlackout.show' false yap.\nÜÇÜNCÜ KURAL: Her sahnenin 'spokenText' metni NOKTA İLE BİTEN BİR CÜMLE OLMALIDIR.`;
        }

        // extractStatsHint tanımla (analyzeContent ile aynı mantık)
        let extractStatsHint = "Olayı tam anla ve KISA BİR ÖZET ver.";
        if (config.analysisMode === 'yorumsuz') extractStatsHint = "SADECE haberi tarafsızca oku.";

        const contextBlock = previousContext ? `\nÖNCEKİ BLOKLARIN ÖZETİ: ${previousContext}\nBu bilgileri tekrarlama, SADECE bu görsel/eğerseldeki yeni içeriğe odaklan.` : "";
        const isLastImage = imageIndex === totalImages - 1;
        const sonSozRule = isLastImage ? `\n\nYEDİNCİ KURAL (SON SÖZ): Konuya cuk diye oturan çok vurucu bir ATASÖZÜ veya ÖZLÜ SÖZ belirle. Bunu 'sonSoz' alanına kaydet.` : "";

        const sysPrompt = `Bu, ${totalImages} görsellik bir videonun ${imageIndex + 1}. bloğudur.\nSen TikTok ve Instagram Reels için viral içerikler üreten profesyonel bir içerik üreticisisin.\n\nSENARYOYU TAM OLARAK 2 SAHNE olacak şekilde böl! Görseldeki haberi/konuyu 2 farklı açıdan anlat.\nHer sahne bu görsele ait haberi anlatmalı.\nToplam konuşma metni bu blok için 30-50 kelime aralığında olmalıdır.\n\nDİL KURALI: ${langInstruction}\n${styleInstruction}\n${dynamicRules}\n${contextBlock}\n\nKAPAK DİLİ: 'thumbnailText' ${config.language} dilinde olmalıdır. Clickbait başlık olmalıdır.\nYOUTUBE: 'youtubeTitle' ve 'youtubeDescription' alanlarını ${config.language} dilinde oluştur. YouTube SEO kurallarına uygun, dikkat çekici başlık ve açıklayıcı açıklama yaz. 'youtubeHashtags' dizisine 5-8 adet ilgili hashtag ekle.\nGRAFİKLER: İstatistik yoksa 'chartData.show' false yap.\nGÖRSEL UYUMU: 'imagePrompts' alanına yazacağın İngilizce komutlar, spokenText'teki ana görsel unsurları birebir tanımlamalıdır.\nATATÜRK HASSASİYETİ: 'Atatürk' geçerse 'imagePrompts' kısmına "Mustafa Kemal Atatürk, highly detailed, respectful portrait" ekle!${sonSozRule}\n\nDönüş ZORUNLU olarak JSON formatında olmalı:\n{\n  "isContentUnreadable": false,\n  "videoSlides": [\n    {"topText": "Kısa başlık", "spokenText": "Seslendirme metni", "imagePrompts": ["İngilizce görsel prompt"]}\n  ],\n  "thumbnailText": "string",\n  "sonSoz": "string",\n  "lastQuote": "string",\n  "thumbnailImagePrompt": "string",\n  "youtubeTitle": "string",\n  "youtubeDescription": "string",\n  "youtubeHashtags": ["hashtag1", "hashtag2"],\n  "mediaBlackout": {"show": false, "percentageCovered": 0, "percentageIgnored": 0, "mediaNames": [], "explanation": ""}\n}`;

        let parts = [];

        if (inputType === 'media' && Array.isArray(inputData)) {
            const targetFile = inputData[0];
            if (targetFile) {
                const b64 = targetFile.data.split(',')[1];
                parts = [{ inlineData: { mimeType: targetFile.type || "application/octet-stream", data: b64 } }, { text: "Bu görseldeki haberi/konuyu detaylıca incele ve 2 sahnede anlat." }];
            } else {
                parts = [{ text: `Görsel bulunamadı.` }];
            }
        } else if (inputType === 'prompt') {
            parts = [{ text: `AŞAĞIDAKİ TALİMATI UYGULA (Bu ${imageIndex + 1}/${totalImages} blok):\n\n${inputData}\n\n${extractStatsHint}` }];
        } else if (inputType === 'url') {
            parts = [{ text: `[KRİTİK GÖREV]: URL'yi oku.\nURL: ${inputData}\nBu ${imageIndex + 1}/${totalImages} blok için içeriğe dayanarak haberi özetle. ${extractStatsHint}` }];
        } else {
            parts = [{ text: `Aşağıdaki konuyu internette araştır. Bu ${imageIndex + 1}/${totalImages} blok için haberi özetle.\n\n${inputData}\n\n${extractStatsHint}` }];
        }

        // JSON schema tanımı
        const imageSchema = {
            type: "OBJECT",
            properties: {
                isContentUnreadable: { type: "BOOLEAN" },
                videoSlides: { type: "ARRAY", items: { type: "OBJECT", properties: { topText: { type: "STRING" }, spokenText: { type: "STRING" }, imagePrompts: { type: "ARRAY", items: { type: "STRING" } } }, required: ["topText", "spokenText", "imagePrompts"] } },
                thumbnailText: { type: "STRING" },
                sonSoz: { type: "STRING" },
                lastQuote: { type: "STRING" },
                thumbnailImagePrompt: { type: "STRING" },
                youtubeTitle: { type: "STRING" },
                youtubeDescription: { type: "STRING" },
                youtubeHashtags: { type: "ARRAY", items: { type: "STRING" } },
                mediaBlackout: { type: "OBJECT", properties: { show: { type: "BOOLEAN" }, percentageCovered: { type: "NUMBER" }, percentageIgnored: { type: "NUMBER" }, mediaNames: { type: "ARRAY", items: { type: "STRING" } }, explanation: { type: "STRING" } }, required: ["show", "percentageCovered", "percentageIgnored", "mediaNames", "explanation"] },
                chartData: { type: "OBJECT", properties: { show: { type: "BOOLEAN" }, type: { type: "STRING" }, title: { type: "STRING" }, note: { type: "STRING" }, items: { type: "ARRAY", items: { type: "OBJECT", properties: { label: { type: "STRING" }, value: { type: "NUMBER" } }, required: ["label", "value"] } } } }
            },
            required: ["isContentUnreadable", "videoSlides", "thumbnailText", "sonSoz", "lastQuote", "thumbnailImagePrompt", "youtubeTitle", "youtubeDescription", "youtubeHashtags", "mediaBlackout"]
        };

        // AI ile görsel analizi — parts dizisini doğrudan geçir (medya dahil)
        addSystemLog(`Görsel ${imageIndex + 1} AI ile analiz ediliyor...`, 'info');
        const data = await callGemini(null, parts, {
            responseFormat: true,
            responseSchema: imageSchema,
            temperature: 0.7,
            source: `Image${imageIndex + 1}`,
            systemInstruction: { parts: [{ text: sysPrompt }] },
            tools: [{ google_search: {} }]
        });
        if (data.candidates?.[0]?.finishReason === "SAFETY") throw new Error("İçerik güvenlik filtresine takıldı.");
        if (!data.candidates?.[0]?.content) throw new Error("Yapay Zeka API boş yanıt döndürdü.");
        try {
            const rawPartText = data.candidates[0].content.parts[0].text;
            console.log('[DEBUG] rawPartText type:', typeof rawPartText, 'value:', typeof rawPartText === 'string' ? rawPartText.substring(0, 200) : (JSON.stringify(rawPartText) || '').substring(0, 200));
            const safeText = typeof rawPartText === 'string' ? rawPartText : JSON.stringify(rawPartText);
            const parsedData = extractJSON(safeText, `Görsel ${imageIndex + 1}`);
            // Mimo bazen scenes olarak döndürür → videoSlides'a normalize et
            if (!parsedData.videoSlides && parsedData.scenes) {
                parsedData.videoSlides = parsedData.scenes.map(s => ({
                    topText: s.topText || s.sceneNumber?.toString() || "",
                    spokenText: s.spokenText || "",
                    imagePrompts: s.imagePrompts || [s.imagePrompt || ""]
                }));
                delete parsedData.scenes;
            }
            if (parsedData.isContentUnreadable) throw new Error("Orijinal metne ulaşılamadı.");
            // spokenText'teki hata mesajlarını filtrele
            if (parsedData.videoSlides) {
                const errPatterns = [/görselde.*metin.*bulunmamaktadır/i, /no.*text.*found/i, /metin.*bulunamadı/i, /cannot.*read.*text/i];
                parsedData.videoSlides = parsedData.videoSlides.map(slide => {
                    if (slide.spokenText && errPatterns.some(p => p.test(slide.spokenText))) {
                        return { ...slide, spokenText: slide.topText || "Bu görseldeki içerik hakkında bilgi veriliyor." };
                    }
                    return slide;
                });
            }
            console.log('[SLIDE DEBUG] parsedData keys:', Object.keys(parsedData), 'videoSlides:', (JSON.stringify(parsedData.videoSlides) || '').substring(0, 300));
            addSystemLog(`Görsel ${imageIndex + 1} için ${parsedData.videoSlides?.length || 0} sahne üretildi.`, 'success');
            return parsedData;
        } catch (e) { console.log('[EXTRACT ERROR]', e.stack || e.message); if (e.message.includes('metne ulaşılamadı')) throw e; throw new Error(`JSON format hatası (Görsel ${imageIndex + 1}): ${e.message}`); }
    }

    static async _buildGuzelSozScript(inputData, inputType, config) {
        let quoteText = "";

        if (typeof inputData === 'string') {
            quoteText = inputData.trim();
            addSystemLog(`Metin girdisi: ${quoteText.length} karakter, ${quoteText.split(/\s+/).length} kelime`, 'info');
        } else if (Array.isArray(inputData) && inputData.length > 0) {
            const videoFile = inputData.find(f => f.type?.startsWith('video/'));
            const imageFile = inputData.find(f => f.type?.startsWith('image/'));

            if (videoFile) {
                addSystemLog('Video dosyası algılandı, kare çıkarılıyor...', 'info');
                // Video dosyasından 1. saniyede kare çıkaran fonksiyon
                const extractFrame = () => new Promise((resolve) => {
                    const video = document.createElement('video');
                    video.muted = true;
                    video.playsInline = true;
                    const raw = videoFile.data.includes(',') ? videoFile.data.split(',')[1] : videoFile.data;
                    const byteString = atob(raw);
                    const ab = new ArrayBuffer(byteString.length);
                    const ia = new Uint8Array(ab);
                    for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
                    const blob = new Blob([ab], { type: videoFile.type || 'video/mp4' });
                    video.src = URL.createObjectURL(blob);
                    video.onloadeddata = () => { video.currentTime = Math.min(1, video.duration * 0.1); };
                    video.onseeked = () => {
                        try {
                            const canvas = document.createElement('canvas');
                            canvas.width = video.videoWidth || 640;
                            canvas.height = video.videoHeight || 480;
                            canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                            URL.revokeObjectURL(video.src);
                            resolve(canvas.toDataURL('image/jpeg', 0.9).split(',')[1]);
                        } catch (e) { URL.revokeObjectURL(video.src); resolve(null); }
                    };
                    video.onerror = () => { URL.revokeObjectURL(video.src); resolve(null); };
                    setTimeout(() => { URL.revokeObjectURL(video.src); resolve(null); }, 10000);
                });

                const frameB64 = await extractFrame();
                if (frameB64) {
                    addSystemLog('Videodan kare başarıyla çıkarıldı, OCR başlıyor...', 'success');
                    const imgType = 'image/jpeg';
                    const splitIntoStrips = (srcB64, stripCount) => {
                        return new Promise((resolve) => {
                            const img = new Image();
                            img.crossOrigin = "Anonymous";
                            img.onload = () => {
                                const strips = [];
                                const stripHeight = Math.ceil(img.height / stripCount);
                                for (let i = 0; i < stripCount; i++) {
                                    const canvas = document.createElement('canvas');
                                    canvas.width = img.width;
                                    canvas.height = stripHeight;
                                    const ctx = canvas.getContext('2d');
                                    ctx.fillStyle = 'white';
                                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                                    ctx.drawImage(img, 0, i * stripHeight, img.width, stripHeight, 0, 0, img.width, stripHeight);
                                    strips.push(canvas.toDataURL('image/jpeg', 0.95).split(',')[1]);
                                }
                                resolve(strips);
                            };
                            img.onerror = () => resolve([srcB64]);
                            img.src = 'data:image/jpeg;base64,' + srcB64;
                        });
                    };
                    const ocrCall = async (imageB64, prompt) => {
                        try { return await mimoOcr(imageB64, prompt, imgType); }
                        catch (e) { addSystemLog(`  Mimo OCR hatası: ${e.message}`, 'warn'); return ""; }
                    };
                    quoteText = "";
                    const models = ['mimo-v2.5'];
                    // Tekrar eden satırları kaldıran fonksiyon
                    const deduplicateLines = (text) => {
                        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                        const seen = new Set();
                        const result = [];
                        for (const line of lines) {
                            const normalized = line.toLowerCase().replace(/[^\wçğıöşüÇĞIİÖŞÜ]/g, '');
                            if (!seen.has(normalized)) { seen.add(normalized); result.push(line); }
                        }
                        return result.join('\n');
                    };
                    // OCR hata mesajı kontrolü — şerit metni hata mesajıysa atla
                    const isOcrErrorMessage = (text) => {
                        const t = text.toLowerCase().trim();
                        return t.startsWith('görselde') || t.startsWith('bu görselde') || t.startsWith('bu resimde') ||
                            t.startsWith('no text') || t.startsWith('cannot') || t.startsWith('ocr') ||
                            t.includes('bulunmamaktadır') || t.includes('bulunamadı') || t.includes('yazı yok');
                    };
                    addSystemLog('Deneme 1: Videodan çıkarılan kareyi 3 şeride böl...', 'info');
                    for (const model of models) {
                        if (quoteText) break;
                        try {
                            const strips = await splitIntoStrips(frameB64, 3);
                            const stripTexts = [];
                            for (let i = 0; i < strips.length; i++) {
                                const result = await ocrCall(strips[i], 'Bu şeritteki yazıyı oku. Sadece metni yaz, başka bir şey yazma.', model);
                                if (result.length > 2 && !isOcrErrorMessage(result)) {
                                    stripTexts.push(result);
                                    addSystemLog(`  Şerit ${i+1}: "${result.substring(0, 40)}..."`, 'info');
                                } else if (result.length > 2) {
                                    addSystemLog(`  Şerit ${i+1}: HATA MESAJI atlandı: "${result.substring(0, 40)}..."`, 'warn');
                                }
                            }
                            if (stripTexts.length > 0) { quoteText = deduplicateLines(stripTexts.join('\n')); addSystemLog(`✓ ${model} video OCR başarılı: ${quoteText.length} karakter`, 'success'); }
                        } catch (e) { addSystemLog(`  ${model} hatası: ${e.message}`, 'warn'); }
                    }
                    if (!quoteText) {
                        addSystemLog('Deneme 2: Tam kare ile okuma...', 'info');
                        for (const model of models) {
                            if (quoteText) break;
                            try {
                                const result = await ocrCall(frameB64, 'Bu resimdeki tüm yazıyı en üstten en alta, satır satır yaz. Sadece metni ver.', model);
                                if (result.length > 15) { quoteText = result; addSystemLog(`✓ ${model} tam kare başarılı: ${quoteText.length} karakter`, 'success'); }
                            } catch (e) { addSystemLog(`  ${model} hatası: ${e.message}`, 'warn'); }
                        }
                    }
                }
                if (!quoteText) {
                    quoteText = videoFile.name?.replace(/[_-]/g, ' ').replace(/\.[^.]+$/, '') || "Güzel bir söz";
                    addSystemLog('OCR başarısız, dosya adı kullanıldı.', 'warn');
                }
            } else if (imageFile) {
                addSystemLog('Resim OCR başlıyor (şerit tabanlı)...', 'info');
                const b64Data = imageFile.data.split(',')[1] || imageFile.data;
                const imgType = imageFile.type || 'image/jpeg';

                const splitIntoStrips = (srcB64, stripCount) => {
                    return new Promise((resolve) => {
                        const img = new Image();
                        img.crossOrigin = "Anonymous";
                        img.onload = () => {
                            const strips = [];
                            const stripHeight = Math.ceil(img.height / stripCount);
                            for (let i = 0; i < stripCount; i++) {
                                const canvas = document.createElement('canvas');
                                canvas.width = img.width;
                                canvas.height = stripHeight;
                                const ctx = canvas.getContext('2d');
                                ctx.fillStyle = 'white';
                                ctx.fillRect(0, 0, canvas.width, canvas.height);
                                ctx.drawImage(img, 0, i * stripHeight, img.width, stripHeight, 0, 0, img.width, stripHeight);
                                strips.push(canvas.toDataURL('image/jpeg', 0.95).split(',')[1]);
                            }
                            resolve(strips);
                        };
                        img.onerror = () => resolve([srcB64]);
                        img.src = 'data:image/jpeg;base64,' + srcB64;
                    });
                };

                const ocrCall = async (imageB64, prompt) => {
                    try { return await mimoOcr(imageB64, prompt, imgType); }
                    catch (e) { addSystemLog(`  Mimo OCR hatası: ${e.message}`, 'warn'); return ""; }
                };

                quoteText = "";
                const models = ['mimo-v2.5'];
                // Tekrar eden satırları kaldıran fonksiyon
                const dedupLines = (text) => {
                    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                    const seen = new Set();
                    const result = [];
                    for (const line of lines) {
                        const normalized = line.toLowerCase().replace(/[^\wçğıöşüÇĞIİÖŞÜ]/g, '');
                        if (!seen.has(normalized)) { seen.add(normalized); result.push(line); }
                    }
                    return result.join('\n');
                };

                addSystemLog('Deneme 1: Görseli 3 şeride böl, her birini ayrı oku...', 'info');
                for (const model of models) {
                    if (quoteText) break;
                    try {
                        const strips = await splitIntoStrips(b64Data, 3);
                        addSystemLog(`  ${model}: ${strips.length} şerit bölündü`, 'info');
                        const stripTexts = [];
                        const isOcrErr = (t) => { const l = t.toLowerCase().trim(); return l.startsWith('görselde') || l.startsWith('bu görselde') || l.startsWith('bu resimde') || l.startsWith('no text') || l.startsWith('cannot') || l.includes('bulunmamaktadır') || l.includes('bulunamadı') || l.includes('yazı yok'); };
                        for (let i = 0; i < strips.length; i++) {
                            const result = await ocrCall(strips[i],
                                'Bu şeritteki yazıyı oku. Sadece metni yaz, başka bir şey yazma.',
                                model
                            );
                            if (result.length > 2 && !isOcrErr(result)) {
                                stripTexts.push(result);
                                addSystemLog(`  Şerit ${i+1}: "${result.substring(0, 40)}..."`, 'info');
                            }
                        }
                        if (stripTexts.length > 0) {
                            quoteText = dedupLines(stripTexts.join('\n'));
                            addSystemLog(`✓ ${model} şerit okuma başarılı: ${quoteText.length} karakter`, 'success');
                            addSystemLog(`TAM METİN: ${quoteText}`, 'info');
                        }
                    } catch (e) { addSystemLog(`  ${model} şerit hatası: ${e.message}`, 'warn'); }
                }

                if (!quoteText) {
                    addSystemLog('Deneme 2: Görseli 5 şeride böl...', 'info');
                    for (const model of models) {
                        if (quoteText) break;
                        try {
                            const strips = await splitIntoStrips(b64Data, 5);
                            const stripTexts = [];
                            const isOcrErr5 = (t) => { const l = t.toLowerCase().trim(); return l.startsWith('görselde') || l.startsWith('bu görselde') || l.startsWith('bu resimde') || l.startsWith('no text') || l.startsWith('cannot') || l.includes('bulunmamaktadır') || l.includes('bulunamadı') || l.includes('yazı yok'); };
                            for (let i = 0; i < strips.length; i++) {
                                const result = await ocrCall(strips[i],
                                    'Bu görsel şeritteki yazıyı tam olarak oku. Sadece metni ver.',
                                    model
                                );
                                if (result.length > 2 && !isOcrErr5(result)) stripTexts.push(result);
                            }
                            if (stripTexts.length > 0) {
                                quoteText = dedupLines(stripTexts.join('\n'));
                                addSystemLog(`✓ ${model} 5-şerit başarılı: ${quoteText.length} karakter`, 'success');
                                addSystemLog(`TAM METİN: ${quoteText}`, 'info');
                            }
                        } catch (e) { addSystemLog(`  Hata: ${e.message}`, 'warn'); }
                    }
                }

                if (!quoteText) {
                    addSystemLog('Deneme 3: Bütün görsel, basit okuma...', 'info');
                    for (const model of models) {
                        if (quoteText) break;
                        try {
                            const result = await ocrCall(b64Data,
                                'Bu resimdeki tüm yazıyı en üstten en alta, satır satır yaz. Sadece metni ver.',
                                model
                            );
                            if (result.length > 15) {
                                quoteText = result;
                                addSystemLog(`✓ ${model} basit okuma: ${quoteText.length} karakter`, 'success');
                                addSystemLog(`TAM METİN: ${quoteText}`, 'info');
                            }
                        } catch (e) { addSystemLog(`  Hata: ${e.message}`, 'warn'); }
                    }
                }

                if (!quoteText) {
                    const rawName = imageFile.name.replace(/[_-]/g, ' ').replace(/\.[^.]+$/, '');
                    quoteText = rawName.length > 5 ? rawName : "Güzel bir söz";
                    addSystemLog('OCR başarısız, dosya adı kullanıldı.', 'warn');
                }
            } else {
                quoteText = inputData[0].name?.replace(/[_-]/g, ' ').replace(/\.[^.]+$/, '') || "Güzel bir söz";
            }
        }

        // Hata mesajlarını filtrele — AI görselde metin bulamayabilir
        // SADECE metnin başını kontrol et (ilk 100 karakter) — AI açıklama yapıp sonra alıntı yazabilir
        const errorPatterns = [
            /görselde\s+(herhangi\s+)?bir\s+metin\s+bulunmamaktadır/i,
            /bu\s+görselde\s+metin\s+yok/i,
            /no\s+text\s+found\s+in\s+(the\s+)?image/i,
            /görselde\s+yazı\s+bulunamadı/i,
            /metin\s+bulunamadı/i,
            /cannot\s+(read|find|detect)\s+text/i,
            /ocr\s+(failed|error|başarısız)/i,
            /bu\s+resimde\s+yazı\s+yok/i
        ];
        const firstPart = quoteText.substring(0, 100);
        const isError = errorPatterns.some(p => p.test(firstPart));
        if (isError) {
            addSystemLog(`OCR hata başlığı algılandı: "${firstPart.substring(0, 50)}..."`, 'warn');
            // Hata mesajını kaldır — geri kalan metin gerçek alıntı olabilir
            let cleanedText = quoteText;
            for (const pattern of errorPatterns) {
                cleanedText = cleanedText.replace(pattern, '').trim();
            }
            // "Sadece bir gül ve..." gibi açıklama cümlelerini de kaldır
            cleanedText = cleanedText.replace(/^sadece\s+.+?(?=[A-ZÇĞIİÖŞÜ])/s, '').trim();
            // Nokta ile başlayan kısmı kaldır
            cleanedText = cleanedText.replace(/^\.\s*/, '').trim();
            // Eğer temizlenmiş metin 10 karakterden uzunsa onu kullan, değilse dosya adı
            if (cleanedText.length > 10) {
                quoteText = cleanedText;
                addSystemLog(`Hata mesajı kaldırıldı, alıntı çıkarıldı: "${quoteText.substring(0, 50)}..."`, 'success');
            } else {
                // Dosya adını kullan (imageFile veya videoFile)
                if (inputType === 'media' && Array.isArray(inputData) && inputData[0]?.name) {
                    quoteText = inputData[0].name.replace(/[_-]/g, ' ').replace(/\.[^.]+$/, '');
                } else {
                    quoteText = "Güzel bir söz";
                }
                addSystemLog(`Alıntı bulunamadı, dosya adı kullanılacak: "${quoteText}"`, 'warn');
            }
        }
        if (!quoteText || quoteText.length < 3) quoteText = "Güzel bir söz";
        addSystemLog(`Son söz metni: ${quoteText.length} karakter`, 'info');

        const emotion = analyzeQuoteEmotion(quoteText);
        addSystemLog(`Güzel söz: "${quoteText.substring(0, 60)}..." (duygu: ${emotion})`, 'info');

        // Atatürk tespiti — alakalı görseller üret
        const ataturkKeywords = ['atatürk', 'mustafa kemal', 'samsun', 'kurtuluş', 'cumhuriyet', 'bağımsızlık', 'milli mücadele', 'inkılap', 'devrim', 'paşa', 'gazi', 'anıtkabir', '19 mayıs', 'ulus'];
        const lowerQuote = quoteText.toLowerCase();
        const isAtaturkRelated = ataturkKeywords.some(kw => lowerQuote.includes(kw));
        if (isAtaturkRelated) addSystemLog('Atatürk içerikli söz tespit edildi — özel görseller üretilecek.', 'info');

        // Her söz satırı için ayrı görsel prompt üret — duygu/içerik uyumlu
        let sceneDescriptions = [];
        const quoteLines = quoteText.split('\n').map(l => l.trim()).filter(l => l.length > 3);
        // En az 3, en fazla 8 görsel
        const linesToProcess = quoteLines.length >= 3 ? quoteLines.slice(0, 8) : quoteLines;

        for (let i = 0; i < linesToProcess.length; i++) {
            try {
                // AI ile görsel prompt üretimi
                const prompt = isAtaturkRelated
                    ? `Generate a detailed English image prompt for Atatürk-related quote line.\n\nLine: "${linesToProcess[i]}"\nEmotion: ${emotion}\n\nRules:\n- 1-2 sentences, highly detailed\n- Must include Mustafa Kemal Atatürk portrait elements\n- NO text in the image\n- Cinematic, patriotic, dramatic lighting`
                    : `Generate a detailed English image prompt that VISUALLY represents this specific quote line.\n\nLine: "${linesToProcess[i]}"\nFull Quote: "${quoteText}"\nEmotion: ${emotion}\n\nRules:\n- 1-2 sentences, highly detailed and visual\n- The image MUST directly represent the MEANING of this specific line\n- If the line is about "choice" show a crossroads or decision moment\n- If about "happiness" show joyful, bright scenes\n- If about "respect" show dignified, honorable scenes\n- Match the emotional tone perfectly\n- NO text in the image\n- Cinematic lighting and composition`;
                const data = await callAI(null, prompt, { maxTokens: 150, temperature: 0.8, source: `GuzelSoz${i + 1}` });
                const desc = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
                if (desc) { sceneDescriptions.push(desc); addSystemLog(`Sahne ${i + 1} tanımlandı: "${linesToProcess[i].substring(0, 30)}..."`, 'success'); }
            } catch (e) { addSystemLog(`Sahne ${i + 1} hatası: ${e.message}`, 'warn'); }
        }
        if (sceneDescriptions.length === 0) {
            if (isAtaturkRelated) {
                // Atatürk fallback sahneleri
                sceneDescriptions = [
                    'Mustafa Kemal Atatürk at Samsun harbor 1919, dawn, Turkish flag, cinematic patriotic scene, epic composition',
                    'Turkish War of Independence, soldiers marching through Anatolian mountains, golden sunset, heroic atmosphere',
                    'Founding of modern Turkey, Ankara parliament, secular reforms, hopeful dawn light, national pride'
                ];
            } else {
                const stopWords = ['bir', 'ile', 'için', 'olan', 'değil', 'daha', 'çok', 'kadar', 'sonra', 'önce', 'böyle', 'şöyle', 'ancak', 'hem', 'ya', 'ki', 'ise', 'gibi', 'ama', 've', 'da', 'de', 'mi', 'mı', 'mu', 'mü', 'ben', 'sen', 'biz', 'siz', 'o', 'bu', 'şu', 'ne', 'nasıl', 'neden', 'niçin', 'kim', 'kime', 'kimin', 'her', 'hiç'];
                const words = quoteText.toLowerCase().replace(/[^\wçğıöşüÇĞIİÖŞÜ\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !stopWords.includes(w));
                const uniqueWords = [...new Set(words)].slice(0, 8);
                const emotionSceneMap = {
                    'mutlu': 'bright, sunny, joyful atmosphere, warm golden colors, people smiling, celebration mood',
                    'hüzünlü': 'melancholic, rainy window, emotional, soft blue lighting, contemplative mood, lone figure',
                    'romantik': 'romantic sunset, candlelight, intimate setting, soft focus, dreamy atmosphere, warm tones',
                    'notr': 'artistic, symbolic, abstract geometric, dramatic lighting, cinematic composition'
                };
                const emotionScene = emotionSceneMap[emotion] || emotionSceneMap['notr'];
                // Her söz satırı için fallback görsel
                for (let i = 0; i < linesToProcess.length; i++) {
                    const lineWords = linesToProcess[i].toLowerCase().replace(/[^\wçğıöşüÇĞIİÖŞÜ\s]/g, '').split(/\s+/).filter(w => w.length > 2);
                    sceneDescriptions.push(`A ${emotionScene} scene representing: "${linesToProcess[i].substring(0, 60)}" — highly detailed, cinematic composition`);
                }
            }
        }

        // Atatürk içerikli sözlerde gerçek görseller çek (Imagen üretemez)
        let realImageUrls = [];
        if (isAtaturkRelated) {
            addSystemLog('Atatürk görselleri Wikimedia Commons\'tan çekiliyor...', 'info');
            const searchQueries = ['Mustafa Kemal Atatürk', 'Samsun 1919', 'Turkish War of Independence'];
            for (const q of searchQueries) {
                const urls = await fetchWikimediaImages(q, 1);
                realImageUrls.push(...urls);
            }
            if (realImageUrls.length > 0) {
                addSystemLog(`${realImageUrls.length} gerçek Atatürk görseli bulundu.`, 'success');
            } else {
                addSystemLog('Wikimedia\'dan görsel bulunamadı — AI görseller kullanılacak.', 'warn');
            }
        }

        return {
            isContentUnreadable: false,
            videoSlides: sceneDescriptions.map((desc, i) => ({
                topText: linesToProcess[i] || quoteText,
                spokenText: linesToProcess[i] || "",
                imagePrompts: [desc]
            })),
            thumbnailText: quoteText.length > 120 ? quoteText.substring(0, 120) + '...' : quoteText,
            sonSoz: "",
            lastQuote: quoteText,
            thumbnailImagePrompt: sceneDescriptions[0] || "",
            tiktokTitle: quoteText.substring(0, 60),
            tiktokDescription: quoteText,
            tiktokHashtags: isAtaturkRelated ? ['#atatürk', '#mustafakemal', '#samsun', '#19mayıs', '#kurtuluşsavaşı', '#cumhuriyet'] : ['#güzelsöz', '#özlsöz', '#motivasyon'],
            _suggestedMusic: null,
            _isAtaturkRelated: isAtaturkRelated,
            _realImageUrls: realImageUrls, // Gerçek görseller (Atatürk vb.)
            mediaBlackout: { show: false, percentageCovered: 0, percentageIgnored: 0, mediaNames: [], explanation: "" },
            chartData: { show: false, type: "bar", title: "", note: "", items: [] },
            _isGuzelSoz: true,
            _emotion: emotion,
            _sceneCount: sceneDescriptions.length
        };
    }

    // Spotify modu — uzun form içerik (min 15 dk)
    static async _buildSpotifyScript(inputData, inputType, config) {
        addSystemLog('Spotify modu: Konular belirleniyor...', 'info');
        const langMap = { 'tr': 'Türkçe', 'en': 'English', 'fr': 'Français', 'de': 'Deutsch', 'es': 'Español', 'ar': 'العربية', 'ru': 'Русский' };
        const langName = langMap[config.language] || 'Türkçe';
        const wps = getWPS(config.language);
        const minPerTopic = 5 * 60 * wps; // her konu 5 dk ≈ kelime

        // ADM 1: Konuları tespit et — kaç konu var?
        let inputText = '';
        if (inputType === 'media' && Array.isArray(inputData)) {
            inputText = inputData.map(f => f.name || '').join(' ');
        } else if (typeof inputData === 'string') {
            inputText = inputData;
        }

        // Görsellerden konuları çıkarma
        let topics = [];
        if (inputType === 'media' && Array.isArray(inputData) && inputData.length > 0) {
            // Her görsel için OCR + konu tespiti
            addSystemLog(`${inputData.length} görsel bulundu, her birinden konu çıkarılıyor...`, 'info');
            for (let i = 0; i < inputData.length; i++) {
                const file = inputData[i];
                if (file.type?.startsWith('image')) {
                    try {
                        const b64 = file.data.split(',')[1];
                        try {
                            const topic = await mimoOcr(b64, 'Bu görseldeki ana konuyu/başlığı tespit et. Sadece konuyu yaz, başka bir şey yazma.', file.type, { model: 'mimo-v2.5', maxTokens: 100, temperature: 0.1 });
                            if (topic && topic.length > 3) {
                                topics.push(topic);
                                addSystemLog(`Görsel ${i + 1} konu: "${topic}"`, 'success');
                            }
                        } catch (e) {
                            addSystemLog(`Görsel ${i + 1} konu tespit hatası: ${e.message}`, 'warn');
                        }
                    } catch (e) {
                        addSystemLog(`Görsel ${i + 1} konu tespit hatası: ${e.message}`, 'warn');
                    }
                }
            }
        }

        // Konu bulunamadıysa inputData'dan çıkar
        if (topics.length === 0) {
            if (typeof inputData === 'string') {
                // Satır satır veya virgülle ayrılmış konular
                topics = inputData.split(/[,\n]/).map(t => t.trim()).filter(t => t.length > 3);
            }
            if (topics.length === 0) {
                topics = [typeof inputData === 'string' ? inputData : 'Genel kültür'];
            }
        }

        addSystemLog(`${topics.length} konu belirlendi. Her konu için derin araştırma yapılacak.`, 'info');

        // ADM 2: Her konuyu AYRI AYRI araştır
        const allSlides = [];
        let firstThumbnailText = '';
        let lastSonSoz = 'Görüşmek üzere, kendinize iyi bakın.';

        for (let t = 0; t < topics.length; t++) {
            const topic = topics[t];
            addSystemLog(`[${t + 1}/${topics.length}] Konu araştırılıyor: "${topic.substring(0, 50)}..."`, 'info');

            // Bu konu için derin araştırma
            let research = '';
            try {
                addSystemLog(`[${t + 1}/${topics.length}] AI ile araştırma yapılıyor...`, 'info');
                const researchPrompt = `"${topic}" hakkında 5N1K habercilik kurallarına göre derin araştırma yap.\n\nŞunları kapsa:\n- NE: Konunun kendisi ve ne olduğu\n- KİM: İlgili taraflar, kişiler, kurumlar\n- NEREDE: Konunun gerçekleştiği yer/coğrafya\n- NE ZAMAN: Zaman çizelgesi, tarihçe, önemli tarihler\n- NEDEN: Sebepler, arkasındaki nedenler\n- NASIL: Gerçekleşme şekli, detaylar, mekanizmalar\n- Güncel durum ve son gelişmeler\n- Önemli istatistikler ve veriler\n- Farklı bakış açıları ve tartışmalar\n- Geleceğe yönelik beklentiler\n- Pratik örnekler ve vaka çalışmaları\n\n${langName} dilinde, en az ${Math.floor(minPerTopic)} kelime olacak kadar detaylı yaz.`;
                const d = await callAI(null, researchPrompt, { maxTokens: 8192, temperature: 0.8, source: `SpotifyResearch${t + 1}` });
                research = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
                addSystemLog(`[${t + 1}/${topics.length}] Araştırma: ${research.length} karakter.`, 'success');
            } catch (e) {
                addSystemLog(`[${t + 1}/${topics.length}] Araştırma hatası: ${e.message}`, 'warn');
            }

            // Bu konu için sahne üret (en az 10 sahne ≈ 5 dk)
            const scenesPerTopic = Math.max(10, Math.floor(minPerTopic / 55));
            addSystemLog(`[${t + 1}/${topics.length}] ${scenesPerTopic} sahne üretiliyor...`, 'info');

            const isFirst = t === 0;
            const isLast = t === topics.length - 1;

            const sysPrompt = `Sen Spotify podcast tarzında uzun form içerik üreten profesyonel bir sunucusun.

GÖREV: "${topic}" konusu hakkında 5N1K habercilik kurallarına göre analiz ederek tam olarak ${scenesPerTopic} sahneden oluşan detaylı bir bölüm yaz.

5N1K ANALİZ KURALLARI:
- NE: Konunun kendisi, ne oldu/ne oluyor
- KİM: İlgili taraflar, kişiler, kurumlar
- NEREDE: Konunun gerçekleştiği yer/coğrafya
- NE ZAMAN: Zaman çizelgesi, tarihçe
- NEDEN: Sebepler, arkasındaki nedenler
- NASIL: Gerçekleşme şekli, detaylar, mekanizmalar

KURALLAR:
- Her sahnenin 'spokenText' metni 50-70 kelime olsun (çok detaylı anlat)
- Toplam metin en az ${Math.floor(minPerTopic)} kelime olmalı
- DİL: ${langName} dilinde yaz
- Anlatım akıcı, samimi ve derinlemesine bilgilendirici olsun
- Sadece özetleme, DETAYLI anlat: örnekler ver, hikayeler anlat, veriler sun
${isFirst ? '- Giriş yap: "Merhaba, bugün sizlerle [konu] hakkında derinlemesine konuşacağız."' : `- ${t}. bölüme geçiş yap: "Şimdi başka bir önemli konuya geçiyoruz: ${topic}"`}
${isLast ? '- Çıkış: "Görüşmek üzere, kendinize iyi bakın."' : ''}
- 'topText' her sahne için kısa bir başlık olsun
- 'imagePrompts' her sahne için İngilizce görsel prompt olsun
- SADECE videoSlides dizisi dön (diğer alanları boş bırak)

JSON formatında dön.`;

            try {
                addSystemLog(`[${t + 1}/${topics.length}] AI ile sahne üretiliyor...`, 'info');
                const userMsg = `KONU: ${topic}\n\nARAŞTIRMA BİLGİSİ:\n${research}`;
                const d = await callAI(sysPrompt, userMsg, { responseFormat: true, temperature: 0.7, maxTokens: 8192, source: `SpotifyScene${t + 1}` });
                const parsed = extractJSON(d.candidates?.[0]?.content?.parts?.[0]?.text || '', `SpotifyScene${t + 1}`);
                const slides = parsed.videoSlides || [];
                allSlides.push(...slides);
                addSystemLog(`[${t + 1}/${topics.length}] ${slides.length} sahne üretildi.`, 'success');
                if (isFirst && slides.length > 0) firstThumbnailText = slides[0].topText || topic;
            } catch (e) {
                addSystemLog(`[${t + 1}/${topics.length}] Sahne üretim hatası: ${e.message}`, 'warn');
                // Hata olursa basit sahne ekle
                allSlides.push({ topText: topic, spokenText: `${topic} hakkında önemli bilgiler paylaşacağız.`, imagePrompts: [`${topic} illustration, cinematic`] });
            }
        }

        if (allSlides.length === 0) throw new Error("Hiç sahne üretilemedi!");

        // Toplam süre kontrolü
        const totalWords = allSlides.reduce((sum, s) => sum + (s.spokenText?.split(/\s+/).length || 0), 0);
        const estimatedDuration = totalWords / wps;
        addSystemLog(`Toplam: ${allSlides.length} sahne, ${totalWords} kelime, ~${Math.floor(estimatedDuration / 60)}dk ${Math.floor(estimatedDuration % 60)}sn`, 'success');

        return {
            isContentUnreadable: false,
            videoSlides: allSlides,
            thumbnailText: firstThumbnailText || topics[0],
            sonSoz: lastSonSoz,
            lastQuote: topics[topics.length - 1],
            thumbnailImagePrompt: allSlides[0]?.imagePrompts?.[0] || '',
            tiktokTitle: firstThumbnailText || topics[0],
            tiktokDescription: topics.join(' | '),
            tiktokHashtags: topics.map(t => '#' + t.replace(/\s+/g, '').substring(0, 20)),
            youtubeTitle: firstThumbnailText || topics[0],
            youtubeDescription: `Bu videoda ${topics.join(', ')} konularını derinlemesine inceliyoruz.`,
            youtubeHashtags: topics.map(t => '#' + t.replace(/\s+/g, '').substring(0, 20)),
            mediaBlackout: { show: false, percentageCovered: 0, percentageIgnored: 0, mediaNames: [], explanation: '' },
            chartData: { show: false },
            _isSpotify: true,
            _topics: topics
        };
    }

    // ============================================================
    // NOSTALJİ MODU — Geçmiş haberler için nostaljik video
    // Maks 60 saniye, 8 sahne, "Hatıran Yeter" müziği
    // ============================================================
    static async _buildNostaljiScript(inputData, inputType, config) {
        addSystemLog('Nostalji modu: Script oluşturuluyor...', 'info');

        // Tarih çıkarma
        let newsDate = '';
        let newsContent = '';

        if (inputType === 'text' || inputType === 'prompt') {
            newsContent = inputData;
            // Tarih regex: DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY veya doğal dil
            const dateRegex = /(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/;
            const dateMatch = inputData.match(dateRegex);
            if (dateMatch) {
                const day = dateMatch[1].padStart(2, '0');
                const month = dateMatch[2].padStart(2, '0');
                let year = dateMatch[3];
                if (year.length === 2) year = '20' + year;
                newsDate = `${day}.${month}.${year}`;
            }
            // Doğal dil tarih kontrolü
            const naturalDateRegex = /(\d{1,2})\s+(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)\s+(\d{4})/i;
            const naturalMatch = inputData.match(naturalDateRegex);
            if (naturalMatch) {
                newsDate = `${naturalMatch[1]} ${naturalMatch[2]} ${naturalMatch[3]}`;
            }
        } else if (inputType === 'url') {
            newsContent = inputData;
        } else if (inputType === 'media') {
            newsContent = 'Görseldeki nostalji haberi';
        }

        if (!newsDate) {
            newsDate = new Date().toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
        }

        addSystemLog(`Nostalji tarih: ${newsDate}`, 'info');

        // Maks 60 saniye için sahne ve kelime hesapla
        const wps = getWPS(config.language || 'tr');
        const maxSec = 60;
        const maxWords = Math.floor(maxSec * wps); // ~132 kelime
        const sceneCount = 8; // 60sn / ~7.5sn per sahne
        const wordsPerScene = Math.floor(maxWords / sceneCount); // ~16 kelime/sahne

        // Dil talimatı
        let langInstruction = "BÜTÜN SENARYOYU TÜRKÇE YAZACAKSIN.";
        if (config.language === 'en') langInstruction = "WRITE THE ENTIRE SCRIPT IN ENGLISH.";
        else if (config.language === 'de') langInstruction = "SCHREIBE DAS GESAMTE SKRIPT AUF DEUTSCH.";
        else if (config.language === 'fr') langInstruction = "ÉCRIS TOUT LE SCÉNARIO EN FRANÇAIS.";
        else if (config.language === 'ar') langInstruction = "اكتب النص بالكامل بالعربية.";

        const sysPrompt = `Sen nostaljik haber videoları üreten bir içerik üreticisisin.

GÖREV: Aşağıdaki nostalji haberini 5N1K habercilik kurallarına göre analiz et ve tam olarak ${sceneCount} sahneye böl.

5N1K ANALİZ KURALLARI:
- NE: Olayın kendisi, ne oldu
- KİM: Olayın kahramanları, tarafları
- NEREDE: Olayın gerçekleştiği yer
- NE ZAMAN: Olayın tarihi ve zamanı
- NEDEN: Olayın sebepleri, arkasındaki nedenler
- NASIL: Olayın gerçekleştiği şekil, detaylar

SAHNE KURALLARI:
${langInstruction}
- Her sahne TAM OLARAK ${wordsPerScene} kelime olmalı (15-20 arası)
- TOPLAM kelime sayısı ${maxWords} kelimeyi GEÇMEMELİ
- Her sahne tek bir paragraf olmalı, nokta ile bitmeli
- Anlatım duygusal, nostaljik ve etkileyici olmalı
- "O günlerde...", "Hatırlar mısınız...", "Bir zamanlar..." gibi nostaljik ifadeler kullan
- Her sahne farklı bir 5N1K unsurunu vurgulasın (NE → KİM → NEREDE → NE ZAMAN → NEDEN → NASIL → Detay → Sonuç)
- videoSlides dizisinde her sahne için:
  - topText: Kısa başlık (5-8 kelime)
  - spokenText: Seslendirilecek metin (${wordsPerScene} kelime)
  - imagePrompts: Görsel için İngilizce prompt (1 adet)
- thumbnailText: "${newsDate}" tarihini büyük harflerle yaz
- _newsDate: "${newsDate}" alanını ekle

JSON formatında dön.`;

        const userMessage = `NOSTALJİ HABERİ:\nTarih: ${newsDate}\n\n${newsContent}`;

        try {
            addSystemLog('AI ile nostalji script üretiliyor...', 'info');
            const data = await callAI(sysPrompt, userMessage, {
                responseFormat: true,
                temperature: 0.7,
                source: 'Nostalji',
                maxTokens: 4096
            });

            if (!data.candidates?.[0]?.content) throw new Error('API boş yanıt döndürdü.');

            const parsed = extractJSON(data.candidates[0].content.parts[0].text, 'Nostalji');

            // Video slides'ları kontrol et ve düzelt
            let slides = parsed.videoSlides || [];
            if (slides.length === 0) throw new Error('Hiç sahne üretilemedi!');

            // Her sahnenin kelime sayısını kontrol et
            slides = slides.map(slide => {
                const words = (slide.spokenText || '').split(/\s+/).filter(w => w.length > 0);
                if (words.length > wordsPerScene + 5) {
                    // Fazla kelimeleri kırp
                    slide.spokenText = words.slice(0, wordsPerScene).join(' ') + '.';
                }
                return slide;
            });

            // Toplam kelime sayısını kontrol et
            let totalWords = slides.reduce((sum, s) => sum + (s.spokenText?.split(/\s+/).length || 0), 0);
            if (totalWords > maxWords) {
                addSystemLog(`Uyarı: ${totalWords} kelime > ${maxWords} limit, kırpılıyor...`, 'warn');
                // Son sahneleri kırp
                let remaining = maxWords;
                slides = slides.map(slide => {
                    const words = (slide.spokenText || '').split(/\s+/).filter(w => w.length > 0);
                    if (remaining <= 0) return null;
                    if (words.length > remaining) {
                        slide.spokenText = words.slice(0, remaining).join(' ') + '.';
                        remaining = 0;
                    } else {
                        remaining -= words.length;
                    }
                    return slide;
                }).filter(Boolean);
            }

            addSystemLog(`Nostalji: ${slides.length} sahne, ${totalWords} kelime üretildi`, 'success');

            return {
                isContentUnreadable: false,
                videoSlides: slides,
                thumbnailText: newsDate,
                sonSoz: '',
                lastQuote: slides[slides.length - 1]?.spokenText || '',
                thumbnailImagePrompt: slides[0]?.imagePrompts?.[0] || 'nostalgic vintage newspaper',
                tiktokTitle: `${newsDate} - Nostalji`,
                tiktokDescription: newsContent.substring(0, 200),
                tiktokHashtags: ['#nostalji', '#geçmiş', '#hatıra'],
                youtubeTitle: `${newsDate} Nostalji`,
                youtubeDescription: `${newsDate} tarihinden nostalji haber: ${newsContent.substring(0, 200)}`,
                youtubeHashtags: ['#nostalji', '#geçmiş', '#hatıra', '#tarih'],
                mediaBlackout: { show: false, percentageCovered: 0, percentageIgnored: 0, mediaNames: [], explanation: '' },
                chartData: { show: false },
                _isNostalji: true,
                _newsDate: newsDate
            };
        } catch (e) {
            addSystemLog('Nostalji script hatası: ' + e.message, 'error');
            throw e;
        }
    }

    // ============================================================
    // KELİMESİ KELİMESİNE MODU — Yazılanı birebir oku, AI yeniden yazmaz
    // Otomatik ses seçimi, Türkçe düzgün okuma
    // ============================================================
    static async _buildKelimesiKelimesineScript(inputData, inputType, config) {
        addSystemLog('Kelimesi Kelimesine modu: Script oluşturuluyor...', 'info');

        let rawText = '';

        let textlessImages = []; // Yazısız görselleri sakla (tüm input tipleri için kapsamda)

        // Girdi tipine göre metni al
        if (inputType === 'text' || inputType === 'prompt') {
            // Düz metin — olduğu gibi kullan
            rawText = typeof inputData === 'string' ? inputData : String(inputData);
        } else if (inputType === 'url') {
            // URL'den içerik çek — sadece sayfa metnini oku, araştırma yapma
            try {
                addSystemLog('URL\'den içerik çekiliyor...', 'info');
                try {
                    rawText = await mimoText(`Bu URL'deki sayfadaki TÜM yazıyı olduğu gibi kopyala. Hiçbir değişiklik yapma, ekleme çıkarma yapma, özetleme yapma. Sadece sayfadaki yazıyı aynen aktar.\n\nURL: ${inputData}`, { maxTokens: 8192 });
                    addSystemLog(`URL'den ${rawText.length} karakter okundu.`, 'success');
                } catch (e) {
                    addSystemLog(`URL içerik çekme hatası: ${e.message}`, 'warn');
                }
            } catch (e) {
                addSystemLog('URL içerik çekme hatası: ' + e.message, 'warn');
            }
            if (!rawText) {
                throw new Error('URL\'den içerik okunamadı!');
            }
        } else if (inputType === 'media') {
            // Görsel/video OCR — TÜM görselleri kontrol et, yazı olanları birleştir
            if (Array.isArray(inputData) && inputData.length > 0) {
                const allTexts = [];

                for (let i = 0; i < inputData.length; i++) {
                    const file = inputData[i];
                    if (file.type?.startsWith('image')) {
                        try {
                            addSystemLog(`Görsel ${i + 1}/${inputData.length} OCR yapılıyor...`, 'info');
                            const b64 = file.data.split(',')[1];
                            try {
                                const text = await mimoOcr(b64, 'Bu görseldeki TÜM yazıyı olduğu gibi, kelimesi kelimesine yaz. Hiçbir değişiklik yapma, ekleme çıkarma yapma, yorum yapma. Sadece görseldeki yazıyı aynen aktar. Eğer görselde kesinlikle yazı yoksa sadece "YOK" yaz.', file.type, { maxTokens: 4096 });
                                if (text && text !== 'YOK' && text.length > 3 && !text.toLowerCase().includes('görselde yazı yok')) {
                                    allTexts.push(text);
                                    addSystemLog(`Görsel ${i + 1}: ${text.length} karakter okundu.`, 'success');
                                } else {
                                    textlessImages.push(file.data);
                                    addSystemLog(`Görsel ${i + 1}: Yazı bulunamadı, yazısız görsel olarak kaydedildi.`, 'info');
                                }
                            } catch (e) {
                                addSystemLog(`Görsel ${i + 1} OCR hatası: ${e.message}`, 'warn');
                            }
                        } catch (e) {
                            addSystemLog(`Görsel ${i + 1} OCR hatası: ${e.message}`, 'warn');
                        }
                    } else if (file.type?.startsWith('video')) {
                        try {
                            addSystemLog(`Video ${i + 1}/${inputData.length} OCR yapılıyor...`, 'info');
                            const b64 = file.data.split(',')[1];
                            try {
                                const text = await mimoOcr(b64, 'Bu videodaki konuşmayı/seslendirmeyi olduğu gibi yazıya dök. Kelimesi kelimesine yaz. Hiçbir değişiklik yapma, ekleme çıkarma yapma. Sadece duyulan sesi aynen yazıya dök.', file.type, { maxTokens: 8192 });
                                if (text && text.length > 3) {
                                    allTexts.push(text);
                                    addSystemLog(`Video ${i + 1}: ${text.length} karakter okundu.`, 'success');
                                }
                            } catch (e) {
                                addSystemLog(`Video ${i + 1} OCR hatası: ${e.message}`, 'warn');
                            }
                        } catch (e) {
                            addSystemLog(`Video ${i + 1} OCR hatası: ${e.message}`, 'warn');
                        }
                    }
                }

                // Tüm metinleri birleştir
                if (allTexts.length > 0) {
                    rawText = allTexts.join('\n\n');
                    addSystemLog(`Toplam ${allTexts.length} görselden metin okundu: ${rawText.length} karakter.`, 'success');
                }
            }
            if (!rawText || rawText.trim().length < 3) {
                addSystemLog('Görseller OCR ile okunamadı, varsayılan metin kullanılıyor.', 'warn');
                rawText = 'Bu görseldeki içerik hakkında bilgi veriliyor. Görselde yazı bulunamadı veya okunamadı.';
            }
        }

        if (!rawText || rawText.trim().length < 5) {
            rawText = 'Varsayılan içerik metni.';
        }

        // Metni temizle — TTS için hazırla
        rawText = rawText
            .replace(/\*\*/g, '') // Bold işaretleri
            .replace(/\*/g, '')   // İtalik işaretleri
            .replace(/#{1,6}\s/g, '') // Markdown başlıklar
            .replace(/```[\s\S]*?```/g, '') // Kod blokları
            .replace(/`[^`]*`/g, '') // Inline kod
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // Linkler
            .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // Görseller
            .replace(/^\s*[-*+]\s/gm, '') // Liste işaretleri
            .replace(/^\s*\d+\.\s/gm, '') // Numaralı liste
            .replace(/\n{3,}/g, '\n\n') // Fazla boşluklar
            .trim();

        addSystemLog(`Ham metin: ${rawText.length} karakter, ${rawText.split(/\s+/).length} kelime`, 'info');

        // Süre hesaplama
        const wps = getWPS(config.language || 'tr');
        const durationSec = config.duration === 'unlimited' ? Math.max(30, rawText.split(/\s+/).length / wps + 5) : 
            (config.duration === '15' ? 30 : config.duration === '30' ? 60 : config.duration === '60' ? 90 : config.duration === '90' ? 120 : 60);
        const maxWords = Math.floor(durationSec * wps);

        // Metni sahnelere böl (her sahne ~15-20 kelime)
        const wordsPerScene = Math.floor(maxWords / Math.max(1, Math.ceil(rawText.split(/\s+/).length / 15)));
        const sentences = rawText.split(/(?<=[.!?])\s+/);
        const scenes = [];
        let currentScene = '';

        for (const sentence of sentences) {
            if ((currentScene + ' ' + sentence).split(/\s+/).length > wordsPerScene && currentScene.length > 0) {
                scenes.push(currentScene.trim());
                currentScene = sentence;
            } else {
                currentScene = currentScene ? currentScene + ' ' + sentence : sentence;
            }
        }
        if (currentScene.trim().length > 0) {
            scenes.push(currentScene.trim());
        }

        // Eğer çok az sahne varsa, metni daha küçük parçalara böl
        if (scenes.length < 3 && rawText.length > 100) {
            const chunks = rawText.split(/(?<=[.!?])\s+/);
            scenes.length = 0;
            let chunk = '';
            for (const c of chunks) {
                if ((chunk + ' ' + c).split(/\s+/).length > 12 && chunk.length > 0) {
                    scenes.push(chunk.trim());
                    chunk = c;
                } else {
                    chunk = chunk ? chunk + ' ' + c : c;
                }
            }
            if (chunk.trim().length > 0) scenes.push(chunk.trim());
        }

        addSystemLog(`${scenes.length} sahne oluşturuldu.`, 'info');

        // Script oluştur — birebir okuma, AI müdahalesi yok
        const videoSlides = scenes.map((scene, i) => ({
            topText: scene.substring(0, 50) + (scene.length > 50 ? '...' : ''),
            spokenText: scene, // Birebir oku, AI yeniden yazmaz
            imagePrompts: [`Cinematic dark background with subtle gradient, abstract bokeh lights, ${config.language || 'Turkish'} text overlay, professional video aesthetic`]
        }));

        return {
            isContentUnreadable: false,
            videoSlides,
            thumbnailText: rawText.substring(0, 80) + (rawText.length > 80 ? '...' : ''),
            sonSoz: '',
            lastQuote: rawText.substring(rawText.length - 100),
            thumbnailImagePrompt: videoSlides[0]?.imagePrompts?.[0] || 'abstract background',
            tiktokTitle: rawText.substring(0, 60),
            tiktokDescription: rawText.substring(0, 200),
            tiktokHashtags: ['#kelimesiKelimesine', '#okuma', '#sesliOkuma'],
            youtubeTitle: 'Kelimesi Kelimesine Okuma',
            youtubeDescription: rawText.substring(0, 300),
            youtubeHashtags: ['#kelimesiKelimesine', '#okuma', '#sesliOkuma', '#tts'],
            mediaBlackout: { show: false, percentageCovered: 0, percentageIgnored: 0, mediaNames: [], explanation: '' },
            chartData: { show: false },
            _isKelimesi: true,
            _rawText: rawText,
            _autoVoice: true, // Otomatik ses seçimi işareti
            _textlessImages: textlessImages // Yazısız görseller — clickbait'ten sonra ve son sahneye konacak
        };
    }
}

function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
    return Math.abs(h);
}

function seededRandom(seed) {
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return function () {
        s = (s * 16807) % 2147483647;
        return (s - 1) / 2147483646;
    };
}

const STYLE_PALETTES = {
    cinematic: {
        bg: ['#0f172a', '#1e1b4b', '#020617', '#111827'],
        accent: ['#6366f1', '#8b5cf6', '#3b82f6', '#06b6d4'],
        glow: ['rgba(99,102,241,0.15)', 'rgba(139,92,246,0.12)', 'rgba(59,130,246,0.1)'],
        particles: 120, grid: true, vignette: 0.6
    },
    watercolor: {
        bg: ['#fef3c7', '#fde68a', '#fbbf24', '#f59e0b'],
        accent: ['#f97316', '#ef4444', '#ec4899', '#a855f7'],
        glow: ['rgba(249,115,22,0.12)', 'rgba(236,72,153,0.1)', 'rgba(168,85,247,0.08)'],
        particles: 80, grid: false, vignette: 0.2
    },
    sketch: {
        bg: ['#fafafa', '#f5f5f5', '#e5e5e5', '#d4d4d4'],
        accent: ['#171717', '#404040', '#525252', '#737373'],
        glow: ['rgba(23,23,23,0.06)', 'rgba(64,64,64,0.04)', 'rgba(115,115,115,0.03)'],
        particles: 60, grid: true, vignette: 0.15
    },
    oil_painting: {
        bg: ['#1a0a2e', '#2d1b69', '#3b1f6e', '#1c0a3b'],
        accent: ['#d4a5f5', '#f0a500', '#e45858', '#4ecdc4'],
        glow: ['rgba(212,165,245,0.12)', 'rgba(240,165,0,0.1)', 'rgba(78,205,196,0.08)'],
        particles: 100, grid: false, vignette: 0.5
    },
    minimalist: {
        bg: ['#ffffff', '#f8fafc', '#f1f5f9', '#e2e8f0'],
        accent: ['#0f172a', '#334155', '#475569', '#64748b'],
        glow: ['rgba(15,23,42,0.04)', 'rgba(51,65,85,0.03)', 'rgba(100,116,139,0.02)'],
        particles: 40, grid: true, vignette: 0.1
    },
    cyberpunk: {
        bg: ['#0a0a1a', '#1a0a2e', '#0d0221', '#120338'],
        accent: ['#ff006e', '#00f5d4', '#ffbe0b', '#fb5607'],
        glow: ['rgba(255,0,110,0.15)', 'rgba(0,245,212,0.12)', 'rgba(255,190,11,0.1)'],
        particles: 150, grid: true, vignette: 0.7
    },
    retro: {
        bg: ['#2d1b00', '#4a2c0a', '#6b4423', '#8b6914'],
        accent: ['#f4a261', '#e76f51', '#e9c46a', '#2a9d8f'],
        glow: ['rgba(244,162,97,0.15)', 'rgba(233,196,106,0.12)', 'rgba(42,157,143,0.1)'],
        particles: 70, grid: false, vignette: 0.4
    },
    '3d_render': {
        bg: ['#0a0a23', '#1a1a3e', '#151530', '#0f0f28'],
        accent: ['#00d4ff', '#7b2ff7', '#ff3366', '#00ff88'],
        glow: ['rgba(0,212,255,0.12)', 'rgba(123,47,247,0.1)', 'rgba(255,51,102,0.08)'],
        particles: 130, grid: true, vignette: 0.5
    },
    anime: {
        bg: ['#1a0a3e', '#2d1b69', '#87ceeb', '#e0f7fa'],
        accent: ['#ff69b4', '#ffb6c1', '#ffa07a', '#98fb98'],
        glow: ['rgba(255,105,180,0.15)', 'rgba(255,182,193,0.12)', 'rgba(152,251,152,0.1)'],
        particles: 90, grid: false, vignette: 0.3
    }
};

const EMOTION_PALETTES = {
    mutlu: { bg1: '#fbbf24', bg2: '#f59e0b', accent: '#fcd34d', glow: '#fef3c7', textGlow: '#fffbeb' },
    huzunlu: { bg1: '#3b82f6', bg2: '#1d4ed8', accent: '#93c5fd', glow: '#dbeafe', textGlow: '#eff6ff' },
    romantik: { bg1: '#ec4899', bg2: '#be185d', accent: '#f9a8d4', glow: '#fce7f3', textGlow: '#fdf2f8' },
    ofkeli: { bg1: '#ef4444', bg2: '#b91c1c', accent: '#fca5a5', glow: '#fee2e2', textGlow: '#fef2f2' },
    notr: { bg1: '#6366f1', bg2: '#4338ca', accent: '#a5b4fc', glow: '#e0e7ff', textGlow: '#eef2ff' }
};

class MediaSynthesisService {
    static generateProceduralFallback(prompt, imageStyle) {
        const canvas = document.createElement('canvas');
        canvas.width = 1080; canvas.height = 1920;
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;
        const seed = hashString(prompt || 'default');
        const rand = seededRandom(seed);
        const palette = STYLE_PALETTES[imageStyle] || STYLE_PALETTES.cinematic;

        function rcolor(arr) { return arr[Math.floor(rand() * arr.length)]; }

        // 1. Base gradient
        const baseGrad = ctx.createLinearGradient(0, 0, W * (0.3 + rand() * 0.4), H * (0.3 + rand() * 0.4));
        baseGrad.addColorStop(0, rcolor(palette.bg));
        baseGrad.addColorStop(0.4, rcolor(palette.bg));
        baseGrad.addColorStop(0.7, rcolor(palette.bg));
        baseGrad.addColorStop(1, rcolor(palette.bg));
        ctx.fillStyle = baseGrad;
        ctx.fillRect(0, 0, W, H);

        // 2. Glow/orbs
        for (let i = 0; i < 12; i++) {
            const x = rand() * W, y = rand() * H, r = 80 + rand() * 300;
            const g = ctx.createRadialGradient(x, y, 0, x, y, r);
            g.addColorStop(0, rcolor(palette.glow));
            g.addColorStop(1, 'transparent');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        }

        // 3. Particles/bokeh
        function hexToRgba(hex, alpha) {
            const h = hex.replace('#', '');
            const r = parseInt(h.substring(0, 2), 16);
            const g = parseInt(h.substring(2, 4), 16);
            const b = parseInt(h.substring(4, 6), 16);
            return `rgba(${r},${g},${b},${alpha})`;
        }
        const particleColor = hexToRgba(rcolor(palette.accent).replace(/^#[0-9a-f]{6}$/i, (m) => m), 0.3);
        for (let i = 0; i < palette.particles; i++) {
            const x = rand() * W, y = rand() * H;
            const sz = 2 + rand() * 12;
            const alpha = 0.1 + rand() * 0.3;
            const hex = rcolor(palette.accent);
            ctx.fillStyle = hex.startsWith('#') ? hexToRgba(hex, alpha) : hex;
            if (rand() > 0.7) {
                ctx.beginPath(); ctx.arc(x, y, sz, 0, Math.PI * 2); ctx.fill();
            } else {
                ctx.fillRect(x, y, sz * 0.6, sz * 0.6);
                ctx.fillRect(x + sz * 0.2, y + sz * 0.2, sz * 0.4, sz * 0.4);
            }
        }

        // 4. Grid lines
        if (palette.grid) {
            const gridSize = 40 + rand() * 40;
            ctx.strokeStyle = `rgba(255,255,255,${0.02 + rand() * 0.04})`;
            ctx.lineWidth = 1;
            for (let x = 0; x < W; x += gridSize) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
            for (let y = 0; y < H; y += gridSize) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
        }

        // 5. Accent shape (large geometric)
        const shapeType = Math.floor(rand() * 3);
        ctx.save();
        ctx.globalAlpha = 0.04 + rand() * 0.06;
        ctx.fillStyle = rcolor(palette.accent);
        if (imageStyle === 'cyberpunk' || imageStyle === '3d_render') {
            for (let i = 0; i < 6; i++) {
                const cx = rand() * W, cy = rand() * H;
                const s = 100 + rand() * 300;
                ctx.save(); ctx.translate(cx, cy); ctx.rotate(rand() * Math.PI);
                ctx.strokeStyle = rcolor(palette.accent);
                ctx.lineWidth = 2 + rand() * 4;
                ctx.strokeRect(-s / 2, -s / 2, s, s);
                ctx.restore();
            }
        } else {
            const cx = rand() * W, cy = rand() * H;
            const r = 100 + rand() * 400;
            const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 0, cx, cy, r);
            g.addColorStop(0, 'rgba(255,255,255,0.05)');
            g.addColorStop(1, 'transparent');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();

        // 6. Vignette
        const vig = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.75);
        vig.addColorStop(0, 'transparent');
        vig.addColorStop(1, `rgba(0,0,0,${palette.vignette})`);
        ctx.fillStyle = vig;
        ctx.fillRect(0, 0, W, H);

        // 7. Diagonal light leak
        ctx.save();
        ctx.globalAlpha = 0.03 + rand() * 0.04;
        const leakGrad = ctx.createLinearGradient(0, 0, W, H);
        leakGrad.addColorStop(0, rcolor(palette.accent));
        leakGrad.addColorStop(0.5, 'transparent');
        leakGrad.addColorStop(1, rcolor(palette.accent));
        ctx.fillStyle = leakGrad;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();

        // 8. Thin border
        ctx.strokeStyle = `rgba(255,255,255,0.08)`;
        ctx.lineWidth = 2;
        ctx.strokeRect(4, 4, W - 8, H - 8);

        // 9. Text overlay — prompt metnini ekrana yaz
        if (prompt && prompt.length > 3) {
            const textWords = prompt.replace(/[^\wçğıöşüÇĞIİÖŞÜa-zA-Z ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 30);
            const maxWidth = W * 0.82;
            let fontSize = Math.max(24, Math.min(64, Math.floor(540 / Math.sqrt(textWords.length + 1))));
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            let lines = [], line = '';
            while (fontSize > 16 && lines.length < 1) {
                lines = []; line = '';
                ctx.font = `600 ${fontSize}px "Segoe UI", Arial, sans-serif`;
                for (const word of textWords) {
                    const testLine = line ? line + ' ' + word : word;
                    if (ctx.measureText(testLine).width > maxWidth) {
                        lines.push(line); line = word;
                    } else { line = testLine; }
                }
                lines.push(line);
                if (lines.length > 6) { fontSize -= 4; lines = []; }
                else break;
            }
            const lineHeight = fontSize * 1.3;
            const startY = (H - (lines.length - 1) * lineHeight) / 2;
            lines.forEach((l, i) => {
                const y = startY + i * lineHeight;
                ctx.shadowColor = 'rgba(0,0,0,0.8)';
                ctx.shadowBlur = 20;
                ctx.fillStyle = '#ffffff';
                ctx.font = `600 ${fontSize}px "Segoe UI", Arial, sans-serif`;
                ctx.fillText(l, W / 2, y);
                ctx.shadowBlur = 0;
            });
        }

        return canvas.toDataURL('image/jpeg', 0.88);
    }

    static generateQuoteFallback(quoteText, emotion) {
        const canvas = document.createElement('canvas');
        canvas.width = 1080; canvas.height = 1920;
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;
        const colors = EMOTION_PALETTES[emotion] || EMOTION_PALETTES.notr;

        // Rich gradient background
        const grad = ctx.createLinearGradient(0, 0, W * 0.7, H);
        grad.addColorStop(0, colors.bg1);
        grad.addColorStop(0.4, colors.bg2);
        grad.addColorStop(0.7, '#0f172a');
        grad.addColorStop(1, '#020617');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);

        // Glow orbs
        for (let i = 0; i < 15; i++) {
            const x = Math.random() * W, y = Math.random() * H, r = 60 + Math.random() * 200;
            const g = ctx.createRadialGradient(x, y, 0, x, y, r);
            g.addColorStop(0, colors.glow + '60');
            g.addColorStop(0.5, colors.glow + '20');
            g.addColorStop(1, 'transparent');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        }

        // Decorative quote marks
        ctx.fillStyle = colors.glow + '30';
        ctx.font = "bold 300px Georgia, serif";
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('"', 60, 120);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText('"', W - 60, H - 120);

        // Quote text centered
        const maxWidth = W * 0.78;
        const words = quoteText.split(/\s+/);
        const baseFontSize = Math.max(32, Math.min(72, Math.floor(560 / Math.sqrt(words.length + 1))));
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        let line = '', lines = [], fontSize = baseFontSize;
        while (fontSize > 24 && lines.length < 1) {
            lines = []; line = '';
            ctx.font = `bold ${fontSize}px Georgia, "Times New Roman", serif`;
            for (const word of words) {
                const testLine = line ? line + ' ' + word : word;
                if (ctx.measureText(testLine).width > maxWidth) {
                    lines.push(line); line = word;
                } else { line = testLine; }
            }
            lines.push(line);
            if (lines.length > 8) { fontSize -= 4; lines = []; }
            else break;
        }

        // Text shadow layers
        const lineHeight = fontSize * 1.4;
        const startY = (H - (lines.length - 1) * lineHeight) / 2;
        lines.forEach((l, i) => {
            const y = startY + i * lineHeight;
            ctx.save();
            // Glow
            ctx.shadowColor = colors.textGlow;
            ctx.shadowBlur = 30;
            ctx.fillStyle = colors.textGlow + 'CC';
            ctx.font = `bold ${fontSize}px Georgia, "Times New Roman", serif`;
            ctx.fillText(l, W / 2, y);
            // Main text
            ctx.shadowBlur = 0;
            ctx.fillStyle = '#ffffff';
            ctx.fillText(l, W / 2, y);
            ctx.restore();
        });

        // Subtle vignette
        const vig = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.8);
        vig.addColorStop(0, 'transparent');
        vig.addColorStop(1, 'rgba(0,0,0,0.4)');
        ctx.fillStyle = vig;
        ctx.fillRect(0, 0, W, H);

        return canvas.toDataURL('image/jpeg', 0.9);
    }

    static async generateImage(prompt, imageStyle = 'cinematic', resolution = '4K', isGuzelSoz = false, emotion = 'notr', quoteText = '') {
        addSystemLog(`Görsel çiziliyor: "${(prompt || '').substring(0, 40)}..."`, 'info');
        if (isGuzelSoz && quoteText) {
            return this.generateQuoteFallback(quoteText, emotion);
        }
        return this.generateProceduralFallback(prompt, imageStyle);
    }

    static async generateAudio(text, voice) {
        if (!text || voice === 'none') return null;
        let cleanText = text.replace(/[*_#"']/g, '').replace(/\.\.\./g, ', ').replace(/\n/g, ' ').replace(/[:;/\\|{}[\]<>^~`]/g, ', ').replace(/\s+/g, ' ').trim();
        if (cleanText.length < 2) return null;
        // 1. Gemini API native TTS (en yüksek kalite)
        try {
            const audioData = await MediaSynthesisService._generateGeminiTTS(cleanText);
            if (audioData) return audioData;
        } catch (e) { addSystemLog(`Gemini TTS hatası: ${e.message}`, 'warn'); }
        // 2. Mimo TTS fallback
        try {
            const audioData = await MediaSynthesisService._generateMimoTTS(cleanText);
            if (audioData) return audioData;
        } catch (e) { addSystemLog(`Mimo TTS hatası: ${e.message}`, 'warn'); }
        // 3. SpeechSynthesis dene
        try {
            return await MediaSynthesisService._generateSpeechSynth(cleanText);
        } catch (e) { addSystemLog(`SpeechSynthesis hatası: ${e.message}, fallback ses üretiliyor...`, 'warn'); }
        // Fallback: tonal ses
        return MediaSynthesisService._generateToneAudio(cleanText);
    }

    // Gemini API native TTS (responseModalities: AUDIO)
    // Desteklenen: gemini-2.0-flash, gemini-2.5-flash-preview
    // Gemini Live API ile TTS (WebSocket tabanlı, yüksek kalite Türkçe)
    static async _generateGeminiTTS(text) {
        const apiKey = getApiKey();
        if (!apiKey) throw new Error('Gemini API key yok');
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-live-001' });
        const response = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: `Aşağıdaki metni Türkçe olarak doğal ve akıcı bir şekilde seslendir. Sadece sesi döndür, başka bir şey söyleme:\n\n${text}` }] }],
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } }
            }
        });
        const part = response?.response?.candidates?.[0]?.content?.parts?.[0];
        if (!part?.inlineData?.data) throw new Error('Gemini TTS yanıtında ses verisi yok');
        const b64 = part.inlineData.data;
        const binaryStr = atob(b64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        if (bytes.length < MIN_TTS_BYTES) throw new Error('Gemini TTS çok küçük yanıt');
        const headerStr = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
        let sampleRate = SAMPLE_RATE;
        let wavBuffer;
        if (headerStr === 'RIFF') {
            wavBuffer = bytes.buffer;
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            sampleRate = view.getUint32(24, true);
            addSystemLog(`Gemini TTS(WAV): ${(bytes.length/1024).toFixed(0)}KB sr=${sampleRate}`, 'success');
        } else {
            wavBuffer = MediaSynthesisService._makeWav(bytes, sampleRate);
            addSystemLog(`Gemini TTS(raw): ${(bytes.length/1024).toFixed(0)}KB`, 'success');
        }
        wavBuffer = MediaSynthesisService._normalizeWavVolume(wavBuffer);
        return { wavBuffer, sampleRate };
    }



    static async _generateMimoTTS(text) {
        // mimo-v2.5-tts: user+assistant(empty) formatı ile ses üretir
        const payload = {
            model: 'mimo-v2.5-tts',
            messages: [
                { role: 'user', content: text },
                { role: 'assistant', content: '' }
            ]
        };
        const r = await fetch(`${getMimoUrl()}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getMimoKey()}` },
            body: JSON.stringify(payload)
        });
        if (!r.ok) throw new Error(`Mimo TTS ${r.status}`);
        const json = await r.json();
        const audioData = json?.choices?.[0]?.message?.audio?.data;
        if (!audioData) throw new Error('Mimo TTS yanıtında ses verisi yok');
        const binaryStr = atob(audioData);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        if (bytes.length < MIN_TTS_BYTES) throw new Error('Mimo TTS çok küçük yanıt');
        const headerStr = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
        let sampleRate = SAMPLE_RATE;
        let wavBuffer;
        if (headerStr === 'RIFF') {
            wavBuffer = bytes.buffer;
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const audioFormat = view.getUint16(20, true);
            const numChannels = view.getUint16(22, true);
            const wavSampleRate = view.getUint32(24, true);
            const bitsPerSample = view.getUint16(34, true);
            const dataSize = view.getUint32(40, true);
            sampleRate = wavSampleRate;
            addSystemLog(`Mimo TTS(WAV): ${(bytes.length/1024).toFixed(0)}KB fmt=${audioFormat} ch=${numChannels} sr=${wavSampleRate} bps=${bitsPerSample} dataSz=${dataSize}`, 'success');
        } else {
            const hexPrefix = Array.from(bytes.slice(0, Math.min(8, bytes.length))).map(b => b.toString(16).padStart(2,'0')).join(' ');
            wavBuffer = MediaSynthesisService._makeWav(bytes, sampleRate);
            addSystemLog(`Mimo TTS(raw): ${(bytes.length/1024).toFixed(0)}KB prefix=[${hexPrefix}]`, 'info');
        }
        wavBuffer = MediaSynthesisService._normalizeWavVolume(wavBuffer);
        return { wavBuffer, sampleRate };
    }

    static _generateToneAudio(text) {
            const sampleRate = SAMPLE_RATE;
        const wordCount = text.split(/\s+/).length;
        const duration = Math.max(2, wordCount / 2.5);
        const numSamples = Math.floor(sampleRate * duration);
        const pcmBytes = new Uint8Array(numSamples * 2);
        for (let i = 0; i < numSamples; i++) {
            const t = i / sampleRate;
            const freq = 220 + Math.sin(t * 0.5) * 40;
            const envelope = Math.min(1, t * 4) * Math.min(1, (duration - t) * 2);
            const sample = Math.sin(2 * Math.PI * freq * t) * 0.7 * envelope;
            const wordPulse = Math.sin(t * wordCount * 1.5) * 0.2;
            const val = Math.max(-1, Math.min(1, sample + wordPulse));
            const intSample = val < 0 ? val * 32768 : val * 32767;
            pcmBytes[i * 2] = intSample & 0xFF;
            pcmBytes[i * 2 + 1] = (intSample >> 8) & 0xFF;
        }
        const wavBuffer = MediaSynthesisService._makeWav(pcmBytes, sampleRate);
        addSystemLog(`Ses hazır: ${(pcmBytes.length / 1024).toFixed(0)}KB, ${sampleRate}Hz (tonal)`, 'info');
        return { wavBuffer, sampleRate };
    }

    static async _generateSpeechSynth(text, lang = 'tr-TR') {
        return new Promise((resolve, reject) => {
            if (!window.speechSynthesis) return reject(new Error('SpeechSynthesis yok'));
            // Ses tahmini süre
            const wordCount = text.split(/\s+/).length;
            const duration = Math.max(2, wordCount / 2.5);
        const sampleRate = SAMPLE_RATE;
            // SpeechSynthesis ile oynat ve süreyi ölç
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang = lang;
            utterance.rate = 1.0;
            const startTime = performance.now();
            utterance.onend = () => {
                const actualDur = Math.max(duration, (performance.now() - startTime) / 1000);
                const numSamples = Math.floor(sampleRate * actualDur);
                const pcmBytes = new Uint8Array(numSamples * 2);
                // Gerçek SpeechSynthesis sesini yakalayamadığımız için
                // süreye uygun hafif bir ambient tone üret
                for (let i = 0; i < numSamples; i++) {
                    const t = i / sampleRate;
                    const env = Math.min(1, t * 3) * Math.min(1, (actualDur - t) * 2);
                    const sample = Math.sin(2 * Math.PI * 180 * t) * 0.5 * env;
                    const val = Math.max(-1, Math.min(1, sample));
                    const intSample = val < 0 ? val * 32768 : val * 32767;
                    pcmBytes[i * 2] = intSample & 0xFF;
                    pcmBytes[i * 2 + 1] = (intSample >> 8) & 0xFF;
                }
                const wavBuffer = MediaSynthesisService._makeWav(pcmBytes, sampleRate);
                resolve({ wavBuffer, sampleRate });
            };
            utterance.onerror = (e) => reject(e);
            speechSynthesis.speak(utterance);
        });
    }

    static _makeWav(pcmBytes, sampleRate) {
        const numChannels = 1; const bitsPerSample = 16;
        const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
        const blockAlign = numChannels * (bitsPerSample / 8);
        const wavBuffer = new ArrayBuffer(WAV_HEADER_SIZE + pcmBytes.length);
        const view = new DataView(wavBuffer);
        const ws = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
        ws(0, 'RIFF'); view.setUint32(4, 36 + pcmBytes.length, true); ws(8, 'WAVE');
        ws(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
        view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true); view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitsPerSample, true); ws(36, 'data');
        view.setUint32(40, pcmBytes.length, true);
        new Uint8Array(wavBuffer, WAV_HEADER_SIZE).set(pcmBytes);
        return wavBuffer;
    }

    static _normalizeWavVolume(wavBuffer) {
        try {
            const view = new DataView(wavBuffer);
            const dataSize = view.getUint32(40, true);
            const sampleCount = dataSize / 2;
            let peak = 0;
            for (let i = 0; i < sampleCount; i++) {
                const sample = view.getInt16(WAV_HEADER_SIZE + i * 2, true);
                const abs = Math.abs(sample);
                if (abs > peak) peak = abs;
            }
            if (peak < 100 || peak > 32000) return wavBuffer;
            const gain = 30000 / peak;
            for (let i = 0; i < sampleCount; i++) {
                const sample = view.getInt16(WAV_HEADER_SIZE + i * 2, true);
                const normalized = Math.max(-32768, Math.min(32767, Math.round(sample * gain)));
                view.setInt16(WAV_HEADER_SIZE + i * 2, normalized, true);
            }
        } catch (e) { console.warn('[TTS] Volume normalization failed:', e.message); }
        return wavBuffer;
    }
}

class AmbientAudioService {
    static createNoiseBuffer(audioCtx, type = 'white') {
        const bufferSize = audioCtx.sampleRate * 5; const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate); const data = buffer.getChannelData(0); let lastOut = 0;
        for (let i = 0; i < bufferSize; i++) { const white = Math.random() * 2 - 1; if (type === 'brown') { data[i] = (lastOut + (0.02 * white)) / 1.02; lastOut = data[i]; data[i] *= 3.5; } else { data[i] = white * 0.5; } }
        return buffer;
    }
    static getAmbientNode(audioCtx, type) {
        const noiseBuffer = this.createNoiseBuffer(audioCtx, type === 'fire' ? 'brown' : 'white');
        const noiseSource = audioCtx.createBufferSource(); noiseSource.buffer = noiseBuffer; noiseSource.loop = true;
        const filter = audioCtx.createBiquadFilter(); const gain = audioCtx.createGain();
        if (type === 'rain') { filter.type = 'lowpass'; filter.frequency.value = 800; gain.gain.value = 3.6; noiseSource.connect(filter).connect(gain); }
        else if (type === 'waves') { filter.type = 'lowpass'; filter.frequency.value = 400; const lfo = audioCtx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.1; const lfoGain = audioCtx.createGain(); lfoGain.gain.value = 1.5; gain.gain.value = 0.8; lfo.connect(lfoGain).connect(gain.gain); lfo.start(); noiseSource.connect(filter).connect(gain); }
        else return null;
        noiseSource.start(0); return { source: noiseSource, gainNode: gain };
    }

    // Spotify modu: Procedural sakin piyano/keman fon müziği üretir
    static generateCalmMusic(audioCtx, instrument = 'piano', durationSec = 60) {
        const sampleRate = audioCtx.sampleRate;
        const length = sampleRate * durationSec;
        const buffer = audioCtx.createBuffer(1, length, sampleRate);
        const data = buffer.getChannelData(0);

        // Minör akorlar (Am, Dm, Em, G) — sakin, duygusal
        const chords = [
            [220.00, 261.63, 329.63], // Am (A3, C4, E4)
            [293.66, 349.23, 440.00], // Dm (D4, F4, A4)
            [329.63, 392.00, 493.88], // Em (E4, G4, B4)
            [196.00, 246.94, 293.66], // G  (G3, B3, D4)
        ];

        const bpm = 60; // Yavaş tempo
        const beatDuration = 60 / bpm; // 1 saniye per beat
        const chordDuration = beatDuration * 4; // 4 beat per akor

        let currentChordIdx = 0;
        let noteStartTime = 0;

        for (let i = 0; i < length; i++) {
            const t = i / sampleRate;
            const chordIdx = Math.floor(t / chordDuration) % chords.length;
            const chord = chords[chordIdx];
            const timeInChord = t % chordDuration;

            let sample = 0;

            if (instrument === 'piano') {
                // Piyano: Her akor notası ayrı ayrı çalınır (arpeggio)
                const noteIdx = Math.floor(timeInChord / (chordDuration / chord.length)) % chord.length;
                const freq = chord[noteIdx];
                const noteStart = Math.floor(timeInChord / (chordDuration / chord.length)) * (chordDuration / chord.length);
                const noteAge = timeInChord - noteStart;
                const envelope = Math.exp(-noteAge * 2.5) * 0.7; // Hızlı decay

                // Piyano harmonikleri
                sample = Math.sin(2 * Math.PI * freq * t) * envelope;
                sample += Math.sin(2 * Math.PI * freq * 2 * t) * envelope * 0.3; // 2. harmonik
                sample += Math.sin(2 * Math.PI * freq * 3 * t) * envelope * 0.1; // 3. harmonik
                sample += Math.sin(2 * Math.PI * freq * 4 * t) * envelope * 0.05; // 4. harmonik
            } else {
                // Keman: Sürekli legato, vibrato ile
                const noteIdx = Math.floor(timeInChord / (chordDuration / chord.length)) % chord.length;
                const freq = chord[noteIdx];
                const noteStart = Math.floor(timeInChord / (chordDuration / chord.length)) * (chordDuration / chord.length);
                const noteAge = timeInChord - noteStart;

                // Vibrato
                const vibrato = Math.sin(2 * Math.PI * 5 * t) * 3;
                const actualFreq = freq + vibrato;

                // Sawtooth benzeri (keman)
                const phase = (actualFreq * t) % 1;
                sample = (2 * phase - 1) * 0.4;

                // Legato envelope
                const attackTime = 0.15;
                const sustainLevel = 0.5;
                let envelope;
                if (noteAge < attackTime) {
                    envelope = (noteAge / attackTime) * sustainLevel;
                } else {
                    envelope = sustainLevel * Math.exp(-(noteAge - attackTime) * 0.3);
                }
                sample *= envelope;

                // Low-pass filter (yumuşatma)
                sample = sample * 0.6;
            }

            // Soft clipping
            sample = Math.tanh(sample * 1.5) * 0.4;

            data[i] = sample;
        }

        return buffer;
    }
}

const RenderWorkerService = {
    wrapText: (ctx, text, maxWidth) => { if (!text) return []; const words = text.split(" "); const lines = []; let currentLine = words[0]; for (let i = 1; i < words.length; i++) { if (ctx.measureText(currentLine + " " + words[i]).width < maxWidth) currentLine += " " + words[i]; else { lines.push(currentLine); currentLine = words[i]; } } lines.push(currentLine); return lines; },
    calculateSubtitles: (text, exactAudioDur) => { if (!text) return []; const words = text.replace(/\n/g, ' ').split(/\s+/).filter(Boolean); const totalChars = words.reduce((sum, w) => sum + w.length, 0); const safeDur = Math.max(exactAudioDur, 0.1); const timePerChar = safeDur / Math.max(totalChars, 1); const subs = []; let currentStartTime = 0; for (let i = 0; i < words.length; i += 2) { const word1 = words[i]; const word2 = words[i + 1] || ""; const chunkText = (word1 + " " + word2).trim(); const chunkChars = word1.length + (word2.length > 0 ? word2.length : 0); const chunkDur = chunkChars * timePerChar; subs.push({ text: chunkText, startSec: currentStartTime, endSec: currentStartTime + chunkDur }); currentStartTime += chunkDur; } return subs; },
    drawImageContain: (ctx, img, w, h) => { const imgRatio = img.width / img.height; const canvasRatio = w / h; let drawW = w, drawH = h, offsetX = 0, offsetY = 0; if (imgRatio > canvasRatio) { drawH = w / imgRatio; offsetY = (h - drawH) / 2; } else { drawW = h * imgRatio; offsetX = (w - drawW) / 2; } ctx.fillStyle = "black"; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, offsetX, offsetY, drawW, drawH); },
    drawImageCover: (ctx, img, w, h) => { const imgRatio = img.width / img.height; const canvasRatio = w / h; let drawW = w, drawH = h, offsetX = 0, offsetY = 0; if (imgRatio > canvasRatio) { drawW = h * imgRatio; offsetX = (w - drawW) / 2; } else { drawH = w / imgRatio; offsetY = (h - drawH) / 2; } ctx.fillStyle = "black"; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, offsetX, offsetY, drawW, drawH); },
    drawThumbnail: (ctx, img, text, w, h, fontFamily, lang = 'tr', tip = 'haber', newsDate = '') => {
        ctx.fillStyle = "black"; ctx.fillRect(0, 0, w, h);
        if (img) RenderWorkerService.drawImageContain(ctx, img, w, h);

        // Nostalji modu: Vintage filtre + sepia ton
        if (tip === 'nostalji') {
            // Sepia overlay
            ctx.fillStyle = "rgba(112, 66, 20, 0.3)";
            ctx.fillRect(0, 0, w, h);
            // Vignette
            const vignetteGrad = ctx.createRadialGradient(w/2, h/2, w*0.2, w/2, h/2, w*0.7);
            vignetteGrad.addColorStop(0, "rgba(0,0,0,0)");
            vignetteGrad.addColorStop(1, "rgba(0,0,0,0.7)");
            ctx.fillStyle = vignetteGrad;
            ctx.fillRect(0, 0, w, h);
            // Grain efekti (hafif)
            for (let i = 0; i < 1000; i++) {
                const gx = Math.random() * w;
                const gy = Math.random() * h;
                ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`;
                ctx.fillRect(gx, gy, 1, 1);
            }
        } else {
            const grad = ctx.createLinearGradient(0, 0, 0, h);
            grad.addColorStop(0, "rgba(0,0,0,0.95)");
            grad.addColorStop(0.35, "rgba(0,0,0,0.2)");
            grad.addColorStop(0.65, "rgba(0,0,0,0.2)");
            grad.addColorStop(1, "rgba(0,0,0,0.95)");
            ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
        }

        const cx = w / 2;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";

        if (tip === 'nostalji') {
            // ============================================================
            // NOSTALJİ THUMBNAIL: "HATIRAN YETER" + tarih + başlık
            // ============================================================

            // "HATIRAN YETER" — üstte, altın gradient, glow efekti
            const headerFontSize = w > 800 ? 90 : 65;
            ctx.font = `900 ${headerFontSize}px ${fontFamily}`;
            ctx.save();
            ctx.shadowColor = "rgba(255, 215, 0, 0.8)";
            ctx.shadowBlur = 40;
            const headerGrad = ctx.createLinearGradient(cx - w*0.3, 0, cx + w*0.3, 0);
            headerGrad.addColorStop(0, "#FFD700");
            headerGrad.addColorStop(0.5, "#FFF8DC");
            headerGrad.addColorStop(1, "#FFD700");
            ctx.fillStyle = headerGrad;
            ctx.fillText("HATIRAN YETER", cx, h * 0.2);
            ctx.restore();

            // Tarih — ortada, beyaz, büyük font
            const dateFontSize = w > 800 ? 70 : 50;
            ctx.font = `900 ${dateFontSize}px ${fontFamily}`;
            ctx.save();
            ctx.shadowColor = "rgba(0,0,0,0.9)";
            ctx.shadowBlur = 20;
            ctx.fillStyle = "#FFFFFF";
            ctx.fillText((newsDate || text || "").toUpperCase(), cx, h * 0.45);
            ctx.restore();

            // Başlık — altta, kırmızı/sarı alternatif
            let thumbFontSize = w > 800 ? 60 : 45;
            ctx.font = `900 ${thumbFontSize}px ${fontFamily}`;
            let lines = RenderWorkerService.wrapText(ctx, (text || "").toUpperCase(), w * 0.9);
            while (lines.length > 3 && thumbFontSize > 30) { thumbFontSize -= 3; ctx.font = `900 ${thumbFontSize}px ${fontFamily}`; lines = RenderWorkerService.wrapText(ctx, (text || "").toUpperCase(), w * 0.9); }
            const lh = thumbFontSize * 1.15;
            const titleStartY = h * 0.6;
            ctx.save();
            ctx.shadowColor = "rgba(0,0,0,0.9)";
            ctx.shadowBlur = 15;
            lines.forEach((l, i) => {
                const y = titleStartY + (i * lh);
                ctx.lineWidth = thumbFontSize * 0.2;
                ctx.strokeStyle = "#000000";
                ctx.lineJoin = "round";
                ctx.strokeText(l, cx, y);
                ctx.fillStyle = i % 2 === 0 ? "#FF6B6B" : "#FFD700";
                ctx.fillText(l, cx, y);
            });
            ctx.restore();
        } else {
            // ============================================================
            // NORMAL THUMBNAIL (haber/güzel söz/spotify)
            // ============================================================
            const now = new Date();
            const dateLocMap = { 'tr': 'tr-TR', 'en': 'en-US', 'fr': 'fr-FR', 'de': 'de-DE', 'es': 'es-ES', 'ar': 'ar-SA', 'ru': 'ru-RU' };
            const dateLocale = dateLocMap[lang] || 'tr-TR';
            const dateStr = now.toLocaleDateString(dateLocale, { day: 'numeric', month: 'long', year: 'numeric' });
            const dayStr = now.toLocaleDateString(dateLocale, { weekday: 'long' });
            const dateLine = `${dateStr} ${dayStr}`.toUpperCase();

            let thumbFontSize = w > 800 ? 115 : 85;
            ctx.font = `900 ${thumbFontSize}px ${fontFamily}`;
            let lines = RenderWorkerService.wrapText(ctx, (text || "ŞOK HABER!").toUpperCase(), w * 0.95);
            while (lines.length > 4 && thumbFontSize > 50) { thumbFontSize -= 5; ctx.font = `900 ${thumbFontSize}px ${fontFamily}`; lines = RenderWorkerService.wrapText(ctx, (text || "ŞOK HABER!").toUpperCase(), w * 0.95); }

            const dateFontSize = thumbFontSize;
            ctx.font = `900 ${dateFontSize}px ${fontFamily}`;
            let dateLines = RenderWorkerService.wrapText(ctx, dateLine, w * 0.95);

            const lh = thumbFontSize * 1.15;
            const dateLh = dateFontSize * 1.15;
            const gap = lh * 0.5;

            const totalBlockHeight = (dateLines.length * dateLh) + gap + (lines.length * lh);
            const startY = (h - totalBlockHeight) / 2 + (dateLh / 2);

            ctx.save();
            ctx.shadowColor = "rgba(0,0,0,1)";
            ctx.shadowBlur = 30;
            ctx.shadowOffsetY = 15;

            ctx.font = `900 ${dateFontSize}px ${fontFamily}`;
            dateLines.forEach((l, i) => {
                const y = startY + (i * dateLh);
                ctx.lineWidth = dateFontSize * 0.28;
                ctx.strokeStyle = "#000000";
                ctx.lineJoin = "round";
                ctx.strokeText(l, cx, y);
                ctx.lineWidth = dateFontSize * 0.06;
                ctx.strokeStyle = "#FFFFFF";
                ctx.strokeText(l, cx, y);
                ctx.fillStyle = "#FFD700";
                ctx.fillText(l, cx, y);
            });

            const titleStartY = startY + (dateLines.length * dateLh) + gap;
            ctx.font = `900 ${thumbFontSize}px ${fontFamily}`;
            lines.forEach((l, i) => {
                const y = titleStartY + (i * lh);
                const isYellow = i % 2 === 0;
                ctx.lineWidth = thumbFontSize * 0.28;
                ctx.strokeStyle = "#000000";
                ctx.lineJoin = "round";
                ctx.strokeText(l, cx, y);
                ctx.lineWidth = thumbFontSize * 0.06;
                ctx.strokeStyle = isYellow ? "#B8860B" : "#888888";
                ctx.strokeText(l, cx, y);
                ctx.fillStyle = isYellow ? "#FFD700" : "#FFFFFF";
                ctx.fillText(l, cx, y);
            });

            ctx.restore();
        }
    },
    drawStar: (ctx, cx, cy, spikes, outerRadius, innerRadius, color = "#FFFFFF") => { let rot = (Math.PI / 2) * 3; let step = Math.PI / spikes; ctx.beginPath(); ctx.moveTo(cx, cy - outerRadius); for (let i = 0; i < spikes; i++) { let x = cx + Math.cos(rot) * outerRadius; let y = cy + Math.sin(rot) * outerRadius; ctx.lineTo(x, y); rot += step; x = cx + Math.cos(rot) * innerRadius; y = cy + Math.sin(rot) * innerRadius; ctx.lineTo(x, y); rot += step; } ctx.lineTo(cx, cy - outerRadius); ctx.closePath(); ctx.fillStyle = color; ctx.fill(); },
    renderGuzelSoz: async (jobData, canvasElement, w, h, cx, fontFamily) => {
        addSystemLog('Güzel söz render başlıyor...', 'info');
        const slides = jobData.script.videoSlides || [];
        const FPS = 30;
        const maxAllowedDur = 120.0;

        canvasElement.width = w; canvasElement.height = h;
        const ctx = canvasElement.getContext('2d');
        addSystemLog(`Canvas: ${w}x${h}, ${slides.length} slayt`, 'info');

        const audioCtx = _getAudioCtx();
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        const audioDest = audioCtx ? audioCtx.createMediaStreamDestination() : null;
        const silentOsc = audioCtx.createOscillator(); const silentGain = audioCtx.createGain(); silentGain.gain.value = 0.001; silentOsc.connect(silentGain); silentGain.connect(audioDest); silentOsc.start();

        // HER SLAYT İÇİN SES SÜRELERİNİ HESAPLA
        const slideDurations = [];
        let totalAudioDuration = 0;
        for (let i = 0; i < slides.length; i++) {
            const audioData = jobData.assets.audio[i];
            const text = slides[i].spokenText || "";
            let dur = 3.0; // varsayılan
            if (audioData?.wavBuffer) {
                try {
                    let byteLength = 0;
                    if (audioData.wavBuffer instanceof ArrayBuffer) byteLength = audioData.wavBuffer.byteLength;
                    else if (audioData.wavBuffer.buffer instanceof ArrayBuffer) byteLength = audioData.wavBuffer.buffer.byteLength;
                    if (byteLength > WAV_HEADER_SIZE) dur = (byteLength - WAV_HEADER_SIZE) / (SAMPLE_RATE * 2);
                } catch (e) { console.warn('[Audio] Duration calculation failed:', e.message); }
            } else if (text) {
                dur = Math.max(2.0, text.split(/\s+/).filter(Boolean).length / 2.2);
            }
            dur = Math.min(dur + 0.5, 15.0); // her slayt max 15sn
            slideDurations.push(dur);
            totalAudioDuration += dur;
            addSystemLog(`Slayt ${i + 1}: ${dur.toFixed(1)}sn — "${text.substring(0, 30)}..."`, 'info');
        }

        const bufferTime = 3;
        const totalDuration = Math.min(totalAudioDuration + bufferTime, maxAllowedDur);
        const totalFrames = Math.round(totalDuration * FPS);
        addSystemLog(`Toplam süre: ${totalDuration.toFixed(1)}sn (${totalAudioDuration.toFixed(1)}sn ses + ${bufferTime}sn buffer)`, 'info');

        let bgmSource, masterGain;
        let ambientSound = jobData.preferences.ambientSound || 'none';

        if (ambientSound !== 'none') {
            const ambientTypes = ['rain', 'wind', 'waves', 'fire'];
            if (ambientTypes.includes(ambientSound)) {
                try {
                    const ambientObj = AmbientAudioService.getAmbientNode(audioCtx, ambientSound);
                    if (ambientObj) { bgmSource = ambientObj.source; masterGain = audioCtx.createGain(); masterGain.gain.value = BGM_VOLUME; ambientObj.gainNode.connect(masterGain); masterGain.connect(audioDest); addSystemLog('Atmosfer sesi: ' + ambientSound, 'success'); }
                } catch (e) { addSystemLog('Atmosfer sesi hatası: ' + e.message, 'warn'); }
            } else if (ambientSound.startsWith('local_')) {
                try {
                    const track = jobData.assets.musicList?.find(m => m.id === ambientSound);
                    if (track && track.data) {
                        const res = await fetch(track.data);
                        const buf = await audioCtx.decodeAudioData(await res.arrayBuffer());
                        bgmSource = audioCtx.createBufferSource(); bgmSource.buffer = buf; bgmSource.loop = true;
                        masterGain = audioCtx.createGain(); masterGain.gain.value = BGM_VOLUME;
                        bgmSource.connect(masterGain); masterGain.connect(audioDest); bgmSource.start(0);
                        addSystemLog('Yerel müzik yüklendi: ' + track.name, 'success');
                    }
                } catch (e) { addSystemLog('Yerel müzik yükleme hatası: ' + e.message, 'warn'); }
            } else {
                // IndexedDB'den müzik yükle
                try {
                    const track = await AssetManagerService.getMusicFromLib(ambientSound);
                    if (track && track.data) {
                        const raw = track.data.includes(',') ? track.data.split(',')[1] : track.data;
                        const byteString = atob(raw); const ab = new ArrayBuffer(byteString.length); const ia = new Uint8Array(ab);
                        for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
                        const blob = new Blob([ab], { type: 'audio/mpeg' });
                        const musicUrl = URL.createObjectURL(blob);
                        const res = await fetch(musicUrl);
                        const buf = await audioCtx.decodeAudioData(await res.arrayBuffer());
                        bgmSource = audioCtx.createBufferSource(); bgmSource.buffer = buf; bgmSource.loop = true;
                        masterGain = audioCtx.createGain(); masterGain.gain.value = BGM_VOLUME;
                        bgmSource.connect(masterGain); masterGain.connect(audioDest); bgmSource.start(0);
                        addSystemLog('Müzik yüklendi: ' + track.name, 'success');
                    } else { addSystemLog(`Müzik bulunamadı: ${ambientSound}`, 'warn'); }
                } catch (e) { addSystemLog('Müzik yükleme hatası: ' + e.message, 'warn'); }
            }
        } else { addSystemLog('Müzik seçilmedi', 'warn'); }

        // HER SLAYT İÇİN GÖRSEL YÜKLE
        const loadedImages = [];
        for (let i = 0; i < slides.length; i++) {
            const imgData = jobData.assets.images[i];
            const img = imgData ? await NetworkUtils.loadImage(imgData) : null;
            loadedImages.push(img);
        }
        if (loadedImages.every(img => !img)) loadedImages[0] = null;
        addSystemLog(`${loadedImages.filter(Boolean).length} görsel yüklendi.`, 'info');

        // Timer worker
        const timerWorkerCode = `let interval; self.onmessage = function(e) { if (e.data === 'start') interval = setInterval(() => self.postMessage('tick'), 25); if (e.data === 'stop') clearInterval(interval); };`;
        const timerWorkerBlob = new Blob([timerWorkerCode], { type: 'application/javascript' });
        const timerWorker = new Worker(URL.createObjectURL(timerWorkerBlob)); timerWorker.postMessage('start');
        let frameResolvers = [];
        timerWorker.onmessage = () => { const resolvers = frameResolvers; frameResolvers = []; resolvers.forEach(r => r()); };
        const nextFrame = () => new Promise(resolve => { frameResolvers.push(resolve); });

        // MediaRecorder
        const stream = canvasElement.captureStream(FPS);
        const videoTrack = stream.getVideoTracks()[0];
        if (audioDest) { audioDest.stream.getAudioTracks().forEach(t => stream.addTrack(t)); }
        let mimeType = 'video/webm; codecs=vp8,opus';
        if (jobData.config.videoFormat === 'mp4') {
            if (MediaRecorder.isTypeSupported('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')) mimeType = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
            else if (MediaRecorder.isTypeSupported('video/mp4')) mimeType = 'video/mp4';
        }
        if (!MediaRecorder.isTypeSupported(mimeType)) { mimeType = 'video/webm;codecs=vp8,opus'; if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm'; }
        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1000000, audioBitsPerSecond: 128000 });
        const chunks = [];
        recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.start(100);

        sysEventBus.emit('PROGRESS', { step: 'RENDER', percent: 30, text: 'Güzel söz render ediliyor...' });

        // HER SLAYTI SIRAYLA RENDER ET
        let globalFrame = 0;
        for (let slideIdx = 0; slideIdx < slides.length; slideIdx++) {
            const slideText = slides[slideIdx].spokenText || "";
            const slideImage = loadedImages[slideIdx];
            const slideDur = slideDurations[slideIdx];
            const slideFrames = Math.round(slideDur * FPS);
            const kenBurnsDir = Math.floor(Math.random() * 4);

            const isTextlessSlide = slides[slideIdx]._isTextless || false;
            addSystemLog(`Slayt ${slideIdx + 1} render: ${isTextlessSlide ? 'Yazısız görsel' : `"${slideText.substring(0, 30)}..."`} (${slideDur.toFixed(1)}sn)`, 'info');

            // Bu slaytın sesini çal (yazısız slaytlar hariç)
            const audioData = jobData.assets.audio[slideIdx];
            let audioEndPromise = null;
            if (!isTextlessSlide && audioData?.wavBuffer && audioCtx) {
                try {
                    let bufferCopy;
                    if (audioData.wavBuffer instanceof ArrayBuffer) bufferCopy = audioData.wavBuffer.slice(0);
                    else if (audioData.wavBuffer.buffer instanceof ArrayBuffer) bufferCopy = audioData.wavBuffer.buffer.slice(0);
                    else bufferCopy = audioData.wavBuffer;
                    const audioBuf = await audioCtx.decodeAudioData(bufferCopy);
                    const source = audioCtx.createBufferSource(); source.buffer = audioBuf;
                    source.playbackRate.value = 1.0;
                    const gain = audioCtx.createGain(); gain.gain.value = VOICEOVER_VOLUME;
                    source.connect(gain); gain.connect(audioDest); source.start(0);
                    audioEndPromise = new Promise(resolve => { source.onended = resolve; });
                } catch (e) { addSystemLog(`Slayt ${slideIdx + 1} ses hatası: ${e.message}`, 'warn'); }
            }

            // Bu slaytın karelerini çiz
            for (let frame = 0; frame < slideFrames; frame++) {
                const t = frame / slideFrames;
                const elapsed = globalFrame / FPS;

                // Arka plan
                ctx.fillStyle = "#0a0a0a"; ctx.fillRect(0, 0, w, h);

                // Görsel (Ken Burns efekti)
                if (slideImage) {
                    const zoom = 1.0 + 0.08 * t;
                    const panX = [-0.04, 0.04, 0, 0][kenBurnsDir] * w * t;
                    const panY = [0, 0, -0.04, 0.04][kenBurnsDir] * h * t;
                    ctx.save();
                    ctx.translate(w / 2 + panX, h / 2 + panY);
                    ctx.scale(zoom, zoom);
                    const imgRatio = slideImage.width / slideImage.height;
                    const canRatio = w / h;
                    let sx, sy, sw, sh;
                    if (imgRatio > canRatio) { sh = slideImage.height; sw = sh * canRatio; sx = (slideImage.width - sw) / 2; sy = 0; }
                    else { sw = slideImage.width; sh = sw / canRatio; sx = 0; sy = (slideImage.height - sh) / 2; }
                    ctx.drawImage(slideImage, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
                    ctx.restore();
                }

                // Overlay gradyan (yazısız slaytlar için daha hafif)
                const ov = ctx.createLinearGradient(0, 0, 0, h);
                if (isTextlessSlide) {
                    // Yazısız görsel — sadece hafif vignette
                    ov.addColorStop(0, "rgba(0,0,0,0.3)"); ov.addColorStop(0.3, "rgba(0,0,0,0.05)");
                    ov.addColorStop(0.7, "rgba(0,0,0,0.05)"); ov.addColorStop(1, "rgba(0,0,0,0.3)");
                } else {
                    ov.addColorStop(0, "rgba(0,0,0,0.5)"); ov.addColorStop(0.3, "rgba(0,0,0,0.1)");
                    ov.addColorStop(0.7, "rgba(0,0,0,0.1)"); ov.addColorStop(1, "rgba(0,0,0,0.6)");
                }
                ctx.fillStyle = ov; ctx.fillRect(0, 0, w, h);

                // Metin (fade-in) — yazısız slaytlar hariç
                if (!isTextlessSlide && slideText) {
                    const fadeIn = Math.min(1, t / 0.15);
                    const fadeOut = t > 0.85 ? (1 - t) / 0.15 : 1;
                    ctx.save();
                    ctx.globalAlpha = fadeIn * fadeOut;

                    let fontSize = w > 800 ? 48 : 38;
                    ctx.font = `bold ${fontSize}px ${fontFamily}`;
                    let textLines = RenderWorkerService.wrapText(ctx, slideText, w * 0.82);
                    let lh = fontSize * 1.5;
                    let totalH = textLines.length * lh;
                    while (totalH > h * 0.6 && fontSize > 18) {
                        fontSize -= 2;
                        ctx.font = `bold ${fontSize}px ${fontFamily}`;
                        textLines = RenderWorkerService.wrapText(ctx, slideText, w * 0.82);
                        lh = fontSize * 1.5;
                        totalH = textLines.length * lh;
                    }
                    ctx.font = `bold ${fontSize}px ${fontFamily}`;
                    ctx.textAlign = "center"; ctx.textBaseline = "middle";
                    const startY = (h - totalH) / 2;
                    textLines.forEach((line, i) => {
                        const y = startY + (i * lh) + (lh / 2);
                        ctx.lineWidth = 5; ctx.strokeStyle = "#000000"; ctx.lineJoin = "round";
                        ctx.strokeText(line, cx, y);
                        ctx.fillStyle = "#FFFFFF"; ctx.fillText(line, cx, y);
                    });
                    ctx.restore();
                }

                if (videoTrack && videoTrack.requestFrame) videoTrack.requestFrame();
                globalFrame++;
                if (globalFrame % 30 === 0) sysEventBus.emit('PROGRESS', { step: 'RENDER', percent: 30 + ((globalFrame / totalFrames) * 60), text: `Slayt ${slideIdx + 1}/${slides.length} — ${elapsed.toFixed(1)}sn` });
                await nextFrame();
            }

            // Ses bitene kadar bekle (timeout: 30sn — ses asılı kalırsa devam et)
            if (audioEndPromise) await Promise.race([audioEndPromise, new Promise(r => setTimeout(r, 30000))]);
            addSystemLog(`Slayt ${slideIdx + 1} tamamlandı.`, 'success');
        }

        // Buffer kareleri
        const bufferFrames = Math.round(bufferTime * FPS);
        for (let i = 0; i < bufferFrames; i++) {
            ctx.fillStyle = "#0a0a0a"; ctx.fillRect(0, 0, w, h);
            if (videoTrack && videoTrack.requestFrame) videoTrack.requestFrame();
            globalFrame++;
            await nextFrame();
        }

        // Temizlik
        if (bgmSource) { try { bgmSource.stop(); } catch(e){} }
        if (masterGain) masterGain.disconnect();
        silentOsc.stop(); silentOsc.disconnect();
        timerWorker.postMessage('stop'); timerWorker.terminate();

        addSystemLog('Recorder durduruluyor...', 'info');
        const videoPromise = new Promise((resolve, reject) => {
            recorder.onstop = () => {
                const blob = new Blob(chunks, { type: mimeType });
                addSystemLog(`Video hazır: ${(blob.size / 1024).toFixed(0)}KB, ${(globalFrame / FPS).toFixed(1)}sn`, blob.size > 0 ? 'success' : 'error');
                if (blob.size === 0) return reject(new Error("Video oluşturulamadı."));
                resolve(URL.createObjectURL(blob));
            };
        });
        if (recorder.state !== 'inactive') {
            try { recorder.requestData(); } catch(e){}
            await new Promise(r => setTimeout(r, 200));
            recorder.stop();
        }
        stream.getTracks().forEach(t => t.stop());
        return await videoPromise;
    },
    executeRender: async (jobData, canvasElement, preferences) => {
        addSystemLog('Video render başlatılıyor...', 'info');
        const aspectRatio = jobData.config.aspectRatio || '9:16';
        const w = aspectRatio === '16:9' ? 1280 : aspectRatio === '1:1' ? 1080 : 720;
        const h = aspectRatio === '16:9' ? 720 : aspectRatio === '1:1' ? 1080 : 1280;
        const cx = w / 2;
        canvasElement.width = w; canvasElement.height = h;
        const ctx = canvasElement.getContext('2d');
        ctx.fillStyle = "#0B0F19"; ctx.fillRect(0, 0, w, h);

        if (jobData.config.outputType === 'image') {
            sysEventBus.emit('PROGRESS', { step: 'RENDER', percent: 90, text: 'Görsel Paketleniyor...' });
            const promptImageToUse = jobData.assets.images[0] || jobData.assets.thumbnail;
            if (promptImageToUse) { const sImg = await NetworkUtils.loadImage(promptImageToUse); if (sImg) RenderWorkerService.drawImageContain(ctx, sImg, w, h); }
            return new Promise((resolve) => { canvasElement.toBlob((blob) => resolve(URL.createObjectURL(blob)), 'image/png'); });
        }

        if (jobData.script._isGuzelSoz) {
            let fontFamily = "'Inter', 'Arial Black', Arial, sans-serif";
            if (jobData.config.fontStyle === 'classic') fontFamily = "Georgia, 'Times New Roman', serif";
            if (jobData.config.fontStyle === 'typewriter') fontFamily = "'Courier New', Courier, monospace";
            return RenderWorkerService.renderGuzelSoz(jobData, canvasElement, w, h, cx, fontFamily);
        }

        const targetDurStr = jobData.config.duration || '30'; const isUnlimited = targetDurStr === 'unlimited';
        const isNostalji = jobData.config.tip === 'nostalji' || jobData.script._isNostalji;
        // Birden fazla blok varsa süre sınırı yok — doğal okuma hızında bitir
        const hasMultipleBlocks = (jobData.script.imageBlocks || []).length > 1;
        // Nostalji modunda her zaman süre sınırı aktif (60sn max)
        const useForceExact = isNostalji || (!isUnlimited && !hasMultipleBlocks);
        const bounds = getDurationBounds(targetDurStr);
        // Nostalji modunda her zaman 60 saniye sınırı — 1 saniye bile geçemez
        let limitSec = isNostalji ? 60.0 : (useForceExact ? bounds.max : 9999);
        let globalRenderedSec = 0;
        const getAudioDur = (audioData, fallbackText) => { if (audioData?.wavBuffer) { let byteLength = 0; if (audioData.wavBuffer instanceof ArrayBuffer) byteLength = audioData.wavBuffer.byteLength; else if (audioData.wavBuffer.buffer instanceof ArrayBuffer) byteLength = audioData.wavBuffer.buffer.byteLength; else if (audioData.wavBuffer.byteLength) byteLength = audioData.wavBuffer.byteLength; if (byteLength > WAV_HEADER_SIZE) { const sampleRate = audioData.sampleRate || SAMPLE_RATE; return (byteLength - WAV_HEADER_SIZE) / (sampleRate * 2); } } const wordsCount = (fallbackText || "").trim().split(/\s+/).filter(Boolean).length; if (wordsCount === 0) return 0.5; return Math.max(1.0, wordsCount / getWPS(jobData.config.language)); };

        let rawKapakDur = 1.0;
        let rawSonSozDur = jobData.script.sonSoz ? (getAudioDur(jobData.assets.sonSozAudio, jobData.script.sonSoz) + 0.05) : 0;
        let rawOutroDur = Math.max(5.0, getAudioDur(jobData.assets.outroAudio, jobData.script.lastQuote) + 0.05);
        let rawSlideSecs = jobData.script.videoSlides.map((s, i) => getAudioDur(jobData.assets.audio[i], s.spokenText) + 0.02);
        let rawCushion = 0.03;
        let totalNaturalSec = rawKapakDur + rawSonSozDur + rawOutroDur + rawCushion + rawSlideSecs.reduce((a, b) => a + b, 0);
        let scaleFactor = 1.0;
        if (hasMultipleBlocks) { addSystemLog(`Çoklu blok: Süre sınırı yok. Doğal okuma hızı (${totalNaturalSec.toFixed(1)}sn).`, 'info'); }
        else if (useForceExact) { if (totalNaturalSec > bounds.max) { scaleFactor = bounds.max / totalNaturalSec; addSystemLog(`Süre limitine sığdırılıyor (${scaleFactor.toFixed(2)}x)...`, "warn"); } else if (totalNaturalSec < bounds.min) { scaleFactor = bounds.min / totalNaturalSec; addSystemLog(`Minimum süre yakalanıyor (${scaleFactor.toFixed(2)}x)...`, "warn"); } }

        const timerWorkerCode = `let interval; self.onmessage = function(e) { if (e.data === 'start') interval = setInterval(() => self.postMessage('tick'), 25); if (e.data === 'stop') clearInterval(interval); };`;
        const timerWorkerBlob = new Blob([timerWorkerCode], { type: 'application/javascript' });
        const timerWorker = new Worker(URL.createObjectURL(timerWorkerBlob)); timerWorker.postMessage('start');
        let frameResolvers = [];
        timerWorker.onmessage = () => { const resolvers = frameResolvers; frameResolvers = []; resolvers.forEach(r => r()); };
        const nextFrame = () => new Promise(resolve => { frameResolvers.push(resolve); });

        const audioCtx = _getAudioCtx(); if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        const audioDest = audioCtx ? audioCtx.createMediaStreamDestination() : null;
        const silentOsc = audioCtx.createOscillator(); const silentGain = audioCtx.createGain(); silentGain.gain.value = 0.001; silentOsc.connect(silentGain); silentGain.connect(audioDest); silentOsc.start();
        const keepAliveOsc = audioCtx.createOscillator(); const keepAliveGain = audioCtx.createGain(); keepAliveGain.gain.value = 0.00001; keepAliveOsc.connect(keepAliveGain); keepAliveGain.connect(audioCtx.destination); keepAliveGain.connect(audioDest); keepAliveOsc.start();

        let fontFamily = "'Inter', 'Arial Black', Arial, sans-serif";
        if (jobData.config.fontStyle === 'classic') fontFamily = "Georgia, 'Times New Roman', serif";
        if (jobData.config.fontStyle === 'typewriter') fontFamily = "'Courier New', Courier, monospace";

        const FPS = 30; const stream = canvasElement.captureStream(FPS); const videoTrack = stream.getVideoTracks()[0];
        const audioTracks = audioDest ? audioDest.stream.getAudioTracks() : [];
        const combinedStream = new MediaStream([...stream.getVideoTracks(), ...audioTracks]);
        let mimeType = 'video/webm; codecs="vp8, opus"';
        if (jobData.config.videoFormat === 'mp4') { if (MediaRecorder.isTypeSupported('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')) mimeType = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'; else if (MediaRecorder.isTypeSupported('video/mp4')) mimeType = 'video/mp4'; }
        if (!MediaRecorder.isTypeSupported(mimeType)) { mimeType = 'video/webm;codecs=vp8,opus'; if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm'; }

        const playAudio = async (audioData, requestedDuration = null, fallbackText = "") => {
            if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume().catch(() => {});
            let baseExactDur = getAudioDur(audioData, fallbackText);
            let audioEndPromise = null;
            if (audioData?.wavBuffer && audioCtx) {
                try {
                    let bufferCopy; if (audioData.wavBuffer instanceof ArrayBuffer) bufferCopy = audioData.wavBuffer.slice(0); else if (audioData.wavBuffer.buffer instanceof ArrayBuffer) bufferCopy = audioData.wavBuffer.buffer.slice(0); else if (typeof audioData.wavBuffer === 'object') { const uint8 = new Uint8Array(Object.values(audioData.wavBuffer)); bufferCopy = uint8.buffer.slice(0); } else bufferCopy = audioData.wavBuffer;
                    const audioBuf = await audioCtx.decodeAudioData(bufferCopy); const source = audioCtx.createBufferSource(); source.buffer = audioBuf;
                    source.playbackRate.value = 1.0;
                    const gain = audioCtx.createGain(); gain.gain.value = VOICEOVER_VOLUME;
                    source.connect(gain); gain.connect(audioDest); source.start(0);
                    baseExactDur = Math.min(audioBuf.duration, 180.0); // Maksimum3 dakika sınırı
                    // Ses bitiş Promise'i — renderScene sonunda bekler (timeout: ses süresi + 5sn)
                    audioEndPromise = Promise.race([
                        new Promise(resolve => { source.onended = resolve; }),
                        new Promise(resolve => setTimeout(resolve, (baseExactDur + 5) * 1000))
                    ]);
                } catch (e) { console.warn("Ses decode hatası:", e); }
            }
            let scaledExactDur = baseExactDur * scaleFactor; let totalDur = requestedDuration !== null ? (requestedDuration * scaleFactor) : (scaledExactDur + 0.3);
            return { exactDur: scaledExactDur, totalDur, audioEndPromise };
        };

        const renderSonSozScene = async (text, audioData, duration) => {
            let startT = performance.now(); const safeText = text || "";
            const sonSozResult = await playAudio(audioData, duration, safeText);
            const sonSozAudioEnd = sonSozResult.audioEndPromise;
            const lang = jobData.config.language || 'tr';
            const hasYorum = jobData.config.yorum && jobData.config.yorum.trim().length > 0;
            let yorumDur = 0;
            if (hasYorum && jobData.assets.yorumAudio) {
                const wps = getWPS(jobData.config.language || 'tr');
                const words = (jobData.config.yorum || "").trim().split(/\s+/).filter(Boolean).length;
                yorumDur = Math.max(1.0, words / wps) + 0.3;
            }
            const sonSozFrames = Math.max(1, Math.round(sonSozResult.totalDur * FPS));
            const yorumFrames = Math.max(0, Math.round(yorumDur * FPS));
            const totalFrames = sonSozFrames + yorumFrames;
            let yorumStarted = false;
            for (let frame = 0; frame < totalFrames; frame++) {
                if (useForceExact && globalRenderedSec >= limitSec) break;
                if (hasYorum && frame >= sonSozFrames && !yorumStarted) {
                    await playAudio(jobData.assets.yorumAudio, null, jobData.config.yorum);
                    yorumStarted = true;
                }
                ctx.fillStyle = "#030712"; ctx.fillRect(0, 0, w, h / 2);
                let headerText = "SON SÖZ"; if (lang === 'de') headerText = "SCHLUSSWORT"; else if (lang === 'en') headerText = "FINAL WORDS"; else if (lang === 'fr') headerText = "MOT DE LA FIN"; else if (lang === 'es') headerText = "ÚLTIMAS PALABRAS"; else if (lang === 'ar') headerText = "الكلمة الأخيرة"; else if (lang === 'ru') headerText = "ПОСЛЕСЛОВİЕ";
                ctx.fillStyle = "#E11D48"; ctx.font = `900 ${w > 800 ? 54 : 44}px ${fontFamily}`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(headerText.toUpperCase(), cx, h * 0.08);
                let bodyFontSize = w > 800 ? 42 : 30; ctx.font = `900 ${bodyFontSize}px ${fontFamily}`; let lines = RenderWorkerService.wrapText(ctx, text, w * 0.85);
                const yorumAreaH = hasYorum ? h * 0.25 : 0;
                const maxAllowedY = hasYorum ? h * 0.35 : h / 2 - 35;
                const lh = bodyFontSize * 1.35; while ((h * 0.16 + lines.length * lh) > maxAllowedY && bodyFontSize > 16) { bodyFontSize -= 2; ctx.font = `900 ${bodyFontSize}px ${fontFamily}`; lines = RenderWorkerService.wrapText(ctx, text, w * 0.85); }
                ctx.fillStyle = "#F3F4F6"; ctx.textAlign = "center"; ctx.textBaseline = "top"; const startY = h * 0.16; lines.forEach((line, idx) => { ctx.fillText(line, cx, startY + (idx * bodyFontSize * 1.35)); });
                if (hasYorum) {
                    const yorumFontSize = w > 800 ? 42 : 30;
                    ctx.font = `900 ${yorumFontSize}px ${fontFamily}`;
                    const yorumLines = RenderWorkerService.wrapText(ctx, jobData.config.yorum, w * 0.85);
                    const yorumLh = yorumFontSize * 1.35;
                    const yorumTotalH = yorumLines.length * yorumLh + 35;
                    const yorumStartY = h / 2 - yorumTotalH - 5;
                    ctx.fillStyle = "#2563EB"; ctx.font = `900 ${w > 800 ? 36 : 26}px ${fontFamily}`; ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillText("YORUM", cx, yorumStartY);
                    ctx.font = `900 ${yorumFontSize}px ${fontFamily}`; ctx.fillStyle = "white";
                    yorumLines.forEach((line, idx) => { ctx.fillText(line, cx, yorumStartY + 35 + (idx * yorumLh)); });
                }
                const fX = 0, fY = h / 2, fW = w, fH = h / 2; ctx.save();
                switch (lang.toLowerCase()) {
                    case 'tr': { ctx.fillStyle = "#E30A17"; ctx.fillRect(fX, fY, fW, fH); const centerX = fX + fW / 2; const centerY = fY + fH / 2; const rOuter = fH * 0.28; const rInner = fH * 0.22; const shiftX = fH * 0.08; ctx.fillStyle = "#FFFFFF"; ctx.beginPath(); ctx.arc(centerX - shiftX / 2, centerY, rOuter, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = "#E30A17"; ctx.beginPath(); ctx.arc(centerX - shiftX / 2 + shiftX, centerY, rInner, 0, Math.PI * 2); ctx.fill(); RenderWorkerService.drawStar(ctx, centerX + fH * 0.16, centerY, 5, fH * 0.10, fH * 0.04, "#FFFFFF"); break; }
                    case 'de': { const sH = fH / 3; ctx.fillStyle = "#000000"; ctx.fillRect(fX, fY, fW, sH); ctx.fillStyle = "#DD0000"; ctx.fillRect(fX, fY + sH, fW, sH); ctx.fillStyle = "#FFCE00"; ctx.fillRect(fX, fY + sH * 2, fW, sH); break; }
                    case 'en': { ctx.fillStyle = "#012169"; ctx.fillRect(fX, fY, fW, fH); ctx.strokeStyle = "#FFFFFF"; ctx.lineWidth = fH * 0.1; ctx.beginPath(); ctx.moveTo(fX, fY); ctx.lineTo(fX + fW, fY + fH); ctx.moveTo(fX + fW, fY); ctx.lineTo(fX, fY + fH); ctx.stroke(); ctx.strokeStyle = "#C8102E"; ctx.lineWidth = fH * 0.04; ctx.beginPath(); ctx.moveTo(fX, fY); ctx.lineTo(fX + fW, fY + fH); ctx.moveTo(fX + fW, fY); ctx.lineTo(fX, fY + fH); ctx.stroke(); ctx.fillStyle = "#FFFFFF"; const cwW = fW * 0.16; const cwH = fH * 0.16; ctx.fillRect(fX + fW / 2 - cwW / 2, fY, cwW, fH); ctx.fillRect(fX, fY + fH / 2 - cwH / 2, fW, cwH); ctx.fillStyle = "#C8102E"; const rcwW = fW * 0.10; const rcwH = fH * 0.10; ctx.fillRect(fX + fW / 2 - rcwW / 2, fY, rcwW, fH); ctx.fillRect(fX, fY + fH / 2 - rcwH / 2, fW, rcwH); break; }
                    case 'fr': { const sW = fW / 3; ctx.fillStyle = "#00209F"; ctx.fillRect(fX, fY, sW, fH); ctx.fillStyle = "#FFFFFF"; ctx.fillRect(fX + sW, fY, sW, fH); ctx.fillStyle = "#F63847"; ctx.fillRect(fX + sW * 2, fY, sW, fH); break; }
                    case 'es': { const rH = fH / 4; const yH = fH / 2; ctx.fillStyle = "#C60B1E"; ctx.fillRect(fX, fY, fW, rH); ctx.fillStyle = "#F1BF00"; ctx.fillRect(fX, fY + rH, fW, yH); ctx.fillStyle = "#C60B1E"; ctx.fillRect(fX, fY + rH + yH, fW, rH); break; }
                    case 'ru': { const sH = fH / 3; ctx.fillStyle = "#FFFFFF"; ctx.fillRect(fX, fY, fW, sH); ctx.fillStyle = "#0039A6"; ctx.fillRect(fX, fY + sH, fW, sH); ctx.fillStyle = "#D52B1E"; ctx.fillRect(fX, fY + sH * 2, fW, sH); break; }
                    case 'ar': { const rW = fW * 0.22; ctx.fillStyle = "#E01E37"; ctx.fillRect(fX, fY, rW, fH); const restW = fW - rW; const sH = fH / 3; ctx.fillStyle = "#107C41"; ctx.fillRect(fX + rW, fY, restW, sH); ctx.fillStyle = "#FFFFFF"; ctx.fillRect(fX + rW, fY + sH, restW, sH); ctx.fillStyle = "#000000"; ctx.fillRect(fX + rW, fY + sH * 2, restW, sH); break; }
                    default: { ctx.fillStyle = "#111827"; ctx.fillRect(fX, fY, fW, fH); break; }
                }
                ctx.restore(); globalRenderedSec += 1 / FPS; if (videoTrack && videoTrack.requestFrame) videoTrack.requestFrame(); await nextFrame();
            }
            if (sonSozAudioEnd) await Promise.race([sonSozAudioEnd, new Promise(r => setTimeout(r, 30000))]);
            addSystemLog(`Son söz sahnesi render edildi.`, 'success');
        };

        // Kapanış parçacıkları — executeRender scope'unda tutulur (kareler arası persist)
        let outroParticles = null;
        let channelLogoImg = null;
        try { channelLogoImg = await NetworkUtils.loadImage(CHANNEL_LOGO_URL); } catch(e) { addSystemLog('Kanal logosu yüklenemedi: ' + e.message, 'warn'); }

        const renderScene = async (imgObj, text, audioData, duration, isThumbnail = false, isOutro = false, topText = null, slideIndex = -1, chartData = null, transition = 'none', useContain = false) => {
            let startT = performance.now(); const { exactDur, totalDur, audioEndPromise } = await playAudio(audioData, duration, text);
            const subs = (isThumbnail || isOutro) ? [] : RenderWorkerService.calculateSubtitles(text, exactDur);
            const totalFrames = Math.max(1, Math.round(totalDur * FPS));
            const transitionFrames = Math.min(15, Math.floor(totalFrames * 0.3));
            for (let frame = 0; frame < totalFrames; frame++) {
                if (useForceExact && globalRenderedSec >= limitSec && !isOutro) break;
                const progress = frame / totalFrames; const elapsedSec = frame / FPS;
                const activeSub = subs.find(s => elapsedSec >= s.startSec && elapsedSec < s.endSec)?.text || "";
                ctx.fillStyle = "black"; ctx.fillRect(0, 0, w, h);

                // Transition effect
                let alpha = 1;
                let offsetX = 0;
                if (transition === 'fadeIn' && frame < transitionFrames) {
                    alpha = frame / transitionFrames;
                } else if (transition === 'fadeOut' && frame > totalFrames - transitionFrames) {
                    alpha = (totalFrames - frame) / transitionFrames;
                } else if (transition === 'crossfade' && frame < transitionFrames) {
                    alpha = frame / transitionFrames;
                } else if (transition === 'slideIn' && frame < transitionFrames) {
                    offsetX = w * (1 - frame / transitionFrames);
                } else if (transition === 'slideOut' && frame > totalFrames - transitionFrames) {
                    offsetX = -w * ((frame - (totalFrames - transitionFrames)) / transitionFrames);
                }

                ctx.save();
                ctx.globalAlpha = alpha;
                if (offsetX !== 0) ctx.translate(offsetX, 0);

                if (imgObj) {
                    if (useContain) { RenderWorkerService.drawImageContain(ctx, imgObj, w, h); }
                    else { RenderWorkerService.drawImageCover(ctx, imgObj, w, h); }
                }
                if (isThumbnail) { RenderWorkerService.drawThumbnail(ctx, imgObj, text, w, h, fontFamily, jobData.config.language, jobData.config.tip, jobData.script._newsDate || ''); }
                else if (!isOutro) {
                    const grad = ctx.createLinearGradient(0, h * 0.45, 0, h); grad.addColorStop(0, "transparent"); grad.addColorStop(1, "rgba(0,0,0,0.95)"); ctx.fillStyle = grad; ctx.fillRect(0, h * 0.45, w, h * 0.55);
                    if (topText) {
                        let topFontSize = w > 800 ? 46 : 38;
                        ctx.font = `900 ${topFontSize}px ${fontFamily}`;
                        let lines = RenderWorkerService.wrapText(ctx, topText, w * 0.85);
                        const maxLines = jobData.script._isGuzelSoz ? 10 : 5;
                        while (lines.length > maxLines && topFontSize > 18) {
                            topFontSize -= 2;
                            ctx.font = `900 ${topFontSize}px ${fontFamily}`;
                            lines = RenderWorkerService.wrapText(ctx, topText, w * 0.85);
                        }
                        const lh = topFontSize * 1.3;
                        const boxH = lines.length * lh + 30;
                        const boxW = Math.min(w * 0.92, w * 0.85 + 80);
                        const boxX = cx - (boxW / 2);
                        const boxY = h * 0.06;
                        ctx.fillStyle = "rgba(0,0,0,0.75)";
                        ctx.beginPath();
                        if (ctx.roundRect) ctx.roundRect(boxX, boxY, boxW, boxH, 16);
                        else ctx.rect(boxX, boxY, boxW, boxH);
                        ctx.fill();
                        ctx.fillStyle = "#FFD700";
                        ctx.textAlign = "center";
                        ctx.textBaseline = "middle";
                        lines.forEach((line, i) => { ctx.fillText(line.trim(), cx, boxY + (boxH / 2) - ((lines.length - 1) * lh / 2) + (i * lh)); });
                    }
                    if (jobData.config.sourceName && slideIndex > 0) {
                        const srcText = jobData.config.sourceName;
                        const srcFontSize = w > 800 ? 50 : 40;
                        ctx.font = `900 ${srcFontSize}px 'Inter', Arial`;
                        const textW = ctx.measureText(srcText).width;
                        const bubbleW = textW + 60;
                        const bubbleH = srcFontSize + 40;
                        const bubbleX = w - bubbleW - 16;
                        const bubbleY = 16;
                        ctx.fillStyle = "#DC2626";
                        ctx.beginPath();
                        const bR = bubbleH / 2;
                        ctx.moveTo(bubbleX + bR, bubbleY);
                        ctx.lineTo(bubbleX + bubbleW - bR, bubbleY);
                        ctx.arc(bubbleX + bubbleW - bR, bubbleY + bR, bR, -Math.PI / 2, Math.PI / 2);
                        ctx.lineTo(bubbleX + bR, bubbleY + bubbleH);
                        ctx.arc(bubbleX + bR, bubbleY + bR, bR, Math.PI / 2, -Math.PI / 2);
                        ctx.closePath();
                        ctx.fill();
                        ctx.beginPath();
                        ctx.moveTo(bubbleX + 20, bubbleY + bubbleH);
                        ctx.lineTo(bubbleX + 10, bubbleY + bubbleH + 14);
                        ctx.lineTo(bubbleX + 35, bubbleY + bubbleH);
                        ctx.fill();
                        ctx.fillStyle = "white";
                        ctx.textAlign = "center";
                        ctx.textBaseline = "middle";
                        ctx.fillText(srcText, bubbleX + bubbleW / 2, bubbleY + bubbleH / 2);
                    }
                    if (activeSub && jobData.config.subtitles !== 'off') { let subFontSize = w > 800 ? 65 : 50; ctx.font = `900 ${subFontSize}px ${fontFamily}`; let displaySub = activeSub.trim(); while (ctx.measureText(displaySub).width > w * 0.95 && subFontSize > 30) { subFontSize -= 2; ctx.font = `900 ${subFontSize}px ${fontFamily}`; } const subTextW = ctx.measureText(displaySub).width; const subPadX = 20; const subPadY = 8; const subBoxW = subTextW + subPadX * 2; const subBoxH = subFontSize + subPadY * 2; const subBoxX = cx - subBoxW / 2; const subBoxY = h * 0.85 - subBoxH / 2; ctx.fillStyle = "#2563EB"; ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(subBoxX, subBoxY, subBoxW, subBoxH, 8); else ctx.rect(subBoxX, subBoxY, subBoxW, subBoxH); ctx.fill(); ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "white"; ctx.fillText(displaySub, cx, h * 0.85); }

                    // Nostalji overlay — her karede "HATIRAN YETER" + tarih
                    if (jobData.config.tip === 'nostalji' && jobData.script._newsDate) {
                        // Sepia/vintage filtre
                        ctx.fillStyle = "rgba(112, 66, 20, 0.15)";
                        ctx.fillRect(0, 0, w, h);
                        // Vignette kenar
                        const vigGrad = ctx.createRadialGradient(w/2, h/2, w*0.25, w/2, h/2, w*0.65);
                        vigGrad.addColorStop(0, "rgba(0,0,0,0)");
                        vigGrad.addColorStop(1, "rgba(0,0,0,0.4)");
                        ctx.fillStyle = vigGrad;
                        ctx.fillRect(0, 0, w, h);

                        // "HATIRAN YETER" — üstte, küçük, şeffaf
                        ctx.save();
                        ctx.globalAlpha = 0.85;
                        const headerFontSize = w > 800 ? 32 : 24;
                        ctx.font = `900 ${headerFontSize}px ${fontFamily}`;
                        ctx.textAlign = "center"; ctx.textBaseline = "top";
                        ctx.shadowColor = "rgba(255, 215, 0, 0.6)";
                        ctx.shadowBlur = 15;
                        const headerGrad = ctx.createLinearGradient(cx - w*0.2, 0, cx + w*0.2, 0);
                        headerGrad.addColorStop(0, "#FFD700");
                        headerGrad.addColorStop(0.5, "#FFF8DC");
                        headerGrad.addColorStop(1, "#FFD700");
                        ctx.fillStyle = headerGrad;
                        ctx.fillText("HATIRAN YETER", cx, h * 0.03);
                        ctx.restore();

                        // Tarih — altta, küçük font
                        ctx.save();
                        ctx.globalAlpha = 0.7;
                        const dateFontSize = w > 800 ? 22 : 16;
                        ctx.font = `700 ${dateFontSize}px ${fontFamily}`;
                        ctx.textAlign = "center"; ctx.textBaseline = "bottom";
                        ctx.fillStyle = "#FFFFFF";
                        ctx.shadowColor = "rgba(0,0,0,0.8)";
                        ctx.shadowBlur = 8;
                        ctx.fillText(jobData.script._newsDate, cx, h * 0.97);
                        ctx.restore();
                    }
                }
                if (isOutro) {
                    const outroLang = jobData.config.language || 'tr';
                    const isSpotify = jobData.config.tip === 'spotify' || jobData.script._isSpotify;
                    // Spotify modunda "Görüşmek üzere", normal modda "Abone ol..."
                    const outroTextMap = isSpotify ? {
                        'tr': "Görüşmek üzere,\nkendinize iyi bakın.",
                        'en': "See you later,\ntake care of yourselves.",
                        'fr': "À bientôt,\nprenez soin de vous.",
                        'de': "Bis bald,\npasst auf euch auf.",
                        'es': "Hasta luego,\ncuídense mucho.",
                        'ar': "إلى اللقاء،\nاعتنوا بأنفسكم.",
                        'ru': "До встречи,\nберегите себя."
                    } : {
                        'tr': "Abone olmayı,\nbeğenmeyi ve\npaylaşmayı ihmal etmeyin.",
                        'en': "Don't forget to\nsubscribe, like\nand share.",
                        'fr': "N'oubliez pas de\nvous abonner,\naimer et partager.",
                        'de': "Vergessen Sie nicht\nzu abonnieren, liken\nund zu teilen.",
                        'es': "No olvides\nsuscribirte, dar\nme gusta y compartir.",
                        'ar': "لا تنسَ الاشتراك\nوالإعجاب\nوالمشاركة.",
                        'ru': "Не забудьте\nподписаться, поставить\nлайк и поделиться."
                    };
                    // CTA etiketleri (dile göre) — Spotify modunda yok
                    const ctaLabels = isSpotify ? {} : {
                        'tr': ['Abone Ol', 'Beğen', 'Paylaş'],
                        'en': ['Subscribe', 'Like', 'Share'],
                        'fr': ['Abonner', 'Aimer', 'Partager'],
                        'de': ['Abonnieren', 'Liken', 'Teilen'],
                        'es': ['Suscribir', 'Me Gusta', 'Compartir'],
                        'ar': ['اشترك', 'أعجب', 'شارك'],
                        'ru': ['Подписаться', 'Нравится', 'Поделиться']
                    };
                    const outroText = outroTextMap[outroLang] || outroTextMap['tr'];
                    const cta = ctaLabels[outroLang] || ctaLabels['tr'];

                    // elapsedSec renderScene'den geliyor (kare sayacı / FPS)
                    const t = elapsedSec || 0;

                    // === 1. ARKA PLAN: koyu gradyan + parçacıklar ===
                    const bgGrad = ctx.createRadialGradient(cx, h * 0.4, 0, cx, h * 0.4, h * 0.8);
                    bgGrad.addColorStop(0, '#1a0533');
                    bgGrad.addColorStop(0.5, '#0d0d1a');
                    bgGrad.addColorStop(1, '#000005');
                    ctx.fillStyle = bgGrad;
                    ctx.fillRect(0, 0, w, h);

                    // Animasyonlu bokeh parçacıkları
                    if (!outroParticles) {
                        outroParticles = [];
                        for (let p = 0; p < 20; p++) {
                            outroParticles.push({
                                x: Math.random() * w, y: Math.random() * h,
                                r: 8 + Math.random() * 40, speed: 0.3 + Math.random() * 0.8,
                                alpha: 0.03 + Math.random() * 0.08, hue: Math.random() * 60 + 260
                            });
                        }
                    }
                    for (const p of outroParticles) {
                        p.y -= p.speed;
                        if (p.y < -p.r) { p.y = h + p.r; p.x = Math.random() * w; }
                        const pulse = 1 + 0.15 * Math.sin(t * 2 + p.x);
                        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * pulse);
                        grad.addColorStop(0, `hsla(${p.hue}, 80%, 60%, ${p.alpha})`);
                        grad.addColorStop(1, 'transparent');
                        ctx.fillStyle = grad;
                        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * pulse, 0, Math.PI * 2); ctx.fill();
                    }

                    // === 2. ÜST BÖLÜM: Animasyonlu başlık yazısı ===
                    const outroLines = outroText.split('\n');
                    let outroFontSize = w > 800 ? 48 : 34;
                    ctx.font = `900 ${outroFontSize}px ${fontFamily}`;
                    const outroLh = outroFontSize * 1.4;
                    const outroTotalH = outroLines.length * outroLh;
                    const outroCenterY = h * 0.2;

                    // Her satır fade-in + slide-up animasyonu
                    outroLines.forEach((line, i) => {
                        const lineDelay = i * 0.3;
                        const lineProgress = Math.min(1, Math.max(0, (t - lineDelay) / 0.5));
                        const ease = 1 - Math.pow(1 - lineProgress, 3); // easeOutCubic
                        const y = outroCenterY - (outroTotalH / 2) + (i * outroLh) + (outroLh / 2);
                        const slideY = y + (1 - ease) * 40;
                        const alpha = ease;

                        ctx.save();
                        ctx.globalAlpha = alpha;
                        ctx.textAlign = "center"; ctx.textBaseline = "middle";
                        ctx.font = `900 ${outroFontSize}px ${fontFamily}`;

                        // Gölge
                        ctx.shadowColor = "rgba(255,215,0,0.4)";
                        ctx.shadowBlur = 20 + 10 * Math.sin(t * 3 + i);
                        ctx.lineWidth = outroFontSize * 0.12;
                        ctx.strokeStyle = "rgba(0,0,0,0.9)";
                        ctx.lineJoin = "round";
                        ctx.strokeText(line.trim(), cx, slideY);

                        // Altın gradient yazı
                        const textGrad = ctx.createLinearGradient(cx - w * 0.3, slideY, cx + w * 0.3, slideY);
                        textGrad.addColorStop(0, '#FFD700');
                        textGrad.addColorStop(0.5, '#FFF8DC');
                        textGrad.addColorStop(1, '#FFD700');
                        ctx.fillStyle = textGrad;
                        ctx.fillText(line.trim(), cx, slideY);
                        ctx.restore();
                    });

                    // === 3. ORTA BÖLÜM: Daire şeklinde CTA butonları + ortada logo (Spotify modunda yok) ===
                    if (!isSpotify) {
                    const circleR = w > 800 ? 75 : 56; // buton yarıçapı
                    const orbitR = w > 800 ? 160 : 120; // yörünge yarıçapı (merkezden buton merkezine)
                    const ctaCenterY = h * 0.50;
                    const logoR = w > 800 ? 70 : 52; // logo yarıçapı

                    // 3 buton: üst, sol-alt, sağ-alt (120° aralıkla)
                    const btnConfigs = [
                        { icon: 'bell', color1: '#E11D48', color2: '#FF6B8A', label: cta[0], delay: 0.8, angle: -Math.PI / 2 },
                        { icon: 'heart', color1: '#E11D48', color2: '#FF6B8A', label: cta[1], delay: 1.1, angle: -Math.PI / 2 + (2 * Math.PI / 3) },
                        { icon: 'share', color1: '#7C3AED', color2: '#A78BFA', label: cta[2], delay: 1.4, angle: -Math.PI / 2 + (4 * Math.PI / 3) }
                    ];

                    // Bağlantı çizgileri (merkezden butonlara — fade-in)
                    const linesProgress = Math.min(1, Math.max(0, (t - 0.6) / 0.4));
                    if (linesProgress > 0) {
                        ctx.save();
                        ctx.globalAlpha = linesProgress * 0.15;
                        ctx.strokeStyle = '#FFD700';
                        ctx.lineWidth = 1.5;
                        ctx.setLineDash([6, 4]);
                        btnConfigs.forEach(btn => {
                            const bx = cx + Math.cos(btn.angle) * orbitR;
                            const by = ctaCenterY + Math.sin(btn.angle) * orbitR;
                            ctx.beginPath();
                            ctx.moveTo(cx, ctaCenterY);
                            ctx.lineTo(bx, by);
                            ctx.stroke();
                        });
                        ctx.setLineDash([]);
                        ctx.restore();
                    }

                    btnConfigs.forEach((btn, idx) => {
                        const btnProgress = Math.min(1, Math.max(0, (t - btn.delay) / 0.5));
                        const btnEase = 1 - Math.pow(1 - btnProgress, 3);

                        // Dairesel konum
                        const bx = cx + Math.cos(btn.angle) * orbitR;
                        const by = ctaCenterY + Math.sin(btn.angle) * orbitR;

                        // Fade-in + hafif zoom
                        const alpha = btnEase;
                        const scale = 0.5 + 0.5 * btnEase;
                        // Nabız efekti
                        const pulse = btnProgress >= 1 ? 1 + 0.04 * Math.sin(t * 4 + idx * 1.5) : 1;
                        const finalScale = scale * pulse;

                        ctx.save();
                        ctx.globalAlpha = alpha;
                        ctx.translate(bx, by);
                        ctx.scale(finalScale, finalScale);

                        // Dış halka (glow)
                        ctx.shadowColor = btn.color1 + '80';
                        ctx.shadowBlur = 25;
                        const outerGrad = ctx.createRadialGradient(0, 0, circleR * 0.7, 0, 0, circleR);
                        outerGrad.addColorStop(0, btn.color1);
                        outerGrad.addColorStop(1, btn.color2);
                        ctx.fillStyle = outerGrad;
                        ctx.beginPath();
                        ctx.arc(0, 0, circleR, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.shadowBlur = 0;

                        // İç beyaz halka
                        ctx.fillStyle = 'rgba(255,255,255,0.12)';
                        ctx.beginPath();
                        ctx.arc(0, 0, circleR * 0.82, 0, Math.PI * 2);
                        ctx.fill();

                        // İkon çizimi
                        const isz = circleR * 0.55;
                        ctx.fillStyle = '#FFFFFF';
                        ctx.strokeStyle = '#FFFFFF';
                        ctx.lineWidth = 3;
                        ctx.lineCap = 'round';
                        ctx.lineJoin = 'round';

                        if (btn.icon === 'bell') {
                            ctx.beginPath();
                            ctx.moveTo(0, -isz * 0.85);
                            ctx.quadraticCurveTo(isz * 0.85, -isz * 0.85, isz * 0.85, isz * 0.15);
                            ctx.lineTo(isz * 0.85, isz * 0.45);
                            ctx.lineTo(-isz * 0.85, isz * 0.45);
                            ctx.lineTo(-isz * 0.85, isz * 0.15);
                            ctx.quadraticCurveTo(-isz * 0.85, -isz * 0.85, 0, -isz * 0.85);
                            ctx.closePath();
                            ctx.fill();
                            ctx.fillRect(-isz * 1.05, isz * 0.5, isz * 2.1, isz * 0.22);
                            ctx.beginPath();
                            ctx.arc(0, -isz * 0.85, isz * 0.2, 0, Math.PI * 2);
                            ctx.fill();
                        } else if (btn.icon === 'heart') {
                            const heartScale = 1 + 0.1 * Math.sin(t * 5);
                            ctx.save();
                            ctx.scale(heartScale, heartScale);
                            ctx.beginPath();
                            ctx.moveTo(0, isz * 0.45);
                            ctx.bezierCurveTo(-isz * 0.1, isz * 0.15, -isz * 0.85, -isz * 0.25, 0, -isz * 0.65);
                            ctx.bezierCurveTo(isz * 0.85, -isz * 0.25, isz * 0.1, isz * 0.15, 0, isz * 0.45);
                            ctx.fill();
                            ctx.restore();
                        } else {
                            ctx.beginPath();
                            ctx.arc(0, -isz * 0.45, isz * 0.18, 0, Math.PI * 2);
                            ctx.fill();
                            ctx.beginPath();
                            ctx.arc(-isz * 0.42, isz * 0.1, isz * 0.18, 0, Math.PI * 2);
                            ctx.fill();
                            ctx.beginPath();
                            ctx.arc(isz * 0.42, isz * 0.1, isz * 0.18, 0, Math.PI * 2);
                            ctx.fill();
                            ctx.beginPath();
                            ctx.moveTo(-isz * 0.28, 0);
                            ctx.lineTo(0, -isz * 0.3);
                            ctx.moveTo(isz * 0.28, 0);
                            ctx.lineTo(0, -isz * 0.3);
                            ctx.stroke();
                        }

                        ctx.restore();

                        // Etiket yazısı (dairenin altında)
                        ctx.save();
                        ctx.globalAlpha = alpha;
                        ctx.fillStyle = '#FFFFFF';
                        ctx.font = `800 ${w > 800 ? 18 : 13}px ${fontFamily}`;
                        ctx.textAlign = "center";
                        ctx.textBaseline = "top";
                        ctx.shadowColor = 'rgba(0,0,0,0.8)';
                        ctx.shadowBlur = 6;
                        ctx.fillText(btn.label, bx, by + circleR + 8);
                        ctx.restore();
                    });

                    // === 3b. ORTADA KANAL LOGOSU ===
                    const logoProgress = Math.min(1, Math.max(0, (t - 0.5) / 0.5));
                    const logoEase = 1 - Math.pow(1 - logoProgress, 3);
                    const logoPulse = logoProgress >= 1 ? 1 + 0.02 * Math.sin(t * 3) : 1;

                    ctx.save();
                    ctx.globalAlpha = logoEase;
                    ctx.translate(cx, ctaCenterY);
                    ctx.scale(logoPulse, logoPulse);

                    // Dış halka — altın glow
                    ctx.shadowColor = 'rgba(255,215,0,0.6)';
                    ctx.shadowBlur = 25;
                    ctx.fillStyle = '#FFFFFF';
                    ctx.beginPath();
                    ctx.arc(0, 0, logoR + 4, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.shadowBlur = 0;

                    // Logo görselini dairesel clip ile çiz
                    if (channelLogoImg) {
                        ctx.save();
                        ctx.beginPath();
                        ctx.arc(0, 0, logoR, 0, Math.PI * 2);
                        ctx.clip();
                        const imgSize = logoR * 2;
                        ctx.drawImage(channelLogoImg, -imgSize / 2, -imgSize / 2, imgSize, imgSize);
                        ctx.restore();
                    } else {
                        // Fallback — logo yüklenemezse kırmızı daire + play
                        const logoInnerGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, logoR * 0.85);
                        logoInnerGrad.addColorStop(0, '#E11D48');
                        logoInnerGrad.addColorStop(1, '#9F1239');
                        ctx.fillStyle = logoInnerGrad;
                        ctx.beginPath();
                        ctx.arc(0, 0, logoR * 0.85, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.fillStyle = '#FFFFFF';
                        ctx.beginPath();
                        ctx.moveTo(-logoR * 0.2, -logoR * 0.35);
                        ctx.lineTo(-logoR * 0.2, logoR * 0.35);
                        ctx.lineTo(logoR * 0.35, 0);
                        ctx.closePath();
                        ctx.fill();
                    }

                    ctx.restore();
                    } // isSpotify sonu

                    // === 4. ALT BÖLÜM: Disclaimer ===
                    ctx.save();
                    const dH = Math.max(120, h * 0.22);
                    const dY = h - dH;

                    // Gradient overlay
                    const dGrad = ctx.createLinearGradient(0, dY - 40, 0, dY);
                    dGrad.addColorStop(0, 'transparent');
                    dGrad.addColorStop(1, 'rgba(11,15,25,0.95)');
                    ctx.fillStyle = dGrad;
                    ctx.fillRect(0, dY - 40, w, 40);

                    ctx.fillStyle = "rgba(11,15,25,0.95)";
                    ctx.fillRect(0, dY, w, dH);

                    // Üst çizgi — gradient
                    const lineGrad = ctx.createLinearGradient(0, 0, w, 0);
                    lineGrad.addColorStop(0, 'transparent');
                    lineGrad.addColorStop(0.3, 'rgba(225,29,72,0.6)');
                    lineGrad.addColorStop(0.7, 'rgba(124,58,237,0.6)');
                    lineGrad.addColorStop(1, 'transparent');
                    ctx.strokeStyle = lineGrad;
                    ctx.lineWidth = 1.5;
                    ctx.beginPath(); ctx.moveTo(0, dY); ctx.lineTo(w, dY); ctx.stroke();

                    // Disclaimer yazısı (fade-in)
                    const disclaimerProgress = Math.min(1, Math.max(0, (t - 1.8) / 0.6));
                    ctx.globalAlpha = disclaimerProgress;
                    ctx.fillStyle = "rgba(241,245,249,0.7)";
                    const dFontSize = w > 800 ? 22 : 16;
                    ctx.font = `500 ${dFontSize}px 'Inter', Arial`;
                    ctx.textAlign = "center"; ctx.textBaseline = "middle";
                    const disclaimerMap = {
                        'tr': "Gemini bir yapay zeka modeli olduğu için kişiler de dahil olmak üzere farklı konular hakkında yanlış bilgi verebilir.",
                        'en': "As an AI model, Gemini may provide inaccurate information about various topics, including people.",
                        'fr': "Étant un modèle d'IA, Gemini peut fournir des informations inexactes sur divers sujets, y compris les personnes.",
                        'de': "Da Gemini ein KI-Modell ist, kann es zu verschiedenen Themen, einschließlich Personen, ungenaue Informationen liefern.",
                        'es': "Al ser un modelo de IA, Gemini puede proporcionar información inexacta sobre diversos temas, incluidas personas.",
                        'ar': "بصفته نموذج ذكاء اصطناعي، قد يوفر Gemini معلومات غير دقيقة حول مواضيع مختلفة، بما في ذلك الأشخاص.",
                        'ru': "Как модель ИИ, Gemini может предоставлять неточную информацию по различным темам, включая людей."
                    };
                    const dTxt = disclaimerMap[outroLang] || disclaimerMap['tr'];
                    const dLines = RenderWorkerService.wrapText(ctx, dTxt, w * 0.88);
                    const dLh = dFontSize * 1.5;
                    const dStartY = dY + (dH / 2) - (((dLines.length - 1) * dLh) / 2);
                    dLines.forEach((line, idx) => { ctx.fillText(line.trim(), cx, dStartY + (idx * dLh)); });
                    ctx.restore();
                }
                ctx.restore();
                globalRenderedSec += 1 / FPS; if (videoTrack && videoTrack.requestFrame) videoTrack.requestFrame(); await nextFrame();
            }
            // Ses bitene kadar bekle — sonraki sahne başlamasın (timeout: 30sn)
            if (audioEndPromise) await Promise.race([audioEndPromise, new Promise(r => setTimeout(r, 30000))]);
            addSystemLog(`Sahne ${isThumbnail ? 'kapak' : isOutro ? 'kapanış' : slideIndex} render edildi.`, 'success');
        };

        try {
            let bgmSource, bgmNode, masterGain;
            const loadBGM = async (musicId) => {
                if (bgmSource) { try { bgmSource.stop(); bgmSource.disconnect(); } catch(e) { /* BGM already stopped */ } }
                if (bgmNode) { try { bgmNode.disconnect(); } catch(e) { /* BGM node already disconnected */ } }
                if (masterGain) { try { masterGain.disconnect(); } catch(e) { /* Master gain already disconnected */ } }
                bgmSource = null; bgmNode = null; masterGain = null;
                if (!musicId || musicId === 'none') return;
                const ambientTypes = ['rain', 'wind', 'waves', 'fire'];
                if (ambientTypes.includes(musicId)) {
                    const ambientObj = AmbientAudioService.getAmbientNode(audioCtx, musicId);
                    if (ambientObj) { bgmSource = ambientObj.source; bgmNode = ambientObj.gainNode; masterGain = audioCtx.createGain(); masterGain.gain.value = BGM_VOLUME; bgmNode.connect(masterGain); masterGain.connect(audioDest); }
                } else if (musicId.startsWith('local_')) {
                    try { const track = jobData.assets.musicList?.find(m => m.id === musicId); if (track && track.data) { const res = await fetch(track.data); const buf = await audioCtx.decodeAudioData(await res.arrayBuffer()); bgmSource = audioCtx.createBufferSource(); bgmSource.buffer = buf; bgmSource.loop = true; masterGain = audioCtx.createGain(); masterGain.gain.value = BGM_VOLUME; bgmSource.connect(masterGain); masterGain.connect(audioDest); bgmSource.start(0); } } catch (e) { console.warn("Yerel müzik okunamadı", e); }
                } else {
                    try { const track = await AssetManagerService.getMusicFromLib(musicId); if (track && track.data) { const raw = track.data.includes(',') ? track.data.split(',')[1] : track.data; const byteString = atob(raw); const ab = new ArrayBuffer(byteString.length); const ia = new Uint8Array(ab); for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i); const blob = new Blob([ab], { type: 'audio/mpeg' }); const musicUrl = URL.createObjectURL(blob); const res = await fetch(musicUrl); const buf = await audioCtx.decodeAudioData(await res.arrayBuffer()); bgmSource = audioCtx.createBufferSource(); bgmSource.buffer = buf; bgmSource.loop = true; masterGain = audioCtx.createGain(); masterGain.gain.value = BGM_VOLUME; bgmSource.connect(masterGain); masterGain.connect(audioDest); bgmSource.start(0); } } catch (e) { console.warn("Müzik okunamadı", e); }
                }
            };
            let initialBgmId = jobData.script._bgmId || preferences.ambientSound || 'none';
            // Spotify modunda müzik yoksa procedural piyano/keman üret
            if (initialBgmId === 'none' && (jobData.config.tip === 'spotify' || jobData.script._isSpotify)) {
                addSystemLog('Spotify modu: Procedural sakin piyano müziği üretiliyor...', 'info');
                const calmBuffer = AmbientAudioService.generateCalmMusic(audioCtx, 'piano', 120);
                bgmSource = audioCtx.createBufferSource();
                bgmSource.buffer = calmBuffer;
                bgmSource.loop = true;
                masterGain = audioCtx.createGain();
                masterGain.gain.value = 0.25;
                bgmSource.connect(masterGain);
                masterGain.connect(audioDest);
                bgmSource.start(0);
                addSystemLog('Procedural piyano müziği hazır (120sn loop).', 'success');
            }
            // Nostalji modunda "Hatıran Yeter" şarkısını yükle
            else if (jobData.config.tip === 'nostalji' || jobData.script._isNostalji) {
                addSystemLog('Nostalji modu: "Hatıran Yeter" müziği yükleniyor...', 'info');
                let nostaljiMusicLoaded = false;

                // 1. Önce kullanıcının seçtiği nostalji müziğini dene
                if (initialBgmId && initialBgmId !== 'none') {
                    try {
                        await loadBGM(initialBgmId);
                        if (bgmSource) {
                            nostaljiMusicLoaded = true;
                            addSystemLog('Nostalji müziği yüklendi (kullanıcı seçimi).', 'success');
                        }
                    } catch(e) { addSystemLog('Nostalji müzik yükleme hatası: ' + e.message, 'warn'); }
                }

                // 2. "Hatıran Yeter" IndexedDB'de var mı kontrol et
                if (!nostaljiMusicLoaded) {
                    try {
                        const hatiranYeterTrack = await AssetManagerService.getMusicByName('Hatıran Yeter');
                        if (hatiranYeterTrack && hatiranYeterTrack.data) {
                            const raw = hatiranYeterTrack.data.includes(',') ? hatiranYeterTrack.data.split(',')[1] : hatiranYeterTrack.data;
                            const byteString = atob(raw);
                            const ab = new ArrayBuffer(byteString.length);
                            const ia = new Uint8Array(ab);
                            for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
                            const blob = new Blob([ab], { type: 'audio/mpeg' });
                            const musicUrl = URL.createObjectURL(blob);
                            const res = await fetch(musicUrl);
                            const buf = await audioCtx.decodeAudioData(await res.arrayBuffer());
                            bgmSource = audioCtx.createBufferSource();
                            bgmSource.buffer = buf;
                            bgmSource.loop = true;
                            masterGain = audioCtx.createGain();
                            masterGain.gain.value = BGM_VOLUME;
                            bgmSource.connect(masterGain);
                            masterGain.connect(audioDest);
                            bgmSource.start(0);
                            nostaljiMusicLoaded = true;
                            addSystemLog('"Hatıran Yeter" şarkısı yüklendi (IndexedDB).', 'success');
                        }
                    } catch(e) { addSystemLog('Hatıran Yeter yükleme hatası: ' + e.message, 'warn'); }
                }

                // 3. Hiçbiri yoksa procedural nostaljik müzik üret
                if (!nostaljiMusicLoaded) {
                    addSystemLog('"Hatıran Yeter" bulunamadı, procedural nostaljik müzik üretiliyor...', 'info');
                    const nostalgicBuffer = AmbientAudioService.generateCalmMusic(audioCtx, 'violin', 90);
                    bgmSource = audioCtx.createBufferSource();
                    bgmSource.buffer = nostalgicBuffer;
                    bgmSource.loop = true;
                    masterGain = audioCtx.createGain();
                    masterGain.gain.value = BGM_VOLUME;
                    bgmSource.connect(masterGain);
                    masterGain.connect(audioDest);
                    bgmSource.start(0);
                    addSystemLog('Procedural nostaljik keman müziği hazır (90sn loop).', 'success');
                }
            } else {
                addSystemLog(`Render BGM: ${initialBgmId} (script._bgmId: ${jobData.script._bgmId || 'yok'})`, 'info');
                await loadBGM(initialBgmId);
            }

            const tImg = await NetworkUtils.loadImage(jobData.assets.thumbnail);
            const customOutroData = await AssetManagerService.loadMedia('CUSTOM_OUTRO');
            const outroImg = await NetworkUtils.loadImage(customOutroData || jobData.assets.outroImage);

            if (tImg) { RenderWorkerService.drawThumbnail(ctx, tImg, jobData.script.thumbnailText, w, h, fontFamily, jobData.config.language, jobData.config.tip, jobData.script._newsDate || ''); if (videoTrack && videoTrack.requestFrame) videoTrack.requestFrame(); for (let i = 0; i < 10; i++) await nextFrame(); }

            const recorder = new MediaRecorder(combinedStream, { mimeType, audioBitsPerSecond: AUDIO_BITRATE, videoBitsPerSecond: VIDEO_BITRATE });
            const chunks = []; recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); }; recorder.start(100);

            sysEventBus.emit('PROGRESS', { step: 'RENDER', percent: 10, text: 'Clickbait Kapak Oluşturuluyor...' });
            await renderScene(tImg, jobData.script.thumbnailText, null, rawKapakDur, true, false, null, 0, null, jobData.config.transition);

            // Sadece bloğun 1. sahnesi sabit görsel kullanır (S1 gösterimi)
            // 2. ve 3. sahneler AI görseli kullanır
            const slideIsCustom = [];
            const blocks = jobData.script.imageBlocks || [];
            let gIdx = 0;
            for (const block of blocks) {
                if (block.imageType === 'custom') {
                    slideIsCustom[gIdx] = true; // Sadece 1. sahne
                }
                gIdx += block.videoSlides.length;
            }

            const WINDOW_SIZE = 5;
            for (let i = 0; i < jobData.script.videoSlides.length; i++) {
                if (useForceExact && globalRenderedSec >= limitSec) break;
                const slide = jobData.script.videoSlides[i];
                sysEventBus.emit('PROGRESS', { step: 'RENDER', percent: 20 + ((i + 1) / jobData.script.videoSlides.length) * 60, text: `Sahne ${i + 1} Render Ediliyor...` });
                const sImg = await NetworkUtils.loadImage(jobData.assets.images[i]) || tImg;
                const isCustomImg = !!slideIsCustom[i];
                await renderScene(sImg, slide.spokenText, jobData.assets.audio[i], rawSlideSecs[i], false, false, slide.topText, i + 1, jobData.script.chartData, jobData.config.transition, isCustomImg);
                // Sliding window: serbest bırakılan görselleri temizle
                if (i >= WINDOW_SIZE) {
                    const releaseIdx = i - WINDOW_SIZE;
                    jobData.assets.images[releaseIdx] = null;
                    jobData.assets.audio[releaseIdx] = null;
                }
            }

            const lastSlideText = jobData.script.videoSlides.length > 0 ? jobData.script.videoSlides[jobData.script.videoSlides.length - 1].spokenText.toLowerCase() : "";
            const sonSozLower = (jobData.script.sonSoz || "").toLowerCase();
            const sonSozWords = sonSozLower.split(/\s+/).filter(w => w.length > 2);
            const lastSlideWords = lastSlideText.split(/\s+/);
            const matchCount = sonSozWords.filter(w => lastSlideWords.some(lw => lw.includes(w) || w.includes(lw))).length;
            const sonSozIsDuplicate = jobData.script.sonSoz && sonSozWords.length > 0 && (matchCount >= sonSozWords.length * 0.4 || lastSlideText.includes(sonSozLower) || sonSozLower.includes(lastSlideText));
            if (jobData.script.sonSoz && !sonSozIsDuplicate && (!useForceExact || globalRenderedSec < limitSec)) { sysEventBus.emit('PROGRESS', { step: 'RENDER', percent: 85, text: 'Son Söz Sahnesi Render Ediliyor...' }); await renderSonSozScene(jobData.script.sonSoz, jobData.assets.sonSozAudio, rawSonSozDur); }
            // Kapanış sahnesi — süre limitinden bağımsız, her zaman tam render edilir
            sysEventBus.emit('PROGRESS', { step: 'RENDER', percent: 90, text: 'Kapanış Render Ediliyor...' });
            await renderScene(outroImg, jobData.script.lastQuote, jobData.assets.outroAudio, rawOutroDur, false, true, null, 99, null, jobData.config.transition);

            if (bgmSource) { try { bgmSource.stop(); bgmSource.disconnect(); } catch(e){} } if (bgmNode) { try { bgmNode.disconnect(); } catch(e){} } if (masterGain) { try { masterGain.disconnect(); } catch(e){} }
            silentOsc.stop(); silentOsc.disconnect(); keepAliveOsc.stop(); keepAliveOsc.disconnect(); keepAliveGain.disconnect();

            try { const totalFrames = Math.floor(rawCushion * scaleFactor * FPS); for (let i = 0; i < totalFrames; i++) { if (useForceExact && globalRenderedSec >= limitSec) break; globalRenderedSec += 1 / FPS; await nextFrame(); } } catch (e) { console.warn("Kapanış bekleme hatası:", e); }

            timerWorker.postMessage('stop'); timerWorker.terminate();

            return new Promise((resolve, reject) => {
                recorder.onstop = () => { const blob = new Blob(chunks, { type: mimeType }); if (blob.size === 0) return reject(new Error("Video oluşturulamadı (0 Bayt).")); resolve(URL.createObjectURL(blob)); };
                if (recorder.state !== 'inactive') { try { recorder.requestData(); } catch (e) { } setTimeout(() => recorder.stop(), 100); } else resolve(URL.createObjectURL(new Blob(chunks, { type: mimeType })));
            });
        } catch (e) { if (typeof timerWorker !== 'undefined') timerWorker.terminate(); throw new Error(`Render failed: ${e.message}`); }
    }
};

class WorkflowCoordinator {
    constructor() { this.jobId = null; this.state = {}; }
    async updateProgress(percent, text, step) { const safePercent = Math.min(100, Math.max(0, Math.round(percent))); this.state.progress = safePercent; this.state.statusText = text; await AssetManagerService.saveJobState(this.state); sysEventBus.emit('PROGRESS', { step, percent: safePercent, text }); }
    async startWorkflow(inputData, inputType, config, preferences, canvasRef, prebuiltImageQueue = null, extMusicList = []) {
        this.jobId = "job_" + Date.now();
        addSystemLog('=== WORKFLOW BAŞLATILDI ===', 'info', null, {
            jobId: this.jobId, inputType, tip: config.tip, analysisMode: config.analysisMode,
            language: config.language, duration: config.duration, videoStyle: config.videoStyle,
            hasCustomImages: (config.customSceneImages || []).length > 0,
            hasUploadedMedia: inputType === 'media' && Array.isArray(inputData) ? inputData.length : 0,
            prefs: { voice: preferences.narratorVoice, music: preferences.ambientSound, bgmVolume: preferences.bgmVolume }
        });
        // Eğer önceden oluşturulmuş imageQueue varsa onu kullan (gazete batch modu)
        const allImages = prebuiltImageQueue || (() => {
            const customImages = config.customSceneImages || [];
            const uploadedMedia = (inputType === 'media' && Array.isArray(inputData)) ? inputData : [];
            const queue = [];
            if (customImages.length > 0 && uploadedMedia.length > 0) {
                const pairCount = Math.min(customImages.length, uploadedMedia.length, 10);
                for (let i = 0; i < pairCount; i++) {
                    queue.push({ type: 'custom', data: customImages[i], mediaItem: uploadedMedia[i] });
                }
                addSystemLog(`Eşleştirme: ${pairCount} blok (S1+M1, S2+M2, ...)`, 'info');
            } else if (customImages.length > 0) {
                for (const img of customImages) queue.push({ type: 'custom', data: img });
            } else {
                for (const m of uploadedMedia) queue.push({ type: 'uploaded', data: m });
            }
            return queue;
        })();
        this.state = { jobId: this.jobId, status: 'INIT', inputData, inputType, config, preferences,
            script: { imageBlocks: [], thumbnailText: '', lastQuote: '', sonSoz: '', thumbnailImagePrompt: '', _isGuzelSoz: false },
            assets: { images: [], audio: [], musicList: extMusicList, thumbnail: null, thumbnailAudio: null, sonSozAudio: null, yorumAudio: null, outroAudio: null, blackoutAudio: null },
            imageQueue: allImages, processedImageCount: 0, progress: 0 };
        await AssetManagerService.saveJobState(this.state);
        return this.resumeWorkflow(canvasRef);
    }
    async resumeWorkflow(canvasRef) {
        try {
            if (!this.state || !this.state.jobId) { const saved = await AssetManagerService.getPendingJob(); if (saved) this.state = saved; else throw new Error("Bekleyen işlem bulunamadı."); }
            sysEventBus.emit('WORKFLOW_STATE', { status: 'RUNNING', job: this.state });

            if (this.state.status === 'INIT') {
                // Güzel söz modu → eski akış (değişmedi)
                if (this.state.config.tip === 'guzel_soz') {
                    let startT = performance.now();
                    await this.updateProgress(10, 'Veri Analizi...', 'LOGIC');
                    const script = await LogicEngineService.analyzeContent(this.state.inputData, this.state.inputType, this.state.config);
                    this.state.script = script;
                    this.state.status = 'GENERATING_ASSETS';
                    await AssetManagerService.saveJobState(this.state);
                    addSystemLog(`Senaryo üretimi tamamlandı (${((performance.now() - startT) / 1000).toFixed(1)}s).`, 'success');
                }
                // Kelimesi Kelimesine modu → birebir okuma, AI müdahalesi yok
                else if (this.state.config.tip === 'kelimesi') {
                    let startT = performance.now();
                    await this.updateProgress(10, 'Metin hazırlanıyor...', 'LOGIC');
                    const script = await LogicEngineService._buildKelimesiKelimesineScript(this.state.inputData, this.state.inputType, this.state.config);
                    this.state.script = script;
                    this.state.status = 'GENERATING_ASSETS';
                    await AssetManagerService.saveJobState(this.state);
                    addSystemLog(`Kelimesi Kelimesine metin hazır (${((performance.now() - startT) / 1000).toFixed(1)}s).`, 'success');
                }
                else {
                    // YENİ AKIŞ: Her görsel için sırayla sahne üret
                    const queue = this.state.imageQueue || [];
                    const totalImages = queue.length;
                    if (totalImages === 0) throw new Error("İşlenecek görsel bulunamadı. Lütfen en az bir sabit görsel veya medya yükleyin.");

                    addSystemLog(`Toplam ${totalImages} görsel işlenecek.`, 'info');
                    let previousContext = "";

                    for (let i = this.state.processedImageCount || 0; i < totalImages; i++) {
                        const imgItem = queue[i];
                        const blockNum = i + 1;
                        await this.updateProgress(5 + (blockNum / totalImages) * 35, `Blok ${blockNum}/${totalImages} analiz ediliyor...`, 'LOGIC');

                        let blockResult;
                        try {
                            if (imgItem.type === 'custom' && imgItem.mediaItem) {
                                blockResult = await LogicEngineService.analyzeContentForImage([imgItem.mediaItem], 'media', this.state.config, i, totalImages, previousContext);
                            } else if (imgItem.type === 'custom' && imgItem.data) {
                                blockResult = await LogicEngineService.analyzeContentForImage([{ data: imgItem.data, type: 'image/png' }], 'media', this.state.config, i, totalImages, previousContext);
                            } else if (imgItem.type === 'uploaded' && imgItem.data) {
                                blockResult = await LogicEngineService.analyzeContentForImage([imgItem.data], 'media', this.state.config, i, totalImages, previousContext);
                            } else {
                                blockResult = await LogicEngineService.analyzeContentForImage(this.state.inputData, this.state.inputType, this.state.config, i, totalImages, previousContext);
                            }
                        } catch (e) {
                            addSystemLog(`Blok ${blockNum} analiz hatası: ${e.message}, çoklu sahne oluşturuluyor...`, 'warn');
                            const fallbackText = imgItem.metadata?.name || `Görsel ${blockNum}`;
                            const slideTemplates = [
                                { top: 'Gündem', spoken: 'İşte gündemin en önemli gelişmesi. Bu haber birçok kişiyi yakından ilgilendiriyor.' },
                                { top: 'Detaylar', spoken: 'Yaşanan bu gelişme, son günlerin en çok konuşulan konuları arasında yer alıyor.' },
                                { top: 'Analiz', spoken: 'Uzmanlar bu durumun etkilerini değerlendirmeye devam ediyor. Gelişmeler yakından takip ediliyor.' },
                            ];
                            blockResult = {
                                videoSlides: slideTemplates.map((s, si) => ({
                                    topText: s.top,
                                    spokenText: s.spoken,
                                    imagePrompts: [`Cinematic news scene ${blockNum}, dramatic lighting, professional video aesthetic, shot ${si + 1}`]
                                })),
                                thumbnailText: fallbackText,
                                sonSoz: 'Her şeyin bir bildiği var, yeter ki bakmasını bilelim.',
                                lastQuote: 'Gelişmeleri aktarmaya devam edeceğiz.',
                                thumbnailImagePrompt: `Cinematic news scene ${blockNum}`
                            };
                        }

                        if (i === 0) {
                            this.state.script.thumbnailText = blockResult.thumbnailText || '';
                            this.state.script.thumbnailImagePrompt = blockResult.thumbnailImagePrompt || '';
                        }
                        if (blockResult.sonSoz) this.state.script.sonSoz = blockResult.sonSoz;
                        if (blockResult.lastQuote) this.state.script.lastQuote = blockResult.lastQuote;
                        if (blockResult.youtubeTitle) this.state.script.youtubeTitle = blockResult.youtubeTitle;
                        if (blockResult.youtubeDescription) this.state.script.youtubeDescription = blockResult.youtubeDescription;
                        if (blockResult.youtubeHashtags) this.state.script.youtubeHashtags = blockResult.youtubeHashtags;
                        if (blockResult.tiktokTitle) this.state.script.tiktokTitle = blockResult.tiktokTitle;
                        if (blockResult.tiktokDescription) this.state.script.tiktokDescription = blockResult.tiktokDescription;
                        if (blockResult.tiktokHashtags) this.state.script.tiktokHashtags = blockResult.tiktokHashtags;

                        this.state.script.imageBlocks.push({
                            imageIndex: i,
                            imageType: imgItem.type,
                            customImage: imgItem.type === 'custom' ? imgItem.data : null,
                            videoSlides: blockResult.videoSlides || []
                        });

                        const slideTexts = (blockResult.videoSlides || []).map(s => s.spokenText).join(' ');
                        previousContext = `Blok ${blockNum}: ${slideTexts.substring(0, 200)}...`;

                        this.state.processedImageCount = i + 1;
                        await AssetManagerService.saveJobState(this.state);
                        addSystemLog(`Blok ${blockNum}/${totalImages} tamamlandı (${(blockResult.videoSlides || []).length} sahne).`, 'success');
                    }

                    // Tüm blokları düz videoSlides dizisine çevir (render için)
                    this.state.script.videoSlides = [];
                    for (const block of this.state.script.imageBlocks) {
                        this.state.script.videoSlides.push(...block.videoSlides);
                    }
                    addSystemLog(`INIT tamamlandı: ${this.state.script.imageBlocks.length} blok, ${this.state.script.videoSlides.length} sahne.`, 'success');
                    addSystemLog(`Blok detayları: ${this.state.script.imageBlocks.map((b, i) => `B${i + 1}=${b.videoSlides.length}s`).join(', ')}`, 'info');

                    this.state.status = 'GENERATING_ASSETS';
                    await AssetManagerService.saveJobState(this.state);
                }
            }
            if (this.state.status === 'GENERATING_ASSETS') {
                addSystemLog('=== ASSETS PHASE ===', 'info', null, {
                    totalSlides: this.state.script.videoSlides?.length || 0,
                    isKelimesi: !!this.state.script._isKelimesi,
                    isGuzelSoz: !!this.state.script._isGuzelSoz,
                    imageBlocks: this.state.script.imageBlocks?.length || 0,
                    textlessImages: this.state.script._textlessImages?.length || 0,
                    audioCount: this.state.assets.audio?.length || 0,
                    imageCount: this.state.assets.images?.length || 0,
                    thumbnailReady: !!this.state.assets.thumbnail,
                    narratorVoice: this.state.preferences.narratorVoice
                });
                await this.updateProgress(30, 'Medya ve Sesler Sentezleniyor...', 'ASSETS');
                const imgStyle = this.state.config.imageStyle || 'cinematic'; const imgRes = this.state.config.resolution || '4K';

                if (this.state.script._isGuzelSoz) {
                    addSystemLog('Güzel söz modu: görseller ve ses üretiliyor...', 'info');
                    const slideCount = this.state.script._sceneCount || 3;
                    const quoteTextForImage = this.state.script.videoSlides[0]?.spokenText || "";
                    const emotionForImage = this.state.script._emotion || analyzeQuoteEmotion(quoteTextForImage);
                    const realUrls = this.state.script._realImageUrls || [];

                    for (let i = 0; i < slideCount; i++) {
                        const slide = this.state.script.videoSlides[i];
                        if (!this.state.assets.images[i]) {
                            try {
                                // Gerçek görsel varsa onu kullan (Atatürk vb.)
                                if (realUrls[i]) {
                                    addSystemLog(`  Görsel ${i + 1}: Gerçek görsel kullanılıyor...`, 'info');
                                    this.state.assets.images[i] = realUrls[i];
                                } else {
                                    this.state.assets.images[i] = await MediaSynthesisService.generateImage(
                                        slide.imagePrompts?.[0] || "Artistic background",
                                        imgStyle, imgRes, true, emotionForImage, quoteTextForImage
                                    );
                                }
                                addSystemLog(`  Görsel ${i + 1}/${slideCount} tamamlandı.`, 'success');
                            } catch (e) {
                                addSystemLog(`  Görsel ${i + 1} hatası, fallback kullanılıyor.`, 'warn');
                                this.state.assets.images[i] = this.state.assets.thumbnail;
                            }
                        }
                    }

                    // Her söz satırı için ayrı ses üret
                    for (let i = 0; i < this.state.script.videoSlides.length; i++) {
                        if (!this.state.assets.audio[i] && this.state.script.videoSlides[i].spokenText) {
                            try {
                                this.state.assets.audio[i] = await MediaSynthesisService.generateAudio(
                                    this.state.script.videoSlides[i].spokenText,
                                    this.state.preferences.narratorVoice
                                );
                                addSystemLog(`Ses ${i + 1}/${this.state.script.videoSlides.length} hazır.`, 'success');
                            } catch (e) {
                                addSystemLog(`Ses ${i + 1} hatası: ${e.message}`, 'warn');
                            }
                        }
                    }
                    if (!this.state.assets.thumbnail) this.state.assets.thumbnail = this.state.assets.images[0];

                    const allMusic = await AssetManagerService.getAllMusicFromLib();
                    if (allMusic.length > 0) {
                        const matchedTrack = matchMusicToEmotion(emotionForImage, allMusic);
                        const chosenTrack = matchedTrack || allMusic[Math.floor(Math.random() * allMusic.length)];
                        addSystemLog(`Müzik seçildi: ${chosenTrack.name} (duygu: ${emotionForImage})`, 'success');
                        this.state.script._bgmId = chosenTrack.id;
                        this.state.script._bgmName = chosenTrack.name;
                        this.state.preferences.ambientSound = chosenTrack.id;
                        this.state.preferences.customBgMusicName = chosenTrack.name;
                        this.state.preferences.customBgMusicId = chosenTrack.id;
                    } else {
                        addSystemLog('Müzik kütüphanesi boş, müzik eklenmedi.', 'warn');
                    }

                    await this.updateProgress(70, 'Güzel söz hazır...', 'ASSETS');
                } else {
                if (!this.state.assets.thumbnail) { addSystemLog('Kapak resmi çizimi...', 'info'); this.state.assets.thumbnail = await MediaSynthesisService.generateImage(this.state.script.thumbnailImagePrompt || "Dramatic news event", imgStyle, imgRes); addSystemLog('Kapak resmi tamamlandı.', 'success'); }

                // Kelimesi Kelimesine modunda yazısız görselleri slaytlara ekle
                if (this.state.script._isKelimesi && this.state.script._textlessImages && this.state.script._textlessImages.length > 0) {
                    const textlessImages = this.state.script._textlessImages;
                    const originalSlides = this.state.script.videoSlides;
                    const newSlides = [];
                    const newImages = [];

                    // İlk yazısız görseli clickbait'ten sonra ekle
                    newSlides.push({
                        topText: '',
                        spokenText: '',
                        imagePrompts: ['Uploaded textless image'],
                        _isTextless: true
                    });
                    newImages.push(textlessImages[0]);

                    // Orijinal slaytları ekle
                    for (let i = 0; i < originalSlides.length; i++) {
                        newSlides.push(originalSlides[i]);
                        newImages.push(null); // AI üretilecek
                    }

                    // İkinci yazısız görseli son sahneye ekle
                    if (textlessImages.length > 1) {
                        newSlides.push({
                            topText: '',
                            spokenText: '',
                            imagePrompts: ['Uploaded textless image'],
                            _isTextless: true
                        });
                        newImages.push(textlessImages[1]);
                    } else if (textlessImages.length === 1) {
                        // Aynı görseli tekrar kullan
                        newSlides.push({
                            topText: '',
                            spokenText: '',
                            imagePrompts: ['Uploaded textless image'],
                            _isTextless: true
                        });
                        newImages.push(textlessImages[0]);
                    }

                    this.state.script.videoSlides = newSlides;
                    this.state.script._textlessImageSlots = newImages;
                    addSystemLog(`Yazısız görseller eklendi: clickbait'ten sonra + son sahne öncesi. Toplam slayt: ${newSlides.length}`, 'info');
                }

                const customImages = this.state.config.customSceneImages || [];
                this.state.customImageCount = customImages.length;

                const blocks = this.state.script.imageBlocks || [];
                if (blocks.length > 0) {
                    let globalIdx = 0;
                    for (let b = 0; b < blocks.length; b++) {
                        const block = blocks[b];
                        const blockSlideCount = block.videoSlides.length;
                        const blockCustomImg = block.customImage || customImages[b];
                        if (block.imageType === 'custom' && blockCustomImg) {
                            this.state.assets.images[globalIdx] = blockCustomImg;
                            addSystemLog(`Blok ${b + 1}: Sabit görsel 1. sahneye atandı. Kalan ${blockSlideCount - 1} sahne AI üretilecek.`, 'info');
                        }
                        globalIdx += blockSlideCount;
                    }
                } else if (customImages.length > 0) {
                    // Kelimesi Kelimesine modu veya blocksız akış: custom görselleri sırayla ata
                    for (let i = 0; i < Math.min(customImages.length, this.state.script.videoSlides.length); i++) {
                        this.state.assets.images[i] = customImages[i];
                    }
                    addSystemLog(`${Math.min(customImages.length, this.state.script.videoSlides.length)} custom görsel slaytlara atandı.`, 'info');
                }

                const CHUNK_SIZE = 3;
                addSystemLog(`ASSETS fase: ${this.state.script.videoSlides.length} sahne, ${CHUNK_SIZE}'lü chunk.`, 'info');
                for (let i = 0; i < this.state.script.videoSlides.length; i += CHUNK_SIZE) {
                    const chunk = this.state.script.videoSlides.slice(i, i + CHUNK_SIZE);
                    addSystemLog(`Sahneler ${i + 1}-${Math.min(i + CHUNK_SIZE, this.state.script.videoSlides.length)} işleniyor...`, 'info');
                    const chunkPromises = chunk.map(async (slide, idx) => {
                        const actualIndex = i + idx;

                        // Yazısız görsel slaytı — doğrudan yüklenen görseli kullan, ses üretme
                        if (slide._isTextless) {
                            const textlessImg = this.state.script._textlessImageSlots?.[actualIndex];
                            this.state.assets.images[actualIndex] = textlessImg || this.state.assets.thumbnail;
                            this.state.assets.audio[actualIndex] = null; // Ses yok
                            addSystemLog(`Slayt ${actualIndex + 1}: Yazısız görsel slaytı — ses yok.`, 'info');
                            return;
                        }

                        const computedPrompt = slide.imagePrompts?.[0] || slide.topText || slide.spokenText || "News event";
                        const imgPromise = this.state.assets.images[actualIndex] ? Promise.resolve(this.state.assets.images[actualIndex]) : MediaSynthesisService.generateImage(computedPrompt, imgStyle, imgRes).then(res => res || this.state.assets.thumbnail);
                        const audPromise = this.state.assets.audio[actualIndex] ? Promise.resolve(this.state.assets.audio[actualIndex]) : MediaSynthesisService.generateAudio(slide.spokenText, this.state.script._isKelimesi ? getAutoVoice(actualIndex, this.state.script.videoSlides.length) : this.state.preferences.narratorVoice);
                        const [imgResData, audResData] = await Promise.all([imgPromise, audPromise]);
                        this.state.assets.images[actualIndex] = imgResData;
                        this.state.assets.audio[actualIndex] = audResData;
                    });
                    await Promise.all(chunkPromises);
                    const currentProgress = Math.min(i + CHUNK_SIZE, this.state.script.videoSlides.length);
                    await this.updateProgress(40 + (currentProgress / this.state.script.videoSlides.length) * 30, `Sahneler ${currentProgress}/${this.state.script.videoSlides.length}...`, 'ASSETS');
                }
                }

                const extraAudioPromises = [];
                if (!this.state.script._isGuzelSoz) {
                    if (this.state.script.sonSoz && !this.state.assets.sonSozAudio) extraAudioPromises.push(MediaSynthesisService.generateAudio(this.state.script.sonSoz, this.state.preferences.narratorVoice).then(res => { this.state.assets.sonSozAudio = res; }));
                    if (this.state.config.yorum && this.state.config.yorum.trim() && !this.state.assets.yorumAudio) extraAudioPromises.push(MediaSynthesisService.generateAudio(this.state.config.yorum, this.state.preferences.narratorVoice).then(res => { this.state.assets.yorumAudio = res; }));
                    if (!this.state.assets.outroAudio) {
                        const quotePrefix = this.state.script.lastQuote ? `${this.state.script.lastQuote} ` : "";
                        const isSpotifyMode = this.state.config.tip === 'spotify' || this.state.script._isSpotify;
                        let defaultOutroText;
                        if (isSpotifyMode) {
                            // Spotify modu: "Görüşmek üzere"
                            const spotifyOutroMap = { 'tr': "Görüşmek üzere, kendinize iyi bakın.", 'en': "See you later, take care of yourselves.", 'fr': "À bientôt, prenez soin de vous.", 'de': "Bis bald, passt auf euch auf.", 'es': "Hasta luego, cuídense mucho.", 'ar': "إلى اللقاء، اعتنوا بأنفسكم.", 'ru': "До встречи, берегите себя." };
                            defaultOutroText = spotifyOutroMap[this.state.config.language] || spotifyOutroMap['tr'];
                        } else {
                            defaultOutroText = "Abone olmayı, beğenmeyi ve paylaşmayı ihmal etmeyin.";
                            if (this.state.config.language === 'en') defaultOutroText = "Don't forget to subscribe, like, and share.";
                            else if (this.state.config.language === 'fr') defaultOutroText = "N'oubliez pas de vous abonner, d'aimer et de partager.";
                            else if (this.state.config.language === 'de') defaultOutroText = "Vergessen Sie nicht zu abonnieren, zu liken und zu teilen.";
                            else if (this.state.config.language === 'es') defaultOutroText = "No olvides suscribirte, dar me gusta y compartir.";
                            else if (this.state.config.language === 'ar') defaultOutroText = "لا تنس الاشتراك والإعجاب والمشاركة.";
                            else if (this.state.config.language === 'ru') defaultOutroText = "Не забудьте подписаться, поставить лайк.";
                        }
                        extraAudioPromises.push(MediaSynthesisService.generateAudio(`${quotePrefix}${defaultOutroText}`, this.state.preferences.narratorVoice).then(res => { this.state.assets.outroAudio = res; }));
                    }
                }
                await Promise.all(extraAudioPromises);
                const imgCount = this.state.assets.images.filter(Boolean).length;
                const audCount = this.state.assets.audio.filter(Boolean).length;
                addSystemLog(`ASSETS tamamlandı: ${imgCount}/${this.state.script.videoSlides.length} görsel, ${audCount}/${this.state.script.videoSlides.length} ses.`, imgCount === this.state.script.videoSlides.length ? 'success' : 'warn');
                this.state.status = 'READY_TO_RENDER';
                await AssetManagerService.saveJobState(this.state);
            }
            if (this.state.status === 'READY_TO_RENDER') {
                addSystemLog('=== RENDER PHASE ===', 'info', null, {
                    totalSlides: this.state.script.videoSlides?.length || 0,
                    audioCount: (this.state.assets.audio || []).filter(Boolean).length,
                    imageCount: (this.state.assets.images || []).filter(Boolean).length,
                    hasThumbnail: !!this.state.assets.thumbnail,
                    hasThumbnailAudio: !!this.state.assets.thumbnailAudio,
                    hasSonSozAudio: !!this.state.assets.sonSozAudio,
                    hasOutroAudio: !!this.state.assets.outroAudio,
                    bgmId: this.state.script._bgmId || 'none',
                    canvasSize: canvasRef.current ? `${canvasRef.current.width}x${canvasRef.current.height}` : 'unknown'
                });
                await this.updateProgress(80, 'Video Paketleniyor...', 'RENDER');
                                addSystemLog('Render başlatılıyor: ' + (this.state.script.videoSlides?.length || 0) + ' slayt, ' + ((this.state.assets.audio || []).filter(Boolean).length) + ' ses', 'info');
                const renderResult = await RenderWorkerService.executeRender(this.state, canvasRef.current, this.state.preferences);
                this.state.status = 'COMPLETED'; this.state.videoUrl = typeof renderResult === 'string' ? renderResult : renderResult.url;
                await AssetManagerService.saveJobState(this.state); await AssetManagerService.clearJob(this.jobId);
                sysEventBus.emit('WORKFLOW_STATE', { status: 'COMPLETED', job: this.state });
                try { exportWorkflowLog(this.state); } catch (e) { console.warn('Log export hatası:', e); }
                return this.state.videoUrl;
            }
        } catch (e) { this.state.status = 'FAILED'; this.state.error = e.message; await AssetManagerService.saveJobState(this.state); sysEventBus.emit('WORKFLOW_STATE', { status: 'FAILED', job: this.state }); throw e; }
    }
}

const VOICE_OPTIONS = [
    { id: 'Aoede', label: 'Aoede', gender: 'Female', age: 'Young', category: 'Corporate & Narration' },
    { id: 'Puck', label: 'Puck', gender: 'Male', age: 'Child', category: 'Anime & Animation' },
    { id: 'Kore', label: 'Kore', gender: 'Female', age: 'Middle-aged', category: 'Documentary' },
    { id: 'Charon', label: 'Charon', gender: 'Male', age: 'Elderly', category: 'Audiobooks & Novels' },
    { id: 'Zephyr', label: 'Zephyr', gender: 'Male', age: 'Young', category: 'Commercials & Trailers' },
    { id: 'Fenrir', label: 'Fenrir', gender: 'Male', age: 'Middle-aged', category: 'Games & RPG' },
    { id: 'Leda', label: 'Leda', gender: 'Female', age: 'Middle-aged', category: 'Corporate & Narration' },
    { id: 'Orus', label: 'Orus (Erkek - Resmi)', gender: 'Male', age: 'Middle-aged', category: 'Documentary' }
];

// Kelimesi Kelimesine modu için otomatik ses seçimi
// 3 mod: erkek+kadın karışık, hepsi erkek, hepsi kadın
const getAutoVoice = (slideIndex, totalSlides) => {
    const maleVoices = ['Charon', 'Zephyr', 'Fenrir', 'Orus'];
    const femaleVoices = ['Aoede', 'Kore', 'Leda'];
    
    // Rastgele bir mod seç (tüm slideshow için sabit)
    // 0: erkek+kadın karışık, 1: hepsi erkek, 2: hepsi kadın
    const mode = Math.floor(Math.random() * 3);
    
    if (mode === 0) {
        // Erkek+kadın karışık — her sahne sırayla
        const allVoices = [...maleVoices, ...femaleVoices];
        return allVoices[slideIndex % allVoices.length];
    } else if (mode === 1) {
        // Hepsı erkek
        return maleVoices[slideIndex % maleVoices.length];
    } else {
        // Hepsi kadın
        return femaleVoices[slideIndex % femaleVoices.length];
    }
};

const CustomSelect = ({ value, onChange, options, icon: Icon, className }) => {
    const [isOpen, setIsOpen] = useState(false); const ref = useRef(null);
    useEffect(() => { const handleClickOutside = (event) => { if (ref.current && !ref.current.contains(event.target)) setIsOpen(false); }; document.addEventListener("mousedown", handleClickOutside); return () => document.removeEventListener("mousedown", handleClickOutside); }, []);
    const getSelectedLabel = () => { for (const opt of options) { if (opt.options) { const found = opt.options.find(o => o.value === value); if (found) return found.label; } else if (opt.value === value) return opt.label; } return value; };
    const getSelectedColor = () => { for (const opt of options) { if (opt.options) { const found = opt.options.find(o => o.value === value); if (found?.color) return found.color; } else if (opt.value === value && opt.color) return opt.color; } return 'text-white'; };
    return (
        <div ref={ref} className={`relative flex items-center w-full ${className || ''}`} onClick={() => setIsOpen(!isOpen)}>
            {Icon && <Icon size={18} className="text-indigo-400 shrink-0 mr-3" />}
            <div className={`flex-1 flex items-center justify-between text-sm font-bold cursor-pointer truncate ${getSelectedColor()}`}>
                <span className="truncate pr-2">{getSelectedLabel()}</span>
                <ChevronDown size={16} className={`transition-transform shrink-0 ${isOpen ? 'rotate-180' : ''} text-slate-400`} />
            </div>
            {isOpen && (
                <div className="absolute top-full left-0 w-full mt-2 bg-slate-900 border border-slate-700 rounded-lg shadow-2xl z-[200] max-h-64 overflow-y-auto py-1">
                    {options.map((opt, idx) => {
                        if (opt.options) {
                            return (<div key={idx}>{opt.label && <div className="px-3 py-1.5 text-[10px] text-slate-500 font-bold uppercase tracking-wider">{opt.label}</div>}{opt.options.map(subOpt => (<div key={subOpt.value} className={`px-3 py-2 text-sm cursor-pointer transition-colors ${value === subOpt.value ? 'bg-blue-600 text-white' : `hover:bg-blue-600 hover:text-white ${subOpt.color || 'text-slate-200'}`}`} onClick={(e) => { e.stopPropagation(); onChange(subOpt.value); setIsOpen(false); }}>{subOpt.label}</div>))}</div>);
                        }
                        return (<div key={opt.value} className={`px-3 py-2 text-sm cursor-pointer transition-colors ${value === opt.value ? 'bg-blue-600 text-white' : `hover:bg-blue-600 hover:text-white ${opt.color || 'text-slate-200'}`}`} onClick={(e) => { e.stopPropagation(); onChange(opt.value); setIsOpen(false); }}>{opt.label}</div>);
                    })}
                </div>
            )}
        </div>
    );
};

// ============================================================================
// MAIN APP — VOLUME MIXER & REFERENCE IMAGE SECTIONS REMOVED
// ============================================================================
export default function App() {
    const [user, setUser] = useState(null);
    const [authExpired, setAuthExpired] = useState(false);
    const isLoadedRef = useRef(false);
    const logEndRef = useRef(null);
    const musicFileInputRef = useRef(null);

    const [activeTab, setActiveTab] = useState(() => { const saved = SafeStorage.getItem('ns_activeTab'); return saved === 'image' ? 'media' : (saved || 'media'); });
    const [textInput, setTextInput] = useState(() => SafeStorage.getItem('ns_textInput') || '');

    // === GAZETE TAKİP STATE ===
    const [gazeteItems, setGazeteItems] = useState([]);           // gazete manşet listesi
    const [gazeteLoading, setGazeteLoading] = useState(false);    // yükleme durumu
    const [gazeteError, setGazeteError] = useState('');            // hata mesajı
    const [gazeteCropModal, setGazeteCropModal] = useState(null); // {src, name} — crop açık mı
    const [gazeteSource, setGazeteSource] = useState('gazeteoku'); // kaynak site
    const gazeteCanvasRef = useRef(null);                          // crop canvas ref

    const [config, setConfig] = useState(() => {
        const savedConfig = JSON.parse(SafeStorage.getItem('ns_config')) || {};
        return { duration: '30', aspectRatio: '9:16', videoStyle: 'cinematic', fontStyle: 'modern', imageStyle: 'watercolor', language: 'tr', subtitles: 'on', resolution: '4K', transition: 'none', outputType: 'video', analysisMode: 'yorumsuz', videoFormat: 'mp4', tip: 'haber', sourceName: '', yorum: '', ...savedConfig };
    });

    const [prefs, setPrefs] = useState(() => {
        const savedPrefs = JSON.parse(SafeStorage.getItem('ns_prefs')) || {};
        return { narratorVoice: 'Charon', narratorVolume: 0.8, backgroundMusicVolume: 0.3, ambientSound: 'none', customBgMusicName: '', customBgMusicId: '', ...savedPrefs };
    });

    const [voiceFilters, setVoiceFilters] = useState(() => { const saved = JSON.parse(SafeStorage.getItem('ns_voiceFilters')) || {}; return { gender: 'Any', age: 'Any', category: 'Any', ...saved }; });
    const [showFilters, setShowFilters] = useState(false);
    const [sysLogs, setSysLogs] = useState([]);
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    const [pendingJob, setPendingJob] = useState(null);
    const [isDragging, setIsDragging] = useState(false);

    const filteredVoices = VOICE_OPTIONS.filter(v => {
        if (voiceFilters.gender !== 'Any' && v.gender !== voiceFilters.gender) return false;
        if (voiceFilters.age !== 'Any' && v.age !== voiceFilters.age) return false;
        if (voiceFilters.category !== 'Any' && v.category !== voiceFilters.category) return false;
        return true;
    });

    useEffect(() => { if (filteredVoices.length > 0 && !filteredVoices.find(v => v.id === prefs.narratorVoice)) setPrefs(p => ({ ...p, narratorVoice: filteredVoices[0].id })); }, [voiceFilters]);

    const [uiState, setUiState] = useState({ isProcessing: false, statusText: '', percent: 0, error: '', videoUrl: null, showDevMenu: false, selectedMediaFiles: [] });

    const [studioMedia, setStudioMedia] = useState({ outroUrl: null, musicLoaded: false, musicName: '', musicId: '', musicList: [], customSceneImages: [], isLoading: true, statusMsg: 'Bulut Kontrol Ediliyor...', syncedFolderName: '' });
    const [musicSearchQuery, setMusicSearchQuery] = useState('');

    const canvasRef = useRef(null);
    const workflowRef = useRef(new WorkflowCoordinator());
    const _previewAudioRef = useRef(null); // Müzik önizleme için audio ref

    const getTargetSeconds = (dur) => { if (dur === 'unlimited') return 0; if (dur === '15') return 30; if (dur === '30') return 60; if (dur === '60') return 90; if (dur === '90') return 120; return 60; };
    const targetSecUI = getTargetSeconds(config.duration);
    const maxWordsUI = config.duration === 'unlimited' ? 'Sınırsız' : Math.floor((targetSecUI - 1.5) * getWPS(config.language));

    const ambientOptions = [
        { value: 'none', label: '🔇 Arka Ses Yok', color: 'text-slate-300' },
        { label: 'Atmosfer', options: [
            { value: 'rain', label: '🌧️ Yağmur', color: 'text-blue-300' },
            { value: 'wind', label: '🌬️ Rüzgar', color: 'text-slate-300' },
            { value: 'waves', label: '🌊 Dalgalar', color: 'text-cyan-300' },
            { value: 'fire', label: '🔥 Şömine', color: 'text-orange-300' },
        ]}
    ];
    // Yerel müzikler (IndexedDB'den)
    const filteredMusicList = studioMedia.musicList.filter(m => !musicSearchQuery || m.name.toLowerCase().includes(musicSearchQuery.toLowerCase()));
    if (filteredMusicList.length > 0) ambientOptions.push({ label: 'Müziklerim', options: filteredMusicList.map(m => ({ value: m.id, label: `🎵 ${m.name.replace(/\.[^.]+$/, '')}`, color: 'text-violet-400' })) });

    const voiceOptions = [
        { value: 'none', label: '🔇 Ses Yok', color: 'text-rose-400 font-bold' },
        ...filteredVoices.map(v => ({ value: v.id, label: v.label }))
    ];
    if (filteredVoices.length === 0) voiceOptions.push({ value: '', label: 'Kriter Uyumsuz', color: 'text-slate-500' });

    const SOCIAL_PLATFORMS = [
        { id: 'x', name: 'X (Twitter)', color: '#1DA1F2', loginUrl: 'https://x.com/login', shareUrl: 'https://x.com/intent/post' },
        { id: 'linkedin', name: 'LinkedIn', color: '#0A66C2', loginUrl: 'https://www.linkedin.com/login', shareUrl: 'https://www.linkedin.com/feed/compose/' },
        { id: 'facebook', name: 'Facebook', color: '#1877F2', loginUrl: 'https://www.facebook.com/login', shareUrl: 'https://www.facebook.com/sharer/sharer.php' },
        { id: 'instagram', name: 'Instagram', color: '#E4405F', loginUrl: 'https://www.instagram.com/accounts/login/', shareUrl: 'https://www.instagram.com/' },
        { id: 'tiktok', name: 'TikTok', color: '#000000', loginUrl: 'https://www.tiktok.com/login', shareUrl: 'https://www.tiktok.com/' },
        { id: 'pinterest', name: 'Pinterest', color: '#BD081C', loginUrl: 'https://pinterest.com/login/', shareUrl: 'https://pinterest.com/pin/create/button/' },
        { id: 'bluesky', name: 'Bluesky', color: '#0085FF', loginUrl: 'https://bsky.app/', shareUrl: 'https://bsky.app/' }
    ];
    const [connectedPlatforms, setConnectedPlatforms] = useState(() => {
        const saved = JSON.parse(SafeStorage.getItem('ns_connectedPlatforms')) || {};
        return saved;
    });
    const [shareTargets, setShareTargets] = useState(() => {
        const saved = JSON.parse(SafeStorage.getItem('ns_shareTargets')) || {};
        return saved;
    });
    const [showSharePanel, setShowSharePanel] = useState(false);
    const [copiedField, setCopiedField] = useState('');
    const copyToClipboard = async (text, fieldName) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedField(fieldName);
            addSystemLog(`${fieldName} panoya kopyalandı!`, 'success');
            setTimeout(() => setCopiedField(''), 2000);
        } catch (e) {
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            setCopiedField(fieldName);
            addSystemLog(`${fieldName} panoya kopyalandı!`, 'success');
            setTimeout(() => setCopiedField(''), 2000);
        }
    };
    const togglePlatform = (platformId) => {
        setConnectedPlatforms(prev => {
            const next = { ...prev, [platformId]: !prev[platformId] };
            SafeStorage.setItem('ns_connectedPlatforms', JSON.stringify(next));
            if (!next[platformId]) setShareTargets(prev => { const n = { ...prev }; delete n[platformId]; SafeStorage.setItem('ns_shareTargets', JSON.stringify(n)); return n; });
            return next;
        });
    };
    const toggleShareTarget = (platformId) => {
        setShareTargets(prev => {
            const next = { ...prev, [platformId]: !prev[platformId] };
            SafeStorage.setItem('ns_shareTargets', JSON.stringify(next));
            return next;
        });
    };
    const openPlatformConnect = (platform) => {
        const popup = window.open(platform.loginUrl, platform.name, 'width=600,height=700,scrollbars=yes');
        addSystemLog(`${platform.name} giriş sayfası açıldı. Oturum açın, otomatik olarak bağlanacaksınız.`, 'info');
        const checker = setInterval(() => {
            try {
                if (popup.closed) {
                    clearInterval(checker);
                    togglePlatform(platform.id);
                    addSystemLog(`${platform.name} bağlantısı tamamlandı!`, 'success');
                }
            } catch (e) { clearInterval(checker); }
        }, 800);
    };

    // Seçili platformlarda sıralı paylaşım (popup blocker azaltır)
    const shareToSelectedPlatforms = async () => {
        const title = workflowRef.current?.state?.script?.thumbnailText || 'Video';
        // Hiç platform seçilmemişse hepsini paylaş
        const hasSelection = Object.values(shareTargets).some(v => v);
        const selected = hasSelection 
            ? SOCIAL_PLATFORMS.filter(p => shareTargets[p.id])
            : SOCIAL_PLATFORMS;
        
        if (selected.length === 0) { 
            addSystemLog("Paylaşılacak platform bulunamadı!", 'warn'); 
            return; 
        }
        
        addSystemLog(`${selected.length} platformda paylaşım açılıyor...`, 'info');
        
        for (let i = 0; i < selected.length; i++) {
            const platform = selected[i];
            let url = '';
            
            // blob URL paylaşılamaz, sadece başlık paylaşılır
            if (platform.id === 'x') 
                url = `https://x.com/intent/post?text=${encodeURIComponent(title)}`;
            else if (platform.id === 'linkedin') {
                url = `https://www.linkedin.com/feed/compose/?text=${encodeURIComponent(title)}`;
            }
            else if (platform.id === 'pinterest') 
                url = `https://pinterest.com/pin/create/button/?description=${encodeURIComponent(title)}`;
            else if (platform.id === 'bluesky') 
                url = `https://bsky.app/intent/compose?text=${encodeURIComponent(title)}`;
            else if (platform.id === 'facebook') 
                url = `https://www.facebook.com/sharer/sharer.php?quote=${encodeURIComponent(title)}`;
            else if (platform.id === 'instagram') 
                url = 'https://www.instagram.com/';
            else if (platform.id === 'tiktok') 
                url = 'https://www.tiktok.com/upload';
            
            if (url) {
                window.open(url, platform.name, 'width=700,height=700');
                if (i < selected.length - 1) await new Promise(r => setTimeout(r, 500));
            }
        }
        
        addSystemLog(`${selected.length} platform açıldı. Videoyu manuel olarak yükleyin.`, 'success');
    };

    // Linki clipboard'a kopyala (sadece başlık, blob URL paylaşılamaz)
    // Otomatik video kaydetme (direk indirme, dosya adı = haber başlığı)
    const autoSaveVideo = async (videoUrl, title, videoFormat) => {
        if (!videoUrl || !videoUrl.startsWith('blob:')) {
            addSystemLog('Geçersiz video URL, kaydetme atlandı.', 'warn');
            return;
        }

        addSystemLog('Video kaydediliyor...', 'info');

        try {
            const response = await fetch(videoUrl);
            const blob = await response.blob();
            // Uzantı: config'deki videoFormat tercih et, yoksa blob type'dan algıla
            const ext = videoFormat === 'mp4' ? '.mp4' : (blob.type.includes('mp4') ? '.mp4' : '.webm');
            const safeName = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "_").toLowerCase();
            const fileName = `${safeName}${ext}`;

            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(a.href);
            addSystemLog(`Video indirildi: ${fileName}`, 'success');
        } catch (e) {
            addSystemLog('Video indirme hatası: ' + e.message, 'error');
        }
    };

    const copyShareLink = async () => {
        const title = workflowRef.current?.state?.script?.thumbnailText || 'Video';
        try {
            await navigator.clipboard.writeText(title);
            addSystemLog('Başlık panoya kopyalandı!', 'success');
        } catch (e) {
            const textarea = document.createElement('textarea');
            textarea.value = title;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            addSystemLog('Başlık panoya kopyalandı!', 'success');
        }
    };

    // Native share (mobilde cihaz paylaşımı - sadece başlık)
    const nativeShare = async () => {
        const title = workflowRef.current?.state?.script?.thumbnailText || 'Video';
        try {
            await navigator.share({ title: title, text: title });
            addSystemLog('Paylaşım tamamlandı!', 'success');
        } catch (e) {
            if (e.name !== 'AbortError') addSystemLog('Paylaşım hatası: ' + e.message, 'error');
        }
    };

    const shareToPlatform = async (platform, title, videoUrl) => {
        let url = '';
        if (platform.id === 'x') { url = `https://x.com/intent/post?text=${encodeURIComponent(title + ' ' + videoUrl)}`; }
        else if (platform.id === 'linkedin') {
            url = `https://www.linkedin.com/feed/compose/?text=${encodeURIComponent(title)}`;
        }
        else if (platform.id === 'facebook') { url = `https://www.facebook.com/sharer/sharer.php?quote=${encodeURIComponent(title)}&u=${encodeURIComponent(videoUrl)}`; }
        else if (platform.id === 'pinterest') { url = `https://pinterest.com/pin/create/button/?url=${encodeURIComponent(videoUrl)}&description=${encodeURIComponent(title)}`; }
        else if (platform.id === 'tiktok') { url = 'https://www.tiktok.com/upload'; }
        else if (platform.id === 'instagram') { url = 'https://www.instagram.com/'; }
        else if (platform.id === 'bluesky') { url = `https://bsky.app/intent/compose?text=${encodeURIComponent(title + ' ' + videoUrl)}`; }
        if (url) window.open(url, '_blank', 'width=700,height=700');
    };

    useEffect(() => { SafeStorage.setItem('ns_activeTab', activeTab); }, [activeTab]);
    useEffect(() => { SafeStorage.setItem('ns_textInput', textInput); }, [textInput]);
    useEffect(() => { SafeStorage.setItem('ns_config', JSON.stringify(config)); }, [config]);
    useEffect(() => { SafeStorage.setItem('ns_prefs', JSON.stringify(prefs)); }, [prefs]);
    useEffect(() => { SafeStorage.setItem('ns_voiceFilters', JSON.stringify(voiceFilters)); }, [voiceFilters]);

    useEffect(() => { let interval; if (uiState.isProcessing) { setElapsedSeconds(0); const start = performance.now(); interval = setInterval(() => { setElapsedSeconds(((performance.now() - start) / 1000).toFixed(1)); }, 100); } else clearInterval(interval); return () => clearInterval(interval); }, [uiState.isProcessing]);

    useEffect(() => {
        sysEventBus.on('SYS_LOG_ADD', (log) => setSysLogs(prev => [...prev, log]));
        sysEventBus.on('SYS_LOG_CLEAR', () => sysEventBus.emit('SYS_LOG_CLEAR_DONE'));
        sysEventBus.on('SYS_LOG_CLEAR_DONE', () => setSysLogs([]));
        sysEventBus.on('PROGRESS', (data) => { const p = Math.min(100, Math.max(0, Math.round(data.percent || 0))); setUiState(prev => ({ ...prev, percent: p, statusText: data.text || prev.statusText })); });
        sysEventBus.on('WORKFLOW_STATE', (data) => {
            if (data.status === 'FAILED') setUiState(prev => ({ ...prev, isProcessing: false, error: data.job.error }));
            if (data.status === 'COMPLETED') {
                setUiState(prev => ({ ...prev, isProcessing: false, percent: 100, statusText: 'Tamamlandı!', videoUrl: data.job.videoUrl }));
                // Otomatik kaydet: İndirilenler klasörüne videoyu kaydet
                autoSaveVideo(data.job.videoUrl, data.job.script?.thumbnailText || 'video', data.job.config?.videoFormat);
                // Otomatik LinkedIn paylaşımı (compose URL ile)
                const _autoLinkedInShare = async () => {
                    const title = data.job.script?.thumbnailText || data.job.script?.title || 'Yeni Haber';
                    addSystemLog('LinkedIn compose sayfası açılıyor...', 'info');
                    window.open(`https://www.linkedin.com/feed/compose/?text=${encodeURIComponent(title)}`, 'LinkedIn', 'width=700,height=700');
                };
                _autoLinkedInShare();
                // Otomatik geçiş kaldırıldı — kullanıcı YouTube bilgilerini kopyaladıktan sonra "YENİ HABER" butonuna basar
            }
        });
        sysEventBus.on('AUTH_EXPIRED', () => setAuthExpired(true));
    }, []);

    useEffect(() => { if (logEndRef.current) logEndRef.current.scrollIntoView({ behavior: 'smooth' }); }, [sysLogs]);

    useEffect(() => {
        const loadLocalMusic = async () => {
            try {
                // Sunucu otomatik algılama
                const detectedUrl = await getMusicProxyUrl();
                if (detectedUrl) addSystemLog(`Sunucu bulundu: ${detectedUrl}`, 'success');
                else addSystemLog('Müzik proxy sunucusu bulunamadı — CORS proxy kullanılacak', 'warn');


                const allMusic = await AssetManagerService.getAllMusicFromLib();
                // Yerel hardcode müzik klasöründen de yükle
                let localFiles = [];
                try {
                    const resp = await fetch('/api/music/list');
                    const data = await resp.json();
                    if (data.files && data.files.length > 0) {
                        localFiles = data.files.map(f => ({ ...f, data: '/api/music/file/' + encodeURIComponent(f.file), isLocalServer: true }));
                    }
                } catch (e) { console.warn('[Music] Local server fetch failed:', e.message); }
                const combinedMusic = [...allMusic, ...localFiles];
                setStudioMedia(s => ({ ...s, musicList: combinedMusic, isLoading: false, statusMsg: 'Yerel Mod' }));
                if (allMusic.length > 0) {
                    addSystemLog(`${allMusic.length} müzik IndexedDB'den yüklendi.`, 'success');
                }
                if (localFiles.length > 0) {
                    addSystemLog(`${localFiles.length} müzik C:\\Users\\skese\\Downloads\\Muzik klasöründen yüklendi.`, 'success');
                }
                if (allMusic.length === 0 && localFiles.length === 0) {
                    addSystemLog("Müzik kütüphanesi boş. Klasör seçerek müzik ekleyin.", 'info');
                }
                const savedPrefs = JSON.parse(SafeStorage.getItem('ns_prefs')) || {};
                if (savedPrefs.ambientSound && !['none', 'rain', 'wind', 'waves', 'fire'].includes(savedPrefs.ambientSound)) {
                    const track = allMusic.find(m => m.id === savedPrefs.ambientSound);
                    if (track && track.data) {
                        const raw = track.data.includes(',') ? track.data.split(',')[1] : track.data;
                        const byteString = atob(raw);
                        const ab = new ArrayBuffer(byteString.length);
                        const ia = new Uint8Array(ab);
                        for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
                        const blob = new Blob([ab], { type: 'audio/mpeg' });
                        const url = URL.createObjectURL(blob);
                        await AssetManagerService.saveMedia('CUSTOM_MUSIC', url);
                    }
                }
                const savedDir = await AssetManagerService.getDirHandle();
                if (savedDir && savedDir.handle) {
                    try {
                        const permission = await savedDir.handle.requestPermission({ mode: 'read' });
                        if (permission === 'granted') {
                            addSystemLog(`Otomatik müzik senkronizasyonu: ${savedDir.name}`, 'info');
                            const currentMusic = await AssetManagerService.getAllMusicFromLib();
                            const newCount = await syncMusicFromDir(savedDir.handle, currentMusic);
                            if (newCount > 0) {
                                const updated = await AssetManagerService.getAllMusicFromLib();
                                setStudioMedia(s => ({ ...s, musicList: updated }));
                                addSystemLog(`${newCount} yeni müzik otomatik eklendi. Toplam: ${updated.length}`, 'success');
                            }
                        }
                    } catch (e) {
                        console.warn("Otomatik senkronizasyon hatası:", e);
                    }
                }
            } catch (e) { setStudioMedia(s => ({ ...s, isLoading: false, statusMsg: 'Yerel Mod' })); }
        };
        loadLocalMusic();
    }, []);

    const saveToFirestore = async (updates) => { if (!user || !isFirebaseActive) return; try { await setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'user_assets', 'main'), updates, { merge: true }); } catch (error) { if (!error.message?.includes('offline')) console.warn("Firestore kayıt hatası"); } };
    const uploadChunks = async (prefix, b64Data) => { if (!user || !isFirebaseActive) return 0; const chunkSize = 800000; const chunksCount = Math.ceil(b64Data.length / chunkSize); try { for (let i = 0; i < chunksCount; i++) { await setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'asset_chunks', `${prefix}_${i}`), { data: b64Data.substring(i * chunkSize, (i + 1) * chunkSize), index: i }); } return chunksCount; } catch (e) { return 0; } };
    const downloadChunks = async (prefix, chunksCount) => { if (!user || !isFirebaseActive) return null; let b64Data = ""; try { for (let i = 0; i < chunksCount; i++) { let chunkSnap = await getDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'asset_chunks', `${prefix}_${i}`)); if (!chunkSnap.exists()) chunkSnap = await getDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'music_chunks', `${prefix}_${i}`)); if (chunkSnap.exists()) b64Data += chunkSnap.data().data; else return null; } return b64Data; } catch (e) { return null; } };

    useEffect(() => {
        if (!isFirebaseActive) { return; }
        const initAuth = async () => { try { if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) await signInWithCustomToken(auth, __initial_auth_token); else await signInAnonymously(auth); } catch (e) { console.warn('[Auth] Sign-in failed:', e.message); } };
        initAuth();
        const unsubAuth = onAuthStateChanged(auth, async (u) => {
            setUser(u);
            if (u && !isLoadedRef.current) {
                try { const snap = await getDoc(doc(db, 'artifacts', appId, 'users', u.uid, 'user_assets', 'settings')); if (snap.exists()) { const d = snap.data(); if (d.config) setConfig(c => ({ ...c, ...d.config })); if (d.prefs) { if (!d.prefs.ambientSound) d.prefs.ambientSound = d.selectedBgmId || 'none'; setPrefs(p => ({ ...p, ...d.prefs })); } if (d.voiceFilters) setVoiceFilters(f => ({ ...f, ...d.voiceFilters })); if (d.activeTab) setActiveTab(d.activeTab); if (d.textInput) setTextInput(d.textInput); } } catch (e) { }
                isLoadedRef.current = true;
            }
        });
        return () => unsubAuth();
    }, []);

    useEffect(() => {
        if (!user || !isFirebaseActive || !isLoadedRef.current) return;
        const timer = setTimeout(() => { try { setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'user_assets', 'settings'), { config, prefs, voiceFilters, activeTab, textInput, lastUpdated: Date.now() }, { merge: true }).catch(e => console.warn('[Firestore] Settings save failed:', e.message)); } catch (e) { console.warn('[Firestore] Settings save error:', e.message); } }, 800);
        return () => clearTimeout(timer);
    }, [config, prefs, voiceFilters, activeTab, textInput, user]);

    useEffect(() => {
        if (!user || !isFirebaseActive) { setStudioMedia(s => ({ ...s, isLoading: false, statusMsg: 'Yerel Mod' })); return; }
        const preloadLocal = async () => {
            const localOutro = await AssetManagerService.loadMedia('CUSTOM_OUTRO');
            const csi = [];
            for (let i = 0; i < 10; i++) { const img = await AssetManagerService.loadMedia("CUSTOM_SCENE_IMG_" + i); if (img) csi.push(img); }
            const allMusics = await AssetManagerService.getAllMusicFromLib();
            const savedDir = await AssetManagerService.getDirHandle();
            setStudioMedia(s => ({ ...s, outroUrl: s.outroUrl || localOutro, musicList: s.musicList.length > 0 ? s.musicList : allMusics, customSceneImages: csi, isLoading: false, statusMsg: localOutro ? 'Yerel Bellek Aktif' : s.statusMsg, syncedFolderName: savedDir?.name || '' }));
            if (savedDir && savedDir.handle) {
                try {
                    const permission = await savedDir.handle.requestPermission({ mode: 'read' });
                    if (permission === 'granted') {
                        addSystemLog(`Otomatik müzik senkronizasyonu: ${savedDir.name}`, 'info');
                        const newCount = await syncMusicFromDir(savedDir.handle, allMusics);
                        if (newCount > 0) {
                            const updated = await AssetManagerService.getAllMusicFromLib();
                            setStudioMedia(s => ({ ...s, musicList: updated }));
                            addSystemLog(`${newCount} yeni müzik otomatik eklendi. Toplam: ${updated.length}`, 'success');
                        } else {
                            addSystemLog(`Müzikler senkronize. Toplam: ${allMusics.length}`, 'success');
                        }
                    } else {
                        addSystemLog("Klasör izni yenilenemedi, elle seçim gerekiyor.", 'warn');
                        await AssetManagerService.removeDirHandle();
                    }
                } catch (e) {
                    console.warn("Otomatik senkronizasyon hatası:", e);
                    addSystemLog("Otomatik senkronizasyon başarısız.", 'warn');
                }
            }
        };
        preloadLocal();
        const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'user_assets', 'main');
        const unsubscribe = onSnapshot(docRef, async (snap) => {
            if (snap.exists()) {
                const data = snap.data();
                let updates = {};
                // Müzik listesini SADECE yerelde müzik yoksa Firebase'den yükle (overwrite önleme)
                const localMusicCount = (await AssetManagerService.getAllMusicFromLib()).length;
                if (localMusicCount === 0 && data.bgmList && data.bgmList.length > 0) {
                    updates.musicList = data.bgmList;
                    addSystemLog(`Firebase'den ${data.bgmList.length} müzik senkronize edildi.`, 'info');
                }
                let localOutro = await AssetManagerService.loadMedia('CUSTOM_OUTRO');
                if (data.outroChunksCount) { if (!localOutro) { localOutro = await downloadChunks('outro', data.outroChunksCount); if (localOutro) await AssetManagerService.saveMedia('CUSTOM_OUTRO', localOutro); } updates.outroUrl = localOutro; }
                else if (data.backCover) { updates.outroUrl = data.backCover; if (!localOutro) await AssetManagerService.saveMedia('CUSTOM_OUTRO', data.backCover); }
                else if (data.outroChunksCount === null || data.backCover === null) { updates.outroUrl = null; await AssetManagerService.deleteMedia('CUSTOM_OUTRO'); }
                else updates.outroUrl = localOutro;
                if (data.selectedBgmId) { const trackList = updates.musicList || (await AssetManagerService.getAllMusicFromLib()); const track = trackList.find(m => m.id === data.selectedBgmId); if (track) { let localMusic = await AssetManagerService.getMusicFromLib(data.selectedBgmId); if (!localMusic && track.chunksCount) { const cloudData = await downloadChunks(track.id, track.chunksCount); if (cloudData) { localMusic = { id: track.id, name: track.name, data: cloudData }; await AssetManagerService.saveMusicToLib(localMusic); } } if (localMusic) { await AssetManagerService.saveMedia('CUSTOM_MUSIC', localMusic.data); updates.musicLoaded = true; updates.musicName = track.name; updates.musicId = track.id; } } }
                else if (data.selectedBgmId === null) { updates.musicLoaded = false; updates.musicName = ''; updates.musicId = ''; await AssetManagerService.deleteMedia('CUSTOM_MUSIC'); }
                updates.isLoading = false; if (!updates.statusMsg || updates.statusMsg.includes('İndiriliyor')) updates.statusMsg = 'Bulutla Senkronize (Aktif)';
                setStudioMedia(s => ({ ...s, ...updates }));
            } else {
                const syncLocalToCloud = async () => { let updates = {}; const localOutro = await AssetManagerService.loadMedia('CUSTOM_OUTRO'); if (localOutro) updates.outroChunksCount = await uploadChunks('outro', localOutro); const db = await AssetManagerService.getDB(); const tx = db.transaction(LIB_STORE, 'readonly'); const req = tx.objectStore(LIB_STORE).getAll(); req.onsuccess = async () => { const allMusics = req.result || []; if (allMusics.length > 0) updates.bgmList = allMusics.map(m => ({ id: m.id, name: m.name, chunksCount: Math.ceil(m.data.length / 800000) })); const savedPrefs = JSON.parse(SafeStorage.getItem('ns_prefs')) || {}; if (savedPrefs.ambientSound && savedPrefs.ambientSound !== 'none') updates.selectedBgmId = savedPrefs.ambientSound; if (Object.keys(updates).length > 0) await setDoc(docRef, updates, { merge: true }); }; };
                syncLocalToCloud(); setStudioMedia(s => ({ ...s, isLoading: false, statusMsg: 'Yerel Bellek Senkronize' }));
            }
        }, () => setStudioMedia(s => ({ ...s, isLoading: false, statusMsg: 'Yerel Mod' })));
        return () => unsubscribe();
    }, [user]);

    const handleOutroUpload = async (e) => { const file = e.target.files?.[0]; if (!file) return; setStudioMedia(s => ({ ...s, isLoading: true, statusMsg: 'Kapak Yükleniyor...' })); const b64 = await NetworkUtils.compressImage(file); await AssetManagerService.saveMedia('CUSTOM_OUTRO', b64); const chunksCount = await uploadChunks('outro', b64); await saveToFirestore({ outroChunksCount: chunksCount, backCover: null }); setStudioMedia(s => ({ ...s, outroUrl: b64, isLoading: false, statusMsg: 'Bulutla Senkronize' })); };
    const handleOutroDelete = async () => { await AssetManagerService.deleteMedia('CUSTOM_OUTRO'); setStudioMedia(s => ({ ...s, outroUrl: null })); await saveToFirestore({ outroChunksCount: null, backCover: null }); };
    const handleCustomSceneImagesUpload = async (e) => { const files = Array.from(e.target.files); if (!files.length) return; const availableSlots = 10 - (studioMedia.customSceneImages?.length || 0); const filesToProcess = files.slice(0, availableSlots); const newB64s = []; for (let file of filesToProcess) { if (file.type.startsWith('image/')) { const b64 = await NetworkUtils.compressImage(file); newB64s.push(b64); } } const updatedImages = [...(studioMedia.customSceneImages || []), ...newB64s].slice(0, 10); for (let i = 0; i < updatedImages.length; i++) await AssetManagerService.saveMedia("CUSTOM_SCENE_IMG_" + i, updatedImages[i]); setStudioMedia(s => ({ ...s, customSceneImages: updatedImages })); const newMediaFiles = newB64s.map((b64, i) => ({ name: `SabitGorsel_${Date.now()}_${i}.jpg`, type: 'image/jpeg', data: b64 })); if (newMediaFiles.length > 0) setUiState(prev => ({ ...prev, selectedMediaFiles: [...prev.selectedMediaFiles, ...newMediaFiles] })); e.target.value = null; };
    const handleCustomSceneImageDelete = async (idx) => { const updated = studioMedia.customSceneImages.filter((_, i) => i !== idx); for (let i = 0; i < 10; i++) await AssetManagerService.deleteMedia("CUSTOM_SCENE_IMG_" + i); for (let i = 0; i < updated.length; i++) await AssetManagerService.saveMedia("CUSTOM_SCENE_IMG_" + i, updated[i]); setStudioMedia(s => ({ ...s, customSceneImages: updated })); };
    const deleteMusic = async () => { try { const as = prefs.ambientSound; if (as && !['none', 'rain', 'wind', 'waves', 'fire'].includes(as)) { const oldUrl = await AssetManagerService.loadMedia('CUSTOM_MUSIC'); if (oldUrl && oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl); await AssetManagerService.deleteMedia('CUSTOM_MUSIC'); await AssetManagerService.removeMusicFromLib(as); const updatedList = studioMedia.musicList.filter(m => m.id !== as); await saveToFirestore({ bgmList: updatedList, selectedBgmId: null }); setPrefs(p => ({ ...p, ambientSound: 'none' })); } } catch (e) { console.warn('[Music] Delete failed:', e.message); } };
    const handleFolderSelect = async () => {
        if (musicFileInputRef.current) musicFileInputRef.current.click();
    };
    const handleFolderSelectLegacy = async (e) => {
        const files = Array.from(e.target.files);
        if (!files.length) return;
        const audioExts = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma'];
        const audioFiles = files.filter(f => audioExts.some(ext => f.name.toLowerCase().endsWith(ext)));
        if (!audioFiles.length) { addSystemLog("Seçilen dosyalarda ses dosyası bulunamadı.", "warn"); return; }
        addSystemLog(`${audioFiles.length} müzik dosyası bulundu, IndexedDB'ye kaydediliyor...`, 'info');
        let savedCount = 0;
        for (const file of audioFiles) {
            const id = "fm_" + file.name.replace(/[^a-zA-Z0-9]/g, '_') + "_" + file.size;
            const existing = await AssetManagerService.getMusicFromLib(id);
            if (existing) continue;
            const b64 = await NetworkUtils.fileToBase64(file);
            await AssetManagerService.saveMusicToLib({ id, name: file.name, data: b64 });
            savedCount++;
        }
        const allMusic = await AssetManagerService.getAllMusicFromLib();
        setStudioMedia(s => ({ ...s, musicList: [...allMusic] }));
        addSystemLog(`${savedCount} yeni müzik kaydedildi. Toplam: ${allMusic.length} müzik`, 'success');
        e.target.value = null;
    };
    const clearSyncedFolder = async () => {
        await AssetManagerService.removeDirHandle();
        setStudioMedia(s => ({ ...s, syncedFolderName: '' }));
        addSystemLog("Otomatik senkronizasyon kaldırıldı.", 'info');
    };
    // Müzik önizleme - 8 saniye çalar
    const playMusicPreview = (url) => {
        try {
            if (_previewAudioRef.current) { _previewAudioRef.current.pause(); _previewAudioRef.current = null; }
            const audio = new Audio(url);
            audio.volume = 0.5;
            _previewAudioRef.current = audio;
            audio.play().catch(() => {});
            setTimeout(() => { if (_previewAudioRef.current === audio) { audio.pause(); _previewAudioRef.current = null; } }, 8000);
        } catch (e) {}
    };

    const handleFolderMusicSelect = async (musicId) => {
        if (prefs.ambientSound === musicId) { setPrefs(p => ({ ...p, ambientSound: 'none' })); return; }
        // Local server müziği (C:\Users\skese\Downloads\Muzik)
        if (musicId.startsWith('local_')) {
            const track = studioMedia.musicList.find(m => m.id === musicId);
            if (!track || !track.data) { addSystemLog("Müzik bulunamadı", 'error'); return; }
            addSystemLog(`Müzik hazırlanıyor: ${track.name}`, 'info');
            const oldUrl = await AssetManagerService.loadMedia('CUSTOM_MUSIC');
            if (oldUrl && oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
            await AssetManagerService.saveMedia('CUSTOM_MUSIC', track.data);
            setPrefs(p => ({ ...p, ambientSound: musicId, customBgMusicName: track.name, customBgMusicId: musicId }));
            playMusicPreview(track.data);
            addSystemLog(`Müzik hazır: ${track.name}`, 'success');
            return;
        }
        // Yerel müzik seçildiyse (IndexedDB)
        const track = await AssetManagerService.getMusicFromLib(musicId);
        if (!track || !track.data) { addSystemLog("Müzik bulunamadı", 'error'); return; }
        addSystemLog(`Müzik hazırlanıyor: ${track.name}`, 'info');
        const oldUrl = await AssetManagerService.loadMedia('CUSTOM_MUSIC');
        if (oldUrl && oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
        const raw = track.data.includes(',') ? track.data.split(',')[1] : track.data;
        const byteString = atob(raw);
        const ab = new ArrayBuffer(byteString.length);
        const ia = new Uint8Array(ab);
        for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
        const blob = new Blob([ab], { type: 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        await AssetManagerService.saveMedia('CUSTOM_MUSIC', url);
        setPrefs(p => ({ ...p, ambientSound: musicId, customBgMusicName: track.name, customBgMusicId: musicId }));
        playMusicPreview(url); // Önizleme çal
        addSystemLog(`Müzik hazır: ${track.name}`, 'success');
    };
    const processSelectedFiles = async (files) => { if (!files || files.length === 0) return; if (files.length > 10) { setUiState(prev => ({ ...prev, error: "En fazla 10 dosya seçebilirsiniz." })); return; } const validFiles = files.filter(f => f.size <= 50 * 1024 * 1024); try { setUiState(prev => ({ ...prev, isProcessing: true, statusText: "Dosyalar işleniyor..." })); const processedFiles = await Promise.all(validFiles.map(async (file) => { const base64 = await NetworkUtils.fileToBase64(file); return { name: file.name, type: file.type, data: base64 }; })); setUiState(prev => ({ ...prev, selectedMediaFiles: processedFiles, error: '', isProcessing: false, statusText: "" })); } catch (error) { setUiState(prev => ({ ...prev, error: "Dosya okuma hatası.", isProcessing: false, statusText: "" })); } };
    const handleDragOver = (e) => { e.preventDefault(); e.stopPropagation(); };
    const handleDragEnter = (e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); };
    const handleDragLeave = (e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); };
    const handleDrop = (e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); processSelectedFiles(Array.from(e.dataTransfer.files)); };

    const handleExecuteStart = async (files = null, forceOutputType = null) => {
        sysEventBus.emit('SYS_LOG_CLEAR');
        const aCtx = _getAudioCtx(); if (aCtx.state === 'suspended') aCtx.resume().catch(() => {});
        const outType = forceOutputType || config.outputType; if (forceOutputType) setConfig(prev => ({ ...prev, outputType: forceOutputType }));
        setUiState(prev => ({ ...prev, isProcessing: true, percent: 0, statusText: 'Workflow Başlatılıyor...', error: '', videoUrl: null }));
        addSystemLog('İş akışı başlatıldı.', 'info');
        try {
            let inputData = textInput;
            let inputType = activeTab;
            const runConfig = { ...config, outputType: outType, customSceneImages: studioMedia.customSceneImages };
            if (config.tip === 'guzel_soz') {
                const targetFiles = files || uiState.selectedMediaFiles;
                if (textInput.trim()) {
                    inputData = textInput;
                    inputType = 'text';
                } else if (targetFiles && targetFiles.length > 0) {
                    inputData = targetFiles;
                    inputType = 'media';
                } else {
                    throw new Error("Güzel söz için metin veya resim girin.");
                }
            } else if (activeTab === 'media' || activeTab === 'gazete') {
                const targetFiles = files || uiState.selectedMediaFiles;
                if (targetFiles && targetFiles.length > 0) { inputData = targetFiles; inputType = 'media'; }
                else throw new Error("En az bir dosya seçin.");
            }
            await workflowRef.current.startWorkflow(inputData, inputType, runConfig, prefs, canvasRef, null, studioMedia.musicList);
        } catch (e) { addSystemLog(`Hata: ${e.message}`, 'error'); setUiState(prev => ({ ...prev, isProcessing: false, error: e.message })); }
    };

    const handleExecuteResume = async () => { const aCtx = _getAudioCtx(); if (aCtx.state === 'suspended') aCtx.resume().catch(() => {}); setUiState({ isProcessing: true, percent: workflowRef.current.state.progress || 0, statusText: 'Sürdürülüyor...', error: '', videoUrl: null, showDevMenu: uiState.showDevMenu }); addSystemLog('Workflow sürdürülüyor...', 'warn'); try { await workflowRef.current.resumeWorkflow(canvasRef); } catch (e) { addSystemLog(`Kurtarma hatası: ${e.message}`, 'error'); setUiState(prev => ({ ...prev, isProcessing: false, error: e.message })); } };

    const handleQuickReRender = async () => { const activeJob = workflowRef.current.state; if (!activeJob || !activeJob.script || activeJob.status !== 'COMPLETED') { setUiState(prev => ({ ...prev, error: "Önce video oluşturun." })); return; } setUiState(prev => ({ ...prev, isProcessing: true, percent: 10, statusText: 'Yeniden Paketleniyor...' })); addSystemLog("Hızlı yeniden paketleme...", "info"); try { const outputUrl = await RenderWorkerService.executeRender(activeJob, canvasRef.current, prefs); setUiState(prev => ({ ...prev, isProcessing: false, percent: 100, videoUrl: outputUrl })); addSystemLog("Tamamlandı!", "success"); } catch (err) { addSystemLog(`Hata: ${err.message}`, "error"); setUiState(prev => ({ ...prev, isProcessing: false, error: "Başarısız: " + err.message })); } };

    const handleSilentRecovery = async () => { setUiState(prev => ({ ...prev, isProcessing: true, statusText: "Oturum yenileniyor..." })); const success = await attemptSilentReauth(); if (success) { setAuthExpired(false); setUiState(prev => ({ ...prev, isProcessing: false, statusText: "" })); addSystemLog("Oturum tazelendi.", "success"); } else setUiState(prev => ({ ...prev, isProcessing: false, error: "Yenileme başarısız. F5 ile yenileyin." })); };

    // === GAZETE TAKİP FONKSİYONLARI ===

    // gazeteoku.com'dan manşetleri çek (CORS proxy ile)
    const fetchGazeteManşetleri = async () => {
        setGazeteLoading(true);
        setGazeteError('');
        setGazeteItems([]);
        try {
            const proxies = [
                (u) => 'https://corsproxy.io/?' + encodeURIComponent(u),
                (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
                (u) => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u),
            ];
            let html = '';
            // 1. Doğrudan fetch dene
            try {
                const r = await fetch('https://www.gazeteoku.com/gazeteler');
                if (r.ok) { const t = await r.text(); if (t.length > 5000 && !t.includes('Access Denied')) html = t; }
            } catch(e) {}
            // 2. CORS proxy ile dene
            if (!html) {
                for (const proxyFn of proxies) {
                    try {
                        const proxyUrl = proxyFn('https://www.gazeteoku.com/gazeteler');
                        const r = await fetch(proxyUrl);
                        if (r.ok) { const t = await r.text(); if (t.length > 5000 && !t.includes('Access Denied')) { html = t; break; } }
                    } catch(e) {}
                }
            }
            if (!html) throw new Error('Gazete manşetleri yüklenemedi. Ağ bağlantınızı kontrol edin.');
            // img etiketlerinden gazete bilgilerini çıkar
            const regex = /<img[^>]+(?:src="([^"]+)"[^>]+alt="([^"]+)"|alt="([^"]+)"[^>]+src="([^"]+)")/gi;
            const items = [];
            const seen = new Set();
            let match;
            while ((match = regex.exec(html)) !== null) {
                const src = (match[1] || match[4] || '').trim();
                const name = (match[2] || match[3] || '').trim();
                if (name.length > 2 && src && !seen.has(name) && src.includes('storage/files/images')) {
                    seen.add(name);
                    items.push({ name, src: src.startsWith('http') ? src : 'https://i.gazeteoku.com' + src });
                }
            }
            if (items.length === 0) throw new Error('Gazete bulunamadı. Sayfa yapısı değişmiş olabilir.');
            setGazeteItems(items);
            addSystemLog(items.length + ' gazete manşeti yüklendi.', 'success');
        } catch (e) {
            setGazeteError(e.message);
            addSystemLog('Gazete yükleme hatası: ' + e.message, 'error');
        } finally {
            setGazeteLoading(false);
        }
    };

    // Crop modal aç
    const openCropModal = (src, name) => {
        setGazeteCropModal({ src, name });
    };

    // Canvas'tan crop yapıp medya listesine aktar
    const applyCrop = (cropDataUrl, gazeteName) => {
        const newFile = {
            name: gazeteName + '_crop.png',
            type: 'image/png',
            data: cropDataUrl
        };
        setUiState(prev => ({
            ...prev,
            selectedMediaFiles: [...(prev.selectedMediaFiles || []), newFile]
        }));
        setGazeteCropModal(null);
        setActiveTab('media');
        addSystemLog('Crop medyaya aktarıldı: ' + gazeteName, 'success');
    };

    // Tam gazete görselini doğrudan medyaya aktar (crop olmadan)
    const addFullImageToMedia = async (src, name) => {
        try {
            setGazeteLoading(true);
            // Görseli canvas'a yükle ve data URL'e çevir
            const img = new Image();
            img.crossOrigin = 'anonymous';
            const dataUrl = await new Promise((resolve, reject) => {
                img.onload = () => {
                    const c = document.createElement('canvas');
                    c.width = img.naturalWidth;
                    c.height = img.naturalHeight;
                    c.getContext('2d').drawImage(img, 0, 0);
                    resolve(c.toDataURL('image/jpeg', 0.92));
                };
                img.onerror = () => reject(new Error('Görsel yüklenemedi: ' + name));
                img.src = src;
            });
            const newFile = { name: name + '.jpg', type: 'image/jpeg', data: dataUrl };
            setUiState(prev => ({
                ...prev,
                selectedMediaFiles: [...(prev.selectedMediaFiles || []), newFile]
            }));
            setActiveTab('media');
            addSystemLog('Tam sayfa medyaya aktarıldı: ' + name, 'success');
        } catch (e) {
            addSystemLog('Aktarma hatası: ' + e.message, 'error');
        } finally {
            setGazeteLoading(false);
        }
    };

    // === TOPLU GAZETE MODU ===
    const [batchState, setBatchState] = useState({ isRunning: false, headlines: [], currentIndex: 0, completed: 0, total: 0, error: '' });

    // Görselden başlık çıkarma (Gemini OCR)
    const extractHeadlinesFromImage = async (imageData, gazeteName) => {
        addSystemLog('Gazete görselinden başlıklar çıkarılıyor...', 'info');
        const b64 = imageData.includes(',') ? imageData.split(',')[1] : imageData;
        const prompt = `Bu bir gazete manşet görselidir. Görseldeki TÜM manşet başlıklarını çıkar.\n\nKurallar:\n- Her başlığı ayrı bir satırda yaz\n- Sadece ana manşet ve alt başlıkları çıkar, reklam veya köşe yazısı başlıklarını dahil etme\n- Başlıkları orijinal haliyle yaz, değiştirme\n- Her başlık tek bir cümle olsun\n\nJSON formatında dön: { "headlines": ["başlık1", "başlık2", ...] }`;
        try {
            const result = await mimoOcr(b64, prompt, 'image/jpeg', { maxTokens: 2048, temperature: 0.1 });
            const parsed = extractJSON(result, 'GazeteOCR');
            const headlines = (parsed.headlines || []).filter(h => h && h.length > 5);
            addSystemLog(`${headlines.length} başlık çıkarıldı.`, 'success');
            return headlines;
        } catch (e) {
            addSystemLog('OCR hatası: ' + e.message, 'error');
            return [];
        }
    };

    // Toplu video üretimi — TÜM başlıklar TEK VİDEODA
    // Her başlık ayrı ayrı analyzeContent ile işlenir, sonra birleştirilir
    const startBatchGeneration = async (imageData, gazeteName, headlines) => {
        setBatchState({ isRunning: true, headlines, currentIndex: 0, completed: 0, total: headlines.length, error: '' });
        addSystemLog(`Gazete videosu başlatıldı: ${headlines.length} başlık, kaynak: ${gazeteName}`, 'info');

        try {
            const gazetteConfig = { ...config, sourceName: gazeteName, analysisMode: 'yorumsuz', tip: 'haber' };
            const allSlides = [];
            const generatedImages = [];
            let firstThumbnailText = '';
            let lastSonSoz = '';
            let lastQuote = '';

            // HER BAŞLIĞI TEK TEK ANALİZ ET
            for (let i = 0; i < headlines.length; i++) {
                setBatchState(prev => ({ ...prev, currentIndex: i }));
                setUiState(prev => ({ ...prev, isProcessing: true, percent: Math.round((i / headlines.length) * 30), statusText: `Haber ${i + 1}/${headlines.length} analiz ediliyor...` }));
                addSystemLog(`[${i + 1}/${headlines.length}] Analiz: "${headlines[i].substring(0, 50)}..."`, 'info');

                try {
                    // Her başlığı ayrı bir metin olarak gönder — AI 2 sahne üretir
                    const result = await LogicEngineService.analyzeContent(headlines[i], 'text', gazetteConfig);

                    if (result.videoSlides && result.videoSlides.length > 0) {
                        allSlides.push(...result.videoSlides);
                        addSystemLog(`[${i + 1}/${headlines.length}] ${result.videoSlides.length} sahne üretildi.`, 'success');
                    }

                    if (i === 0 && result.thumbnailText) firstThumbnailText = result.thumbnailText;
                    if (result.sonSoz) lastSonSoz = result.sonSoz;
                    if (result.lastQuote) lastQuote = result.lastQuote;

                    // Her başlık için 1 AI görsel
                    const imgStyle = gazetteConfig.imageStyle || 'cinematic';
                    const imgRes = gazetteConfig.resolution || '4K';
                    const imgPrompt = result.videoSlides?.[0]?.imagePrompts?.[0] || headlines[i];
                    try {
                        const img = await MediaSynthesisService.generateImage(imgPrompt, imgStyle, imgRes);
                        // Her sahne için aynı görseli kullan (başlıkla ilgili)
                        for (let s = 0; s < (result.videoSlides?.length || 1); s++) {
                            generatedImages.push(img);
                        }
                        addSystemLog(`[${i + 1}/${headlines.length}] Görsel hazır.`, 'success');
                    } catch (e) {
                        for (let s = 0; s < (result.videoSlides?.length || 1); s++) {
                            generatedImages.push(null);
                        }
                    }
                } catch (e) {
                    addSystemLog(`[${i + 1}/${headlines.length}] Analiz hatası: ${e.message}`, 'error');
                    // Hata olursa basit sahne oluştur
                    allSlides.push({ topText: headlines[i], spokenText: headlines[i], imagePrompts: [headlines[i]] });
                    generatedImages.push(null);
                }
            }

            if (allSlides.length === 0) throw new Error("Hiç sahne üretilemedi!");

            addSystemLog(`Toplam ${allSlides.length} sahne, ${generatedImages.length} görsel. Video oluşturuluyor...`, 'info');

            // Script'i oluştur — tüm sahneleri birleştir
            const batchScript = {
                isContentUnreadable: false,
                videoSlides: allSlides,
                thumbnailText: firstThumbnailText || headlines[0],
                sonSoz: lastSonSoz,
                lastQuote: lastQuote || headlines[headlines.length - 1],
                thumbnailImagePrompt: allSlides[0]?.imagePrompts?.[0] || '',
                mediaBlackout: { show: false, percentageCovered: 0, percentageIgnored: 0, mediaNames: [], explanation: '' },
                chartData: { show: false }
            };

            // Job state'i oluştur ve render et
            const jobState = {
                jobId: 'gazete_' + Date.now(),
                status: 'READY_TO_RENDER',
                inputData: headlines.join('\n'),
                inputType: 'text',
                config: gazetteConfig,
                preferences: prefs,
                script: batchScript,
                assets: {
                    images: generatedImages,
                    audio: [],
                    thumbnail: generatedImages[0] || null,
                    thumbnailAudio: null,
                    sonSozAudio: null,
                    yorumAudio: null,
                    outroAudio: null
                }
            };

            // ASSETS phase — ses üret
            setUiState(prev => ({ ...prev, isProcessing: true, percent: 35, statusText: 'Sesler üretiliyor...' }));
            addSystemLog('Ses üretimi başlıyor...', 'info');

            for (let i = 0; i < allSlides.length; i++) {
                if (!jobState.assets.audio[i]) {
                    try {
                        jobState.assets.audio[i] = await MediaSynthesisService.generateAudio(allSlides[i].spokenText, prefs.narratorVoice);
                        addSystemLog(`Ses ${i + 1}/${allSlides.length} hazır.`, 'success');
                    } catch (e) {
                        addSystemLog(`Ses ${i + 1} hatası: ${e.message}`, 'warn');
                    }
                }
                setUiState(prev => ({ ...prev, percent: 35 + Math.round((i / allSlides.length) * 35) }));
            }

            // Thumbnail ses
            if (!jobState.assets.thumbnailAudio && batchScript.thumbnailText) {
                try { jobState.assets.thumbnailAudio = await MediaSynthesisService.generateAudio(batchScript.thumbnailText, prefs.narratorVoice); } catch(e) {}
            }

            // Son söz ses
            if (batchScript.sonSoz && !jobState.assets.sonSozAudio) {
                try { jobState.assets.sonSozAudio = await MediaSynthesisService.generateAudio(batchScript.sonSoz, prefs.narratorVoice); } catch(e) {}
            }

            // Outro ses — Spotify modunda "Görüşmek üzere"
            const isSpotifyBatch = gazetteConfig.tip === 'spotify';
            const outroTextMap = isSpotifyBatch ? {
                'tr': "Görüşmek üzere, kendinize iyi bakın.", 'en': "See you later, take care.", 'fr': "À bientôt, prenez soin de vous.", 'de': "Bis bald, passt auf euch auf.", 'es': "Hasta luego, cuídense.", 'ar': "إلى اللقاء، اعتنوا بأنفسكم.", 'ru': "До встречи, берегите себя."
            } : {
                'tr': "Abone olmayı, beğenmeyi ve paylaşmayı ihmal etmeyin.", 'en': "Don't forget to subscribe, like, and share.", 'fr': "N'oubliez pas de vous abonner.", 'de': "Vergessen Sie nicht zu abonnieren.", 'es': "No olvides suscribirte.", 'ar': "لا تنس الاشتراك.", 'ru': "Не забудьте подписаться."
            };
            const outroText = outroTextMap[config.language] || outroTextMap['tr'];
            try { jobState.assets.outroAudio = await MediaSynthesisService.generateAudio(outroText, prefs.narratorVoice); } catch(e) {}

            // RENDER
            setUiState(prev => ({ ...prev, percent: 75, statusText: 'Video render ediliyor...' }));
            addSystemLog('Render başlıyor...', 'info');

            workflowRef.current.state = jobState;
            const videoUrl = await RenderWorkerService.executeRender(jobState, canvasRef.current, prefs);

            jobState.status = 'COMPLETED';
            jobState.videoUrl = videoUrl;

            setUiState(prev => ({ ...prev, isProcessing: false, percent: 100, statusText: 'Tamamlandı!', videoUrl }));

            addSystemLog(`Gazete videosu tamamlandı: ${headlines.length} başlık, ${allSlides.length} sahne.`, 'success');
        } catch (e) {
            addSystemLog(`Gazete video hatası: ${e.message}`, 'error');
            setBatchState(prev => ({ ...prev, error: e.message }));
            setUiState(prev => ({ ...prev, isProcessing: false, error: e.message }));
        }

        setBatchState(prev => ({ ...prev, isRunning: false }));
    };

    // Gazete görselinden toplu video başlat
    const handleBatchFromGazete = async (src, gazeteName) => {
        try {
            setGazeteLoading(true);
            // Görseli base64'e çevir
            const img = new Image();
            img.crossOrigin = 'anonymous';
            const dataUrl = await new Promise((resolve, reject) => {
                img.onload = () => {
                    const c = document.createElement('canvas');
                    c.width = img.naturalWidth;
                    c.height = img.naturalHeight;
                    c.getContext('2d').drawImage(img, 0, 0);
                    resolve(c.toDataURL('image/jpeg', 0.92));
                };
                img.onerror = () => reject(new Error('Görsel yüklenemedi'));
                img.src = src;
            });

            // Başlıkları çıkar
            const headlines = await extractHeadlinesFromImage(dataUrl, gazeteName);
            if (headlines.length === 0) {
                addSystemLog('Başlık bulunamadı!', 'error');
                setGazeteLoading(false);
                return;
            }

            // Kaynak adını ayarla
            setConfig(prev => ({ ...prev, sourceName: gazeteName, analysisMode: 'yorumsuz' }));

            // Toplu üretimi başlat
            setGazeteLoading(false);
            await startBatchGeneration(dataUrl, gazeteName, headlines);
        } catch (e) {
            addSystemLog('Toplu gazete hatası: ' + e.message, 'error');
            setGazeteLoading(false);
        }
    };

    // === CROP MODAL BİLEŞENİ ===
    const GazeteCropModal = ({ src, name, onClose, onCrop }) => {
        const containerRef = useRef(null);
        const imgRef = useRef(null);
        const [imgLoaded, setImgLoaded] = useState(false);
        const [selection, setSelection] = useState(null); // {startX, startY, endX, endY}
        const [isDragging, setIsDragging] = useState(false);
        const [imgSize, setImgSize] = useState({ w: 0, h: 0 });

        // Görsel yüklendiğinde boyutları al
        const handleImageLoad = (e) => {
            const img = e.target;
            setImgSize({ w: img.offsetWidth, h: img.offsetHeight });
            setImgLoaded(true);
        };

        // Mouse koordinatlarını container-relative'a çevir
        const getRelPos = (e) => {
            const rect = containerRef.current.getBoundingClientRect();
            return {
                x: Math.max(0, Math.min(e.clientX - rect.left, rect.width)),
                y: Math.max(0, Math.min(e.clientY - rect.top, rect.height))
            };
        };

        const handleMouseDown = (e) => {
            e.preventDefault();
            const pos = getRelPos(e);
            setSelection({ startX: pos.x, startY: pos.y, endX: pos.x, endY: pos.y });
            setIsDragging(true);
        };

        const handleMouseMove = (e) => {
            if (!isDragging) return;
            const pos = getRelPos(e);
            setSelection(prev => ({ ...prev, endX: pos.x, endY: pos.y }));
        };

        const handleMouseUp = () => {
            setIsDragging(false);
        };

        // Touch desteği
        const getTouchPos = (e) => {
            const touch = e.touches[0] || e.changedTouches[0];
            const rect = containerRef.current.getBoundingClientRect();
            return {
                x: Math.max(0, Math.min(touch.clientX - rect.left, rect.width)),
                y: Math.max(0, Math.min(touch.clientY - rect.top, rect.height))
            };
        };

        const handleTouchStart = (e) => {
            const pos = getTouchPos(e);
            setSelection({ startX: pos.x, startY: pos.y, endX: pos.x, endY: pos.y });
            setIsDragging(true);
        };

        const handleTouchMove = (e) => {
            if (!isDragging) return;
            const pos = getTouchPos(e);
            setSelection(prev => ({ ...prev, endX: pos.x, endY: pos.y }));
        };

        const handleTouchEnd = () => setIsDragging(false);

        // Crop'u uygula
        const doCrop = () => {
            if (!selection || !imgRef.current) return;
            const img = imgRef.current;
            const dispW = img.offsetWidth;
            const dispH = img.offsetHeight;
            const natW = img.naturalWidth;
            const natH = img.naturalHeight;

            // Seçim koordinatlarını normalize et
            const x1 = Math.min(selection.startX, selection.endX);
            const y1 = Math.min(selection.startY, selection.endY);
            const x2 = Math.max(selection.startX, selection.endX);
            const y2 = Math.max(selection.startY, selection.endY);

            // Minimum boyut kontrolü
            if (x2 - x1 < 10 || y2 - y1 < 10) return;

            // Display → natural boyut dönüşümü
            const scaleX = natW / dispW;
            const scaleY = natH / dispH;
            const cropX = Math.round(x1 * scaleX);
            const cropY = Math.round(y1 * scaleY);
            const cropW = Math.round((x2 - x1) * scaleX);
            const cropH = Math.round((y2 - y1) * scaleY);

            // Canvas'ta crop yap
            const canvas = document.createElement('canvas');
            canvas.width = cropW;
            canvas.height = cropH;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
            const dataUrl = canvas.toDataURL('image/png');
            onCrop(dataUrl, name);
        };

        // Seçim dikdörtgeninin stilleri
        const selStyle = selection ? {
            left: Math.min(selection.startX, selection.endX) + 'px',
            top: Math.min(selection.startY, selection.endY) + 'px',
            width: Math.abs(selection.endX - selection.startX) + 'px',
            height: Math.abs(selection.endY - selection.startY) + 'px',
        } : null;

        return (
            <div className="fixed inset-0 bg-black/90 z-[9999] flex flex-col items-center justify-center p-4" onClick={onClose}>
                <div className="bg-slate-900 border border-indigo-500/30 rounded-2xl p-4 max-w-4xl w-full max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
                    {/* Başlık */}
                    <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                            <Scissors size={18} className="text-indigo-400" />
                            <span className="text-white font-bold text-sm">{name}</span>
                        </div>
                        <div className="flex gap-2">
                            {selection && (Math.abs(selection.endX - selection.startX) > 10) && (
                                <button onClick={doCrop} className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5">
                                    <Check size={14} /> Crop'u Kullan
                                </button>
                            )}
                            <button onClick={onClose} className="bg-slate-700 hover:bg-slate-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold">✕ Kapat</button>
                        </div>
                    </div>
                    {/* Talimat */}
                    <p className="text-slate-400 text-[11px] mb-2">🖱️ Fare ile gazete üzerinde bir alan seçin, sonra "Crop'u Kullan" butonuna tıklayın.</p>
                    {/* Görsel + Seçim alanı */}
                    <div ref={containerRef} className="relative flex-1 overflow-auto rounded-xl bg-black/50 select-none"
                        onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp}
                        onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}
                        style={{ cursor: 'crosshair', touchAction: 'none' }}>
                        <img ref={imgRef} src={src} crossOrigin="anonymous" onLoad={handleImageLoad}
                            className="w-full h-auto block" alt={name} draggable={false} />
                        {/* Seçim dikdörtgeni */}
                        {selection && imgLoaded && (
                            <>
                                {/* Karartılmış overlay */}
                                <div className="absolute inset-0 pointer-events-none" style={{
                                    background: 'rgba(0,0,0,0.5)',
                                    clipPath: `polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, ${selStyle.left} ${selStyle.top}, ${selStyle.left} calc(${selStyle.top} + ${selStyle.height}), calc(${selStyle.left} + ${selStyle.width}) calc(${selStyle.top} + ${selStyle.height}), calc(${selStyle.left} + ${selStyle.width}) ${selStyle.top}, ${selStyle.left} ${selStyle.top})`
                                }} />
                                {/* Seçim kutusu */}
                                <div className="absolute border-2 border-emerald-400 bg-emerald-400/10 pointer-events-none"
                                    style={selStyle}>
                                    <div className="absolute -top-5 left-0 bg-emerald-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded">
                                        {Math.round(Math.abs(selection.endX - selection.startX))}×{Math.round(Math.abs(selection.endY - selection.startY))}
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>
        );
    };

    // === GAZETELER ARASI GEÇİŞ İÇİN GALERİ MODU ===
    const [gazeteGalleryView, setGazeteGalleryView] = useState('grid'); // 'grid' | 'single'
    const [gazeteCurrentIdx, setGazeteCurrentIdx] = useState(0);

    return (
        <div className="min-h-screen bg-[#0B0F19] text-slate-200 font-sans p-3 md:p-4 relative overflow-hidden">
            <div className="max-w-3xl mx-auto">
                <div className="text-center mb-4 flex items-center justify-center gap-3">
                    <h1 className="text-xl md:text-3xl font-black tracking-tight text-white whitespace-nowrap">OTONOM</h1>
                    <div className="bg-indigo-900/40 border-2 border-indigo-500/50 px-3 py-1.5 rounded-full shadow-[0_0_20px_rgba(99,102,241,0.3)]">
                    <p className="text-indigo-300 text-[10px] md:text-xs font-black tracking-widest uppercase">
                             Otonom v4.14 <span className="mx-1 text-white">•</span> One-Page
                         </p>
                    </div>
                </div>

                {pendingJob && (
                    <div className="mb-6 bg-amber-500/10 border-2 border-amber-500/30 p-4 rounded-2xl flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 text-amber-400">
                            <AlertCircle size={20} className="shrink-0 animate-pulse" />
                            <div>
                                <p className="text-xs font-bold uppercase tracking-wider">Yarım Kalan İşlem</p>
                                <p className="text-xs text-slate-300">Son render kurtarılabilir.</p>
                            </div>
                        </div>
                        <div className="flex gap-2">
                            <button onClick={async () => { await AssetManagerService.clearJob(pendingJob.jobId); setPendingJob(null); }} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-bold transition">Yoksay</button>
                            <button onClick={() => { workflowRef.current.state = pendingJob; setPendingJob(null); handleExecuteResume(); }} className="px-4 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-lg text-xs font-black transition">Devam Et</button>
                        </div>
                    </div>
                )}

                {/* ARKA PLAN SESİ */}
                <div className="bg-indigo-950/20 border border-indigo-500/20 rounded-2xl p-3 mb-4 shadow-lg">
                    <div className="bg-black/40 p-2.5 rounded-xl border border-slate-800 flex items-center justify-between relative">
                        <div className="flex items-center gap-3 w-full">
                            <div className={`w-10 h-10 rounded border ${(prefs.ambientSound && prefs.ambientSound !== 'none') ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400' : 'bg-slate-800 border-slate-700 text-slate-500'} flex items-center justify-center shrink-0`}><CloudRain size={18} /></div>
                            <div className="w-full flex-1 pr-2">
                                <p className="text-[10px] md:text-xs text-slate-400 font-bold uppercase tracking-wider mb-1">Arka Plan Sesi</p>
                                <CustomSelect value={prefs.ambientSound || "none"} onChange={(val) => { if (['rain', 'wind', 'waves', 'fire', 'none'].includes(val)) { setPrefs({ ...prefs, ambientSound: val }); if (val === 'none') { AssetManagerService.loadMedia('CUSTOM_MUSIC').then(u => { if (u && u.startsWith('blob:')) URL.revokeObjectURL(u); }); AssetManagerService.deleteMedia('CUSTOM_MUSIC'); } } else { handleFolderMusicSelect(val); } }} options={ambientOptions} />
                            </div>
                        </div>
                        <div className="flex gap-2 shrink-0 relative z-10">
                            {(prefs.ambientSound && !['none', 'rain', 'wind', 'waves', 'fire'].includes(prefs.ambientSound)) && <button onClick={deleteMusic} className="bg-rose-500/20 hover:bg-rose-500/40 text-rose-500 p-2 rounded-lg transition"><Trash2 size={16} /></button>}
                            <button onClick={handleFolderSelect} className="bg-violet-600 hover:bg-violet-500 text-white px-3 md:px-4 py-2 rounded-lg text-xs font-bold cursor-pointer transition whitespace-nowrap">MÜZİK EKLE</button>
                            <input ref={musicFileInputRef} type="file" multiple accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.wma" className="hidden" onChange={handleFolderSelectLegacy} />
                        </div>
                    </div>
                    {studioMedia.musicList.length > 0 && (
                        <div className="mt-2">
                            <input type="text" placeholder="Müzik ara..." value={musicSearchQuery} onChange={e => setMusicSearchQuery(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-violet-500 transition" />
                        </div>
                    )}
                    {studioMedia.syncedFolderName && (
                        <div className="mt-2 flex items-center justify-between bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
                            <div className="flex items-center gap-2">
                                <RefreshCw size={12} className="text-emerald-400 animate-spin" style={{ animationDuration: '3s' }} />
                                <span className="text-[10px] text-emerald-400 font-bold">Otomatik: {studioMedia.syncedFolderName}</span>
                            </div>
                            <button onClick={clearSyncedFolder} className="text-[10px] text-slate-400 hover:text-rose-400 transition">Kaldır</button>
                        </div>
                    )}
                    {studioMedia.musicList.length === 0 && (
                        <p className="text-[9px] text-slate-500 mt-1.5 text-center">Ctrl (Windows) veya Cmd (Mac) ile birden fazla dosya seçin</p>
                    )}
                </div>

                {/* ANA İÇERİK */}
                <div className="bg-slate-900 border border-slate-800 rounded-3xl p-3 md:p-4 shadow-2xl relative z-10 mb-4">
                    <div className="flex flex-col sm:flex-row gap-2 bg-black/30 p-1.5 rounded-xl mb-4 flex-wrap">
                        <button onClick={() => setActiveTab('text')} className={`flex-1 min-w-[120px] py-2.5 rounded-lg text-xs md:text-sm font-bold transition-all ${activeTab === 'text' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}>Metin / Haber</button>
                        <button onClick={() => setActiveTab('url')} className={`flex-1 min-w-[120px] py-2.5 rounded-lg text-xs md:text-sm font-bold transition-all ${activeTab === 'url' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}>Haber Linki</button>
                        <button onClick={() => setActiveTab('media')} className={`flex-1 min-w-[120px] py-2.5 rounded-lg text-xs md:text-sm font-bold transition-all ${activeTab === 'media' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}>Medya Analizi</button>
                        <button onClick={() => setActiveTab('prompt')} className={`flex-1 min-w-[120px] py-2.5 rounded-lg text-xs md:text-sm font-bold transition-all ${activeTab === 'prompt' ? 'bg-fuchsia-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}>Serbest Prompt</button>
                        <button onClick={() => { setActiveTab('gazete'); if (gazeteItems.length === 0) fetchGazeteManşetleri(); }} className={`flex-1 min-w-[120px] py-2.5 rounded-lg text-xs md:text-sm font-bold transition-all flex items-center justify-center gap-1.5 ${activeTab === 'gazete' ? 'bg-emerald-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}><Newspaper size={14} /> Gazete Takip</button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3 font-bold">
                        <div className="bg-black/30 p-2.5 rounded-xl border border-slate-800 flex items-center">
                            <CustomSelect icon={Clock} value={config.duration} onChange={(val) => setConfig({ ...config, duration: val })} options={[{ value: 'unlimited', label: '∞ Sınırsız', color: 'text-emerald-400 font-bold' }, { value: '15', label: '15-30s' }, { value: '30', label: '30-60s' }, { value: '60', label: '60-90s' }, { value: '90', label: '90-120s' }]} />
                        </div>
                        <div className="bg-black/30 p-2.5 rounded-xl border border-slate-800 flex items-center">
                            <CustomSelect icon={Smartphone} value={config.aspectRatio || '9:16'} onChange={(val) => setConfig({ ...config, aspectRatio: val })} options={[{ value: '9:16', label: 'Dikey (9:16)' }, { value: '16:9', label: 'Yatay (16:9)' }, { value: '1:1', label: 'Kare (1:1)' }]} />
                        </div>
                        <div className="bg-black/30 p-2.5 rounded-xl border border-slate-800 flex items-center">
                            <CustomSelect icon={Clapperboard} value={config.videoStyle || 'explainer'} onChange={(val) => setConfig({ ...config, videoStyle: val })} options={[{ value: 'news_flash', label: 'Haber Bülteni' }, { value: 'cinematic', label: 'Sinematik' }, { value: 'explainer', label: 'Açıklayıcı' }, { value: 'weekly_roundup', label: 'Haftalık Özet' }, { value: 'prompt_output', label: 'Custom Prompt', color: 'text-fuchsia-400 font-bold' }]} />
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
                        <div className="bg-black/30 p-2.5 rounded-xl border border-slate-800 flex items-center">
                            <CustomSelect icon={Palette} value={config.imageStyle || 'cinematic'} onChange={(val) => setConfig({ ...config, imageStyle: val })} options={[{ value: 'watercolor', label: 'Sulu Boya' }, { value: 'sketch', label: 'Karakalem' }, { value: 'oil_painting', label: 'Yağlı Boya' }, { value: 'cinematic', label: 'Gerçekçi' }, { value: 'minimalist', label: 'Minimalist' }, { value: 'cyberpunk', label: 'Cyberpunk' }, { value: 'retro', label: 'Retro' }, { value: '3d_render', label: '3D Render' }, { value: 'anime', label: 'Anime' }]} />
                        </div>
                        <div className="bg-black/30 p-2.5 rounded-xl border border-slate-800 flex items-center gap-3">
                            <Monitor size={16} className="text-indigo-400 shrink-0" />
                            <div className="flex gap-2 w-full">{['1K', '2K', '4K'].map(res => (<button key={res} onClick={() => setConfig({ ...config, resolution: res })} className={`flex-1 py-1 rounded-lg text-xs font-bold transition-all ${config.resolution === res ? 'bg-slate-200 text-slate-900' : 'bg-slate-800/50 text-slate-400 hover:bg-slate-700'}`}>{res}</button>))}</div>
                        </div>
                        <div className="bg-black/30 p-2.5 rounded-xl border border-slate-800 flex items-center">
                            <CustomSelect icon={Activity} value={config.transition || 'none'} onChange={(val) => setConfig({ ...config, transition: val })} options={[{ value: 'none', label: 'Yok' }, { value: 'crossfade', label: 'Karışır' }, { value: 'fadeIn', label: 'Yavaşça Belirme' }, { value: 'fadeOut', label: 'Yavaşça Kaybolma' }, { value: 'slideIn', label: 'Kayarak Giriş' }, { value: 'slideOut', label: 'Kayarak Çıkış' }]} />
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                        <div className="bg-black/30 p-2.5 rounded-xl border border-slate-800 flex items-center">
                            <CustomSelect icon={Clapperboard} value={config.tip || 'haber'} onChange={(val) => setConfig({ ...config, tip: val })} options={[{ value: 'haber', label: 'Haber', color: 'text-emerald-400 font-bold' }, { value: 'guzel_soz', label: 'Güzel Söz', color: 'text-amber-400 font-bold' }, { value: 'spotify', label: 'Spotify (15dk+)', color: 'text-green-400 font-bold' }, { value: 'nostalji', label: 'Nostalji', color: 'text-rose-400 font-bold' }, { value: 'kelimesi', label: 'Kelimesi Kelimesine', color: 'text-cyan-400 font-bold' }]} />
                        </div>
                        <div className="bg-black/30 p-2.5 rounded-xl border border-slate-800 flex items-center">
                            <CustomSelect icon={Globe} value={config.language || 'tr'} onChange={(val) => setConfig({ ...config, language: val })} options={[{ value: 'tr', label: 'Türkçe' }, { value: 'en', label: 'English' }, { value: 'fr', label: 'Français' }, { value: 'de', label: 'Deutsch' }, { value: 'es', label: 'Español' }, { value: 'ar', label: 'العربية' }, { value: 'ru', label: 'Русский' }]} />
                        </div>
                        <div className="bg-black/30 p-2.5 rounded-xl border border-slate-800 flex items-center">
                            <CustomSelect icon={MessageSquare} value={config.subtitles || 'on'} onChange={(val) => setConfig({ ...config, subtitles: val })} options={[{ value: 'on', label: 'Altyazı: Açık' }, { value: 'off', label: 'Altyazı: Kapalı' }]} />
                        </div>
                        <div className="bg-black/30 p-2.5 rounded-xl border border-slate-800 flex items-center">
                            <CustomSelect icon={Type} value={config.analysisMode || 'yorumsuz'} onChange={(val) => setConfig({ ...config, analysisMode: val })} options={[{ value: 'yorumsuz', label: 'Yorumsuz' }, { value: 'visibility', label: 'Görünürlük' }, { value: 'deep_analysis', label: 'Derin Analiz', color: 'text-fuchsia-400 font-bold' }]} />
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                        <div className="bg-black/30 p-2.5 rounded-xl border border-slate-800 flex items-center">
                            <CustomSelect icon={Film} value={config.videoFormat || 'webm'} onChange={(val) => setConfig({ ...config, videoFormat: val })} options={[{ value: 'webm', label: 'WebM' }, { value: 'mp4', label: 'MP4' }]} />
                        </div>
                        <div className="bg-black/30 p-2.5 rounded-xl border border-slate-800 flex items-center relative">
                            <div className="flex items-center gap-2 w-full">
                                <CustomSelect icon={Volume2} value={prefs.narratorVoice} onChange={(val) => setPrefs({ ...prefs, narratorVoice: val })} options={voiceOptions} />
                                <button onClick={(e) => { e.stopPropagation(); setShowFilters(!showFilters); }} className="text-slate-400 hover:text-indigo-400 flex items-center gap-1 text-[9px] uppercase font-bold tracking-wider transition-colors shrink-0"><Filter size={12} /> Filtreler</button>
                            </div>
                            {showFilters && (
                                <div className="absolute top-full left-0 w-full mt-2 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-[200] p-3 space-y-3">
                                    <div><div className="text-[9px] text-slate-500 mb-1.5 uppercase font-bold tracking-wider">Gender</div><div className="flex gap-1.5">{['Any', 'Male', 'Female'].map(g => (<button key={g} onClick={() => setVoiceFilters({ ...voiceFilters, gender: g })} className={`px-3 py-1 rounded-full text-[10px] font-bold transition-all border ${voiceFilters.gender === g ? 'bg-slate-200 text-slate-900 border-slate-200' : 'bg-slate-800/50 text-slate-400 border-slate-700 hover:bg-slate-700'}`}>{g}</button>))}</div></div>
                                    <div><div className="text-[9px] text-slate-500 mb-1.5 uppercase font-bold tracking-wider">Age</div><div className="flex flex-wrap gap-1.5">{['Any', 'Child', 'Young', 'Middle-aged', 'Elderly'].map(a => (<button key={a} onClick={() => setVoiceFilters({ ...voiceFilters, age: a })} className={`px-3 py-1 rounded-full text-[10px] font-bold transition-all border ${voiceFilters.age === a ? 'bg-slate-200 text-slate-900 border-slate-200' : 'bg-slate-800/50 text-slate-400 border-slate-700 hover:bg-slate-700'}`}>{a}</button>))}</div></div>
                                    <div><div className="text-[9px] text-slate-500 mb-1.5 uppercase font-bold tracking-wider">Category</div><div className="flex flex-wrap gap-1.5">{['Any', 'Games & RPG', 'Audiobooks & Novels', 'Anime & Animation', 'Documentary', 'Commercials & Trailers', 'Corporate & Narration'].map(c => (<button key={c} onClick={() => setVoiceFilters({ ...voiceFilters, category: c })} className={`px-2.5 py-1 rounded-full text-[9px] font-bold transition-all border ${voiceFilters.category === c ? 'bg-slate-200 text-slate-900 border-slate-200' : 'bg-slate-800/50 text-slate-400 border-slate-700 hover:bg-slate-700'}`}>{c}</button>))}</div></div>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* KAYNAK ADI + SABİT GÖRSEL + YORUM */}
                    <div className="grid grid-cols-3 gap-3 mb-3">
                        <div className="bg-black/30 p-2 rounded-xl border border-slate-800 flex items-center justify-center">
                            {studioMedia.customSceneImages && studioMedia.customSceneImages[0] ? (
                                <img src={studioMedia.customSceneImages[0]} className="w-full h-10 object-cover rounded-lg" alt="Sabit" />
                            ) : (
                                <div className="text-[8px] text-slate-600 font-bold uppercase">Görsel Yok</div>
                            )}
                        </div>
                        <div className="bg-black/30 p-1.5 rounded-xl border border-slate-800 flex items-center">
                            <CustomSelect icon={null} value={config.sourceName || ''} onChange={(val) => setConfig({ ...config, sourceName: val })} options={[
                                { value: '', label: 'Kaynak Yok', color: 'text-slate-500' },
                                { label: 'Sosyal Medya', options: [
                                    { value: 'X', label: 'X (Twitter)' }, { value: 'TikTok', label: 'TikTok' }, { value: 'Instagram', label: 'Instagram' }, { value: 'Facebook', label: 'Facebook' }
                                ]},
                                { label: 'Gazeteler', options: [
                                    { value: 'Sabah', label: 'Sabah' }, { value: 'Hürriyet', label: 'Hürriyet' }, { value: 'Sözcü', label: 'Sözcü' }, { value: 'Milliyet', label: 'Milliyet' }, { value: 'Posta', label: 'Posta' }, { value: 'Habertürk', label: 'Habertürk' }, { value: 'Fanatik', label: 'Fanatik' }, { value: 'Takvim', label: 'Takvim' }, { value: 'Türkiye Gazetesi', label: 'Türkiye Gazetesi' }, { value: 'Yeni Şafak', label: 'Yeni Şafak' }, { value: 'Cumhuriyet', label: 'Cumhuriyet' }, { value: 'Birgün', label: 'Birgün' }, { value: 'Aydınlık', label: 'Aydınlık' }, { value: 'Yeniçağ', label: 'Yeniçağ' }, { value: 'Evrensel', label: 'Evrensel' }, { value: 'Karar', label: 'Karar' }, { value: 'Diriliş Postası', label: 'Diriliş Postası' }, { value: 'Milat', label: 'Milat' }, { value: 'Korkusuz', label: 'Korkusuz' }, { value: 'Dünya', label: 'Dünya' }, { value: 'Yeni Birlik', label: 'Yeni Birlik' }, { value: 'Milli Gazete', label: 'Milli Gazete' }, { value: 'Tavır', label: 'Tavır' }, { value: 'Nefes', label: 'Nefes' }, { value: 'Akşam', label: 'Akşam' }, { value: 'Gazete Pencere', label: 'Gazete Pencere' }, { value: 'Nasıl Bir Ekonomi', label: 'Nasıl Bir Ekonomi' }, { value: 'Yeni Mesaj', label: 'Yeni Mesaj' }, { value: 'Analiz', label: 'Analiz' }, { value: 'Bugün', label: 'Bugün' }, { value: 'Yeni Asya', label: 'Yeni Asya' }, { value: 'Fotomaç', label: 'Fotomaç' }
                                ]}
                            ]} />
                        </div>
                        <div className="bg-black/30 p-2 rounded-xl border border-slate-800">
                            <textarea value={config.yorum || ''} onChange={(e) => setConfig({ ...config, yorum: e.target.value })} placeholder="Yorum (2-3 satır)" className="w-full bg-transparent text-[10px] text-slate-200 outline-none placeholder:text-slate-600 font-bold resize-none h-8 leading-tight" rows={2} />
                        </div>
                    </div>

                    {/* SABİT GÖRSELLER + MEDYA — yan yana */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                        {/* SABİT GÖRSELLER */}
                        <div className="bg-cyan-950/20 border border-cyan-500/20 rounded-xl p-2.5 shadow-lg">
                            <h2 className="text-[10px] font-black text-cyan-400 mb-1 flex items-center gap-1.5"><Layers size={12} /> SABİT GÖRSELLER (MAX 10)</h2>
                            <div className="flex flex-wrap gap-2">
                                {studioMedia.customSceneImages && studioMedia.customSceneImages.map((img, idx) => (
                                    <div key={idx} className="relative w-14 h-14 rounded-lg overflow-hidden border border-slate-700 shadow-md group">
                                        <img src={img} className="w-full h-full object-cover" alt={`Sabit ${idx}`} />
                                        <button onClick={() => handleCustomSceneImageDelete(idx)} className="absolute top-0.5 right-0.5 bg-rose-500/80 group-hover:opacity-100 hover:bg-rose-500 text-white p-0.5 rounded transition opacity-0 shadow-lg"><Trash2 size={10} /></button>
                                        <div className="absolute bottom-0 left-0 bg-black/70 w-full text-center text-[7px] font-bold py-0.5 text-cyan-400 backdrop-blur-sm tracking-wider">S{idx + 1}</div>
                                    </div>
                                ))}
                                {(!studioMedia.customSceneImages || studioMedia.customSceneImages.length < 10) && (
                                    <label className="w-14 h-14 rounded-lg border-2 border-dashed border-cyan-500/50 hover:border-cyan-400 hover:bg-cyan-500/10 flex flex-col items-center justify-center cursor-pointer transition text-cyan-400">
                                        <UploadCloud size={16} className="mb-0.5 opacity-80" /><span className="text-[7px] font-bold uppercase tracking-wider opacity-80">Ekle</span>
                                        <input type="file" multiple accept="image/*" className="hidden" onChange={handleCustomSceneImagesUpload} />
                                    </label>
                                )}
                            </div>
                        </div>

                        {/* MEDYA YÜKLE */}
                        <div className="bg-black/30 border border-slate-800 rounded-xl p-2.5 shadow-lg">
                            <h2 className="text-[10px] font-black text-indigo-400 mb-1 flex items-center gap-1.5"><FileText size={12} /> MEDYA YÜKLE</h2>
                            <div className="flex flex-wrap gap-2">
                                {uiState.selectedMediaFiles && uiState.selectedMediaFiles.slice(0, 10).map((file, idx) => (
                                    <div key={idx} className="relative w-14 h-14 rounded-lg overflow-hidden border border-slate-700 shadow-md group">
                                        {file.type.startsWith('image') ? <img src={file.data} className="w-full h-full object-cover" alt={`Medya ${idx}`} /> : <div className="w-full h-full flex items-center justify-center text-[7px] font-bold text-indigo-400 bg-slate-900">{file.name.split('.').pop().toUpperCase()}</div>}
                                        <button onClick={() => setUiState(prev => ({ ...prev, selectedMediaFiles: prev.selectedMediaFiles.filter((_, i) => i !== idx) }))} className="absolute top-0.5 right-0.5 bg-rose-500/80 group-hover:opacity-100 hover:bg-rose-500 text-white p-0.5 rounded transition opacity-0 shadow-lg"><Trash2 size={10} /></button>
                                        <div className="absolute bottom-0 left-0 bg-black/70 w-full text-center text-[7px] font-bold py-0.5 text-indigo-400 backdrop-blur-sm tracking-wider">M{idx + 1}</div>
                                    </div>
                                ))}
                                <label className="w-14 h-14 rounded-lg border-2 border-dashed border-indigo-500/50 hover:border-indigo-400 hover:bg-indigo-500/10 flex flex-col items-center justify-center cursor-pointer transition text-indigo-400">
                                    <UploadCloud size={16} className="mb-0.5 opacity-80" /><span className="text-[7px] font-bold uppercase tracking-wider opacity-80">Ekle</span>
                                    <input type="file" multiple accept="*/*" className="hidden" onChange={(e) => { processSelectedFiles(Array.from(e.target.files)); e.target.value = null; }} />
                                </label>
                                {uiState.selectedMediaFiles.length > 10 && <div className="w-14 h-14 rounded-lg bg-slate-800/50 flex items-center justify-center text-[9px] text-slate-400 font-bold border border-slate-700">+{uiState.selectedMediaFiles.length - 10}</div>}
                            </div>
                        </div>
                    </div>

                    {/* === GAZETE TAKİP GALERİSİ === */}
                    {activeTab === 'gazete' && (
                        <div className="mb-3">
                            {/* Kaynak seçici + Yenile */}
                            <div className="flex items-center gap-2 mb-3">
                                <div className="flex-1 flex gap-1.5">
                                    {[{id:'gazeteoku', label:'Gazeteoku (25+ Gazete)'}, {id:'aydinlik', label:'Aydınlık'}, {id:'yenimesaj', label:'Yeni Mesaj'}].map(src => (
                                        <button key={src.id} onClick={() => { setGazeteSource(src.id); }}
                                            className={`px-3 py-1.5 rounded-lg text-[10px] font-bold border transition-all ${gazeteSource === src.id ? 'bg-emerald-600 text-white border-emerald-500' : 'bg-slate-800/50 text-slate-400 border-slate-700 hover:border-slate-500'}`}>
                                            {src.label}
                                        </button>
                                    ))}
                                </div>
                                <button onClick={fetchGazeteManşetleri} disabled={gazeteLoading}
                                    className="bg-slate-800 hover:bg-slate-700 disabled:bg-slate-900 text-slate-300 px-3 py-1.5 rounded-lg text-[10px] font-bold flex items-center gap-1.5 border border-slate-700">
                                    {gazeteLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Yenile
                                </button>
                            </div>

                            {/* Hata mesajı */}
                            {gazeteError && (
                                <div className="bg-rose-500/10 border border-rose-500/20 p-3 rounded-xl text-rose-400 text-xs font-bold mb-3 flex items-center gap-2">
                                    <AlertCircle size={14} /> {gazeteError}
                                </div>
                            )}

                            {/* Yükleniyor */}
                            {gazeteLoading && (
                                <div className="text-center py-12">
                                    <Loader2 size={32} className="text-emerald-400 animate-spin mx-auto mb-3" />
                                    <p className="text-slate-400 text-sm font-bold">Gazete manşetleri yükleniyor...</p>
                                </div>
                            )}

                            {/* Galeri Grid */}
                            {!gazeteLoading && gazeteItems.length > 0 && (
                                <div>
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-emerald-400 text-[10px] font-bold uppercase tracking-wider">{gazeteItems.length} gazete bulundu</span>
                                        <div className="flex gap-1">
                                            <button onClick={() => setGazeteGalleryView('grid')} className={`p-1.5 rounded-lg text-[10px] ${gazeteGalleryView === 'grid' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-500'}`}>▦</button>
                                            <button onClick={() => setGazeteGalleryView('single')} className={`p-1.5 rounded-lg text-[10px] ${gazeteGalleryView === 'single' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-500'}`}>☐</button>
                                        </div>
                                    </div>

                                    {gazeteGalleryView === 'grid' ? (
                                        /* GRID GÖRÜNÜMÜ — küçük kartlar */
                                        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2 max-h-[50vh] overflow-y-auto p-1">
                                            {gazeteItems.map((item, idx) => (
                                                <div key={idx} className="group relative bg-slate-800/50 rounded-xl overflow-hidden border border-slate-700/50 hover:border-emerald-500/50 transition-all cursor-pointer"
                                                    onClick={() => { setGazeteCurrentIdx(idx); setGazeteGalleryView('single'); }}>
                                                    <img src={item.src} crossOrigin="anonymous" className="w-full h-auto block" alt={item.name} loading="lazy" />
                                                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-center p-1.5">
                                                        <span className="text-white text-[8px] font-bold text-center leading-tight">{item.name}</span>
                                                    </div>
                                                    <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col gap-1">
                                                        <button onClick={(e) => { e.stopPropagation(); openCropModal(item.src, item.name); }}
                                                            className="bg-indigo-600 hover:bg-indigo-500 text-white p-1 rounded-md shadow-lg" title="Crop yap">
                                                            <Scissors size={10} />
                                                        </button>
                                                        <button onClick={(e) => { e.stopPropagation(); addFullImageToMedia(item.src, item.name); }}
                                                            className="bg-emerald-600 hover:bg-emerald-500 text-white p-1 rounded-md shadow-lg" title="Tam sayfa ekle">
                                                            <Check size={10} />
                                                        </button>
                                                        <button onClick={(e) => { e.stopPropagation(); handleBatchFromGazete(item.src, item.name); }}
                                                            disabled={batchState.isRunning}
                                                            className="bg-rose-600 hover:bg-rose-500 disabled:bg-slate-700 text-white p-1 rounded-md shadow-lg" title="Toplu video oluştur">
                                                            <Clapperboard size={10} />
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        /* TEKLİ GÖRÜNÜM — büyük önizleme */
                                        <div className="relative">
                                            <div className="flex items-center justify-between mb-2">
                                                <button onClick={() => setGazeteCurrentIdx(Math.max(0, gazeteCurrentIdx - 1))} disabled={gazeteCurrentIdx === 0}
                                                    className="bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-white px-3 py-1.5 rounded-lg text-xs font-bold">← Önceki</button>
                                                <span className="text-white text-sm font-bold">{gazeteItems[gazeteCurrentIdx]?.name} <span className="text-slate-500">({gazeteCurrentIdx + 1}/{gazeteItems.length})</span></span>
                                                <button onClick={() => setGazeteCurrentIdx(Math.min(gazeteItems.length - 1, gazeteCurrentIdx + 1))} disabled={gazeteCurrentIdx >= gazeteItems.length - 1}
                                                    className="bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-white px-3 py-1.5 rounded-lg text-xs font-bold">Sonraki →</button>
                                            </div>
                                            <div className="relative bg-black/50 rounded-xl overflow-hidden border border-slate-700/50">
                                                <img src={gazeteItems[gazeteCurrentIdx]?.src} crossOrigin="anonymous" className="w-full h-auto block" alt={gazeteItems[gazeteCurrentIdx]?.name} />
                                                {/* Overlay butonlar */}
                                                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-2 flex-wrap justify-center">
                                                    <button onClick={() => openCropModal(gazeteItems[gazeteCurrentIdx]?.src, gazeteItems[gazeteCurrentIdx]?.name)}
                                                        className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-lg shadow-indigo-500/30">
                                                        <Scissors size={14} /> Crop Yap
                                                    </button>
                                                    <button onClick={() => addFullImageToMedia(gazeteItems[gazeteCurrentIdx]?.src, gazeteItems[gazeteCurrentIdx]?.name)}
                                                        className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-lg shadow-emerald-500/30">
                                                        <Check size={14} /> Tam Sayfa Ekle
                                                    </button>
                                                    <button onClick={() => handleBatchFromGazete(gazeteItems[gazeteCurrentIdx]?.src, gazeteItems[gazeteCurrentIdx]?.name)}
                                                        disabled={batchState.isRunning}
                                                        className="bg-rose-600 hover:bg-rose-500 disabled:bg-slate-700 disabled:text-slate-500 text-white px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-lg shadow-rose-500/30">
                                                        <Clapperboard size={14} /> {batchState.isRunning ? `İşleniyor... (${batchState.completed}/${batchState.total})` : 'Toplu Video Oluştur'}
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Boş durum */}
                            {!gazeteLoading && gazeteItems.length === 0 && !gazeteError && (
                                <div className="text-center py-12">
                                    <Newspaper size={48} className="text-slate-700 mx-auto mb-3" />
                                    <p className="text-slate-500 text-sm font-bold">Gazete manşetleri yüklenmedi</p>
                                    <p className="text-slate-600 text-xs mt-1">Yukarıdaki "Yenile" butonuna tıklayın</p>
                                </div>
                            )}
                        </div>
                    )}

                    {/* CROP MODAL */}
                    {gazeteCropModal && (
                        <GazeteCropModal
                            src={gazeteCropModal.src}
                            name={gazeteCropModal.name}
                            onClose={() => setGazeteCropModal(null)}
                            onCrop={applyCrop}
                        />
                    )}

                    {/* METİN GİRİŞİ (text/URL/prompt için) */}
                    {activeTab !== 'media' && activeTab !== 'gazete' && (
                        <textarea value={textInput} onChange={e => setTextInput(e.target.value)} placeholder={config.tip === 'guzel_soz' ? (activeTab === 'url' ? "Söz linkini yapıştırın..." : "Güzel sözü veya alıntıyı yazın...") : config.tip === 'nostalji' ? "Geçmiş haberi yazın (tarih ile birlikte, ör: 15.07.2016 tarihinde...)" : config.tip === 'kelimesi' ? "Birebir okunacak metni yazın, URL yapıştırın veya görsel/video yükleyin..." : (activeTab === 'url' ? "Haber linkini yapıştırın..." : "Haberi yazın veya araştırılacak gündemi verin...")} className={`w-full h-20 bg-black/30 border rounded-xl p-3 text-sm outline-none mb-3 text-slate-200 resize-none transition-all relative z-0 ${activeTab === 'prompt' ? 'border-fuchsia-500/50 focus:border-fuchsia-500' : 'border-slate-800 focus:border-indigo-500'}`} />
                    )}

                    <div className="flex justify-between items-center mb-3 px-2">
                        {config.tip === 'guzel_soz' ? (
                            <span className="text-xs font-bold text-amber-400 bg-amber-500/10 px-3 py-1.5 rounded-full border border-amber-500/20">Güzel Söz — Metin veya Resim + Arka Plan Müziği</span>
                        ) : config.tip === 'spotify' ? (
                            <span className="text-xs font-bold text-green-400 bg-green-500/10 px-3 py-1.5 rounded-full border border-green-500/20">Spotify — Min 15dk Uzun Form İçerik + Araştırma</span>
                        ) : config.tip === 'nostalji' ? (
                            <span className="text-xs font-bold text-rose-400 bg-rose-500/10 px-3 py-1.5 rounded-full border border-rose-500/20">Nostalji — Geçmişten Haberler + Hatıran Yeter</span>
                        ) : config.tip === 'kelimesi' ? (
                            <span className="text-xs font-bold text-cyan-400 bg-cyan-500/10 px-3 py-1.5 rounded-full border border-cyan-500/20">Kelimesi Kelimesine — Birebir Okuma + Otomatik Ses</span>
                        ) : (<><span className="text-xs text-slate-500 flex items-center gap-1"><Type size={12} /> Dil: {getWPS(config.language)} kelime/sn</span>
                        <span className="text-xs font-bold text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded-full border border-emerald-500/20">Hedef: ~{maxWordsUI} kelime</span></>)}
                    </div>

                    <div className="flex flex-col sm:flex-row gap-2 relative z-0">
                        <button onClick={() => handleExecuteStart(uiState.selectedMediaFiles, 'image')} disabled={uiState.isProcessing || ((config.tip === 'guzel_soz' || config.tip === 'spotify') ? (!textInput.trim() && uiState.selectedMediaFiles.length === 0) : ((activeTab === 'media' || activeTab === 'gazete') ? uiState.selectedMediaFiles.length === 0 : !textInput.trim()))} className="flex-1 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-900 disabled:text-slate-600 text-slate-200 py-2.5 md:py-3 rounded-full font-medium text-xs transition-all border border-slate-700 flex items-center justify-center gap-2">
                            {uiState.isProcessing && config.outputType === 'image' ? <><Loader2 size={16} className="animate-spin" /> İŞLENİYOR...</> : <><ImagePlus size={16} /> {config.tip === 'guzel_soz' ? 'Kart Oluştur' : config.tip === 'spotify' ? 'Kapak Oluştur' : config.tip === 'nostalji' ? 'Nostalji Kart Oluştur' : config.tip === 'kelimesi' ? 'Okuma Kartı Oluştur' : 'Görsel oluştur'}</>}
                        </button>
                        <button onClick={() => handleExecuteStart(uiState.selectedMediaFiles, 'video')} disabled={uiState.isProcessing || ((config.tip === 'guzel_soz' || config.tip === 'spotify') ? (!textInput.trim() && uiState.selectedMediaFiles.length === 0) : ((activeTab === 'media' || activeTab === 'gazete') ? uiState.selectedMediaFiles.length === 0 : !textInput.trim()))} className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-900/50 disabled:text-indigo-400 text-white py-2.5 md:py-3 rounded-full font-bold text-xs transition-all shadow-lg shadow-indigo-500/20 flex items-center justify-center gap-2">
                            {uiState.isProcessing && config.outputType === 'video' ? <><Loader2 size={16} className="animate-spin" /> İŞLENİYOR...</> : <>{config.tip === 'guzel_soz' ? <><Wand2 size={16} /> Güzel Söz Oluştur</> : config.tip === 'spotify' ? <><Music size={16} /> Spotify İçerik Oluştur</> : config.tip === 'nostalji' ? <><Film size={16} /> Nostalji Video Oluştur</> : config.tip === 'kelimesi' ? <><Type size={16} /> Kelimesi Kelimesine Oku</> : <><Clapperboard size={16} /> Video oluştur</>}</>}
                        </button>
                    </div>
                </div>

                {/* HATA */}
                {uiState.error && (
                    <div className="mt-6 bg-rose-500/10 border border-rose-500/20 p-4 rounded-xl flex gap-3 text-rose-400 text-sm font-medium items-start">
                        <AlertCircle size={18} className="shrink-0 mt-0.5" />
                        <div><strong className="block mb-1">Hata</strong>{String(uiState.error)}</div>
                    </div>
                )}

                {/* ÇIKTI */}
                {uiState.videoUrl && (
                    <div className="mt-8 bg-slate-900 border border-emerald-900/50 p-6 rounded-3xl shadow-2xl text-center">
                        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-bold mb-4">
                            <ShieldCheck size={14} /> {config.tip === 'guzel_soz' ? 'GÜZEL SÖZ OLUŞTURULDU' : config.tip === 'nostalji' ? 'NOSTALJİ VİDEO OLUŞTURULDU' : config.tip === 'kelimesi' ? 'KELİMESİ KELİMESİNE OKUMA OLUŞTURULDU' : (config.outputType === 'image' ? 'GÖRSEL OLUŞTURULDU' : 'VIDEO OLUŞTURULDU')}
                        </div>
                        {config.outputType === 'image' ? <img src={uiState.videoUrl} className="w-full max-w-md mx-auto rounded-2xl shadow-lg ring-1 ring-white/10 object-cover" alt="Output" /> : <video src={uiState.videoUrl} controls autoPlay className="w-full max-w-md mx-auto rounded-2xl shadow-lg ring-1 ring-white/10" />}
                        <div className="mt-4 flex justify-center gap-3 flex-wrap">
                            <button onClick={() => { const a = document.createElement('a'); a.href = uiState.videoUrl; const rawTitle = workflowRef.current?.state?.script?.thumbnailText || 'video'; const ext = config.outputType === 'image' ? '.png' : (config.videoFormat === 'mp4' ? '.mp4' : '.webm'); a.download = rawTitle.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "_").toLowerCase() + ext; a.click(); }} className="bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2"><Download size={14} /> İNDİR</button>
                            <button onClick={() => setShowSharePanel(!showSharePanel)} className="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2"><Share2 size={14} /> PAYLAŞ</button>
                            <button onClick={async () => { setUiState(prev => ({ ...prev, videoUrl: null, selectedMediaFiles: [], percent: 0, statusText: '', error: '' })); for (let i = 0; i < 10; i++) await AssetManagerService.deleteMedia("CUSTOM_SCENE_IMG_" + i); setStudioMedia(s => ({ ...s, customSceneImages: [] })); }} className="bg-slate-700 hover:bg-slate-600 text-white px-5 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2"><RotateCcw size={14} /> {config.tip === 'guzel_soz' ? 'YENİ SÖZ' : config.tip === 'nostalji' ? 'YENİ NOSTALJİ' : config.tip === 'kelimesi' ? 'YENİ OKUMA' : 'YENİ HABER'}</button>
                        </div>

                        {/* YOUTUBE BİLGİLERİ */}
                        {(workflowRef.current?.state?.script?.youtubeTitle || workflowRef.current?.state?.script?.tiktokTitle) && (
                            <div className="mt-4 bg-slate-800 border border-rose-900/30 rounded-2xl p-4 text-left">
                                <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
                                    <Film size={14} className="text-rose-400" /> YouTube Bilgileri
                                    <span className="text-[9px] text-slate-500 font-normal ml-auto">{config.language?.toUpperCase()}</span>
                                </h3>
                                {/* Başlık */}
                                <div className="mb-3">
                                    <div className="flex items-center justify-between mb-1">
                                        <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Başlık</span>
                                        <button onClick={() => copyToClipboard(workflowRef.current?.state?.script?.youtubeTitle || workflowRef.current?.state?.script?.tiktokTitle || '', 'Başlık')} className="text-[10px] text-slate-400 hover:text-emerald-400 transition flex items-center gap-1">
                                            {copiedField === 'Başlık' ? <><Check size={10} className="text-emerald-400" /> Kopyalandı</> : <><Copy size={10} /> Kopyala</>}
                                        </button>
                                    </div>
                                    <div className="bg-black/30 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200">{workflowRef.current?.state?.script?.youtubeTitle || workflowRef.current?.state?.script?.tiktokTitle}</div>
                                </div>
                                {/* Açıklama */}
                                <div className="mb-3">
                                    <div className="flex items-center justify-between mb-1">
                                        <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Açıklama</span>
                                        <button onClick={() => copyToClipboard(workflowRef.current?.state?.script?.youtubeDescription || workflowRef.current?.state?.script?.tiktokDescription || '', 'Açıklama')} className="text-[10px] text-slate-400 hover:text-emerald-400 transition flex items-center gap-1">
                                            {copiedField === 'Açıklama' ? <><Check size={10} className="text-emerald-400" /> Kopyalandı</> : <><Copy size={10} /> Kopyala</>}
                                        </button>
                                    </div>
                                    <div className="bg-black/30 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 whitespace-pre-wrap max-h-32 overflow-y-auto">{workflowRef.current?.state?.script?.youtubeDescription || workflowRef.current?.state?.script?.tiktokDescription}</div>
                                </div>
                                {/* Hashtag'ler */}
                                <div>
                                    <div className="flex items-center justify-between mb-1">
                                        <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Hashtag'ler</span>
                                        <button onClick={() => copyToClipboard((workflowRef.current?.state?.script?.youtubeHashtags || workflowRef.current?.state?.script?.tiktokHashtags || []).join(' '), 'Hashtag')} className="text-[10px] text-slate-400 hover:text-emerald-400 transition flex items-center gap-1">
                                            {copiedField === 'Hashtag' ? <><Check size={10} className="text-emerald-400" /> Kopyalandı</> : <><Copy size={10} /> Kopyala</>}
                                        </button>
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {(workflowRef.current?.state?.script?.youtubeHashtags || workflowRef.current?.state?.script?.tiktokHashtags || []).map((tag, i) => (
                                            <span key={i} className="bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 px-2 py-0.5 rounded-full text-[10px] font-bold">{tag.startsWith('#') ? tag : `#${tag}`}</span>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}

                        {showSharePanel && (
                            <div className="mt-4 bg-slate-800 border border-slate-700 rounded-2xl p-4">
                                <div className="flex items-center justify-between mb-3">
                                    <h3 className="text-sm font-bold text-white">Sosyal Medya Paylaşımı</h3>
                                    <button onClick={() => setShowSharePanel(false)} className="text-slate-400 hover:text-white">✕</button>
                                </div>
                                {/* Hızlı seçim butonları: X, TikTok, Instagram, Facebook */}
                                <div className="flex gap-2 mb-3">
                                    {['x', 'tiktok', 'instagram', 'facebook'].map(pid => {
                                        const p = SOCIAL_PLATFORMS.find(pl => pl.id === pid);
                                        return (
                                            <button key={pid} onClick={() => toggleShareTarget(pid)}
                                            className={`flex-1 py-2 rounded-lg text-[10px] font-bold border transition-all ${shareTargets[pid] ? 'bg-indigo-500/30 border-indigo-500/60 text-white' : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'}`}>
                                                {p.name.split(' ')[0]}
                                            </button>
                                        );
                                    })}
                                </div>
                                <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
                                    {SOCIAL_PLATFORMS.map(platform => (
                                        <div key={platform.id} className={`p-3 rounded-xl border cursor-pointer transition-all ${shareTargets[platform.id] ? 'bg-indigo-500/20 border-indigo-500/50' : 'bg-slate-900 border-slate-700 hover:border-slate-500'}`} onClick={() => toggleShareTarget(platform.id)}>
                                            <div className="flex items-center gap-2">
                                                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: platform.color }} />
                                                <span className="text-xs font-bold text-white">{platform.name}</span>
                                            </div>
                                            {connectedPlatforms[platform.id] && <span className="text-[10px] text-emerald-400 mt-1 block">Bağlı</span>}
                                        </div>
                                    ))}
                                </div>
                                <div className="flex gap-2">
                                    <button onClick={shareToSelectedPlatforms} className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1"><Share2 size={14} /> Seçilenlerde Paylaş</button>
                                    <button onClick={copyShareLink} className="bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-lg text-xs font-bold"><Copy size={14} /></button>
                                    {typeof navigator !== 'undefined' && navigator.share && <button onClick={nativeShare} className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg text-xs font-bold">Cihazda Paylaş</button>}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* İŞLEM EKRANI */}
            {uiState.isProcessing && (
                <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-md z-50 flex items-center justify-center p-4">
                    <div className="bg-slate-900 border border-indigo-500/30 w-full max-w-lg p-6 md:p-8 rounded-3xl shadow-2xl relative overflow-hidden text-center">
                        <div className="absolute top-0 left-0 h-1 bg-indigo-600 transition-all duration-300 animate-pulse" style={{ width: `${uiState.percent}%` }}></div>
                        <div className="w-14 h-14 rounded-full bg-indigo-500/10 flex items-center justify-center mx-auto mb-4"><Loader2 size={28} className="text-indigo-400 animate-spin" /></div>
                        <h2 className="text-5xl font-black text-white mb-2">{Math.round(uiState.percent)}%</h2>
                        <p className="text-indigo-400 font-bold text-sm mb-3 uppercase tracking-widest">{uiState.statusText}</p>
                        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-800 text-slate-400 text-xs font-mono mb-4 border border-slate-700/50"><Clock size={12} /> Geçen: {elapsedSeconds}sn</div>
                        {sysLogs && sysLogs.length > 0 && (
                            <div className="mt-4 bg-slate-950/90 border border-slate-800 rounded-2xl p-4 text-left font-mono text-[11px] leading-relaxed max-h-48 overflow-y-auto space-y-1.5">
                                {sysLogs.map((log, idx) => { let c = "text-slate-400"; if (log.type === "success") c = "text-emerald-400 font-bold"; if (log.type === "warn") c = "text-amber-400 font-bold"; if (log.type === "error") c = "text-rose-400 font-bold animate-pulse"; return (<div key={idx} className={`flex items-start gap-2 ${c}`}><span className="text-slate-600 shrink-0 select-none">[{log.timestamp}]</span><span className="break-all">{log.text}</span></div>); })}
                                <div ref={logEndRef} />
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* OTURUM HATASI */}
            {authExpired && (
                <div className="fixed inset-0 bg-slate-950/95 backdrop-blur-xl z-[9999] flex items-center justify-center p-4">
                    <div className="bg-slate-900 border-2 border-red-500/40 w-full max-w-md p-8 rounded-3xl shadow-2xl text-center">
                        <h2 className="text-2xl font-black text-white mb-3">OTURUM SÜRESİ DOLDU</h2>
                        <p className="text-slate-400 text-sm mb-6">Lütfen sayfayı yenileyin.</p>
                        <div className="flex flex-col gap-3">
                            <button onClick={handleSilentRecovery} className="w-full bg-gradient-to-r from-emerald-600 to-indigo-600 text-white font-bold py-3 rounded-xl text-sm flex items-center justify-center gap-2"><ShieldCheck size={16} /> OTURUMU YENİLE</button>
                            <button onClick={() => setAuthExpired(false)} className="w-full bg-slate-800 text-slate-300 font-bold py-3 rounded-xl text-xs">GÖZARDI ET</button>
                            <button onClick={() => window.location.reload()} className="w-full bg-red-600/20 text-red-400 font-bold py-3 rounded-xl text-xs border border-red-500/30">SAYFAYI YENİLE (F5)</button>
                        </div>
                    </div>
                </div>
            )}

            <canvas ref={canvasRef} style={{ position: 'fixed', top: '-10000px', left: '-10000px', zIndex: -50 }} />
        </div>
    );
}
