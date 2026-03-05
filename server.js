const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const crypto = require('crypto');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 });
const PORT = process.env.PORT || 3000;

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.jiosaavn.com/',
    'Origin': 'https://www.jiosaavn.com'
};

// ── Search ───────────────────────────────────────────────────────────────────
app.get('/search', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'query required' });

    const cacheKey = `search_${q}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    console.log('Searching:', q);

    // Try 1: saavn.dev
    try {
        const url = `https://saavn.dev/api/search/songs?query=${encodeURIComponent(q)}&page=1&limit=20`;
        const r = await axios.get(url, { headers: HEADERS, timeout: 10000 });
        if (r.data?.success) {
            const results = r.data.data?.results || [];
            if (results.length > 0) {
                const songs = results.map(item => ({
                    id: item.id,
                    title: item.name || 'Unknown',
                    artist: item.artists?.primary?.map(a => a.name).join(', ') || 'Unknown Artist',
                    thumbnail: item.image?.[item.image.length - 1]?.url || '',
                    duration: item.duration?.toString() || ''
                }));
                cache.set(cacheKey, songs);
                return res.json(songs);
            }
        }
    } catch (e) { console.error('saavn.dev error:', e.message); }

    // Try 2: JioSaavn autocomplete
    try {
        const url = `https://www.jiosaavn.com/api.php?__call=autocomplete.get&_format=json&_marker=0&cc=in&includeMetaTags=1&query=${encodeURIComponent(q)}`;
        const r = await axios.get(url, { headers: HEADERS, timeout: 10000 });
        const data = r.data?.songs?.data || [];
        if (data.length > 0) {
            const songs = data.map(item => ({
                id: item.id,
                title: decodeHtml(item.title || item.song || 'Unknown'),
                artist: decodeHtml(parseArtist(item)),
                thumbnail: (item.image || '').replace('50x50', '500x500').replace('150x150', '500x500'),
                duration: item.duration || ''
            }));
            cache.set(cacheKey, songs);
            return res.json(songs);
        }
    } catch (e) { console.error('JioSaavn autocomplete error:', e.message); }

    // Try 3: JioSaavn search
    try {
        const url = `https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&api_version=4&ctx=android&query=${encodeURIComponent(q)}&n=20&p=1`;
        const r = await axios.get(url, { headers: HEADERS, timeout: 10000 });
        const results = r.data?.results || [];
        if (results.length > 0) {
            const songs = results.map(item => ({
                id: item.id,
                title: decodeHtml(item.title || item.song || 'Unknown'),
                artist: decodeHtml(parseArtist(item)),
                thumbnail: (item.image || '').replace('50x50', '500x500').replace('150x150', '500x500'),
                duration: item.duration || ''
            }));
            cache.set(cacheKey, songs);
            return res.json(songs);
        }
    } catch (e) { console.error('JioSaavn search error:', e.message); }

    res.status(500).json({ error: 'Search failed' });
});

// ── Stream URL ───────────────────────────────────────────────────────────────
app.get('/stream/:songId', async (req, res) => {
    const { songId } = req.params;
    console.log('Stream request for:', songId);

    const cacheKey = `stream_${songId}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ url: cached });

    // Try 1: saavn.dev songs endpoint
    try {
        const endpoints = [
            `https://saavn.dev/api/songs?id=${songId}`,
            `https://saavn.dev/api/songs/${songId}`
        ];
        for (const url of endpoints) {
            try {
                const r = await axios.get(url, { headers: HEADERS, timeout: 12000 });
                if (r.data?.success) {
                    const song = Array.isArray(r.data.data) ? r.data.data[0] : r.data.data;
                    const dlUrls = song?.downloadUrl || [];
                    console.log('downloadUrl entries:', dlUrls.length);
                    dlUrls.forEach((u, i) => console.log(`  [${i}] ${u.quality}: ${(u.url||'').substring(0,60)}`));
                    const best = dlUrls.find(u => u.quality === '320kbps')
                        || dlUrls.find(u => u.quality === '160kbps')
                        || dlUrls[dlUrls.length - 1];
                    if (best?.url) {
                        cache.set(cacheKey, best.url);
                        return res.json({ url: best.url });
                    }
                }
            } catch(e) { console.error(`saavn.dev ${url} failed:`, e.message); }
        }
    } catch (e) { console.error('saavn.dev stream error:', e.message); }

    // Try 2: JioSaavn with DES decrypt
    try {
        const url = `https://www.jiosaavn.com/api.php?__call=song.getDetails&cc=in&_marker=0&_format=json&pids=${songId}`;
        const r = await axios.get(url, { headers: HEADERS, timeout: 12000 });
        console.log('JioSaavn song.getDetails keys:', Object.keys(r.data || {}));
        const songObj = r.data?.[songId] || r.data;
        const encrypted = songObj?.encrypted_media_url
            || songObj?.more_info?.encrypted_media_url || '';
        console.log('encrypted_media_url:', encrypted?.substring(0, 40));

        if (encrypted) {
            const decrypted = desDecrypt(encrypted);
            console.log('decrypted:', decrypted?.substring(0, 80));
            if (decrypted?.startsWith('http')) {
                const hdUrl = upgradeQuality(decrypted);
                cache.set(cacheKey, hdUrl);
                return res.json({ url: hdUrl });
            }
        }

        // Try plain URLs
        const plain = songObj?.media_url || songObj?.vlink || '';
        if (plain && !plain.includes('jiotune') && !plain.includes('preview')) {
            const hdUrl = upgradeQuality(plain);
            cache.set(cacheKey, hdUrl);
            return res.json({ url: hdUrl });
        }
    } catch (e) { console.error('JioSaavn stream error:', e.message); }

    // Try 3: JioSaavn song.generateAuthToken
    try {
        const url = `https://www.jiosaavn.com/api.php?__call=song.generateAuthToken&url=https://aac.saavncdn.com/${songId}_320.mp4&bitrate=320&api_version=4&_format=json&ctx=android&_marker=0`;
        const r = await axios.get(url, { headers: HEADERS, timeout: 10000 });
        console.log('generateAuthToken response:', JSON.stringify(r.data).substring(0, 200));
        const authUrl = r.data?.auth_url || r.data?.url || '';
        if (authUrl) {
            cache.set(cacheKey, authUrl);
            return res.json({ url: authUrl });
        }
    } catch (e) { console.error('generateAuthToken error:', e.message); }

    res.status(404).json({ error: 'Stream URL not found' });
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function desDecrypt(encrypted) {
    const keys = ['38346591', '34256897', '33445512'];
    for (const key of keys) {
        try {
            const encBuf = Buffer.from(encrypted, 'base64');
            const decipher = crypto.createDecipheriv('des-ecb', key, '');
            decipher.setAutoPadding(true);
            const result = Buffer.concat([decipher.update(encBuf), decipher.final()]).toString('utf8').trim();
            console.log(`DES key ${key} result: ${result.substring(0, 60)}`);
            if (result.startsWith('http')) return result;
        } catch (e) { console.error(`DES key ${key} failed:`, e.message); }
    }
    return null;
}

function upgradeQuality(url) {
    return url
        .replace('_12.mp4', '_320.mp4')
        .replace('_48.mp4', '_320.mp4')
        .replace('_96.mp4', '_320.mp4')
        .replace('_160.mp4', '_320.mp4');
}

function parseArtist(item) {
    const plain = item.primary_artists || item.singers || '';
    if (plain && !plain.startsWith('{')) return plain;
    try {
        const info = JSON.parse(item.more_info || '{}');
        return info.primary_artists || info.singers || 'Unknown Artist';
    } catch { return 'Unknown Artist'; }
}

function decodeHtml(text) {
    return (text || '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'Beatify API running ✓', version: '3.0' }));

app.listen(PORT, () => console.log(`Beatify server on port ${PORT}`));
