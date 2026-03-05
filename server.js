const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 });
const PORT = process.env.PORT || 3000;

app.use(express.json());

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
    if (cached) { console.log('Cache hit:', q); return res.json(cached); }

    console.log('Searching:', q);

    // Try 1: saavn.dev
    try {
        const url = `https://saavn.dev/api/search/songs?query=${encodeURIComponent(q)}&page=1&limit=20`;
        console.log('Trying saavn.dev:', url);
        const response = await axios.get(url, { headers: HEADERS, timeout: 10000 });
        console.log('saavn.dev status:', response.status);
        console.log('saavn.dev success:', response.data?.success);

        if (response.data?.success) {
            const results = response.data.data?.results || [];
            console.log('saavn.dev results:', results.length);
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
    } catch (e) {
        console.error('saavn.dev error:', e.message);
    }

    // Try 2: JioSaavn autocomplete
    try {
        const url = `https://www.jiosaavn.com/api.php?__call=autocomplete.get&_format=json&_marker=0&cc=in&includeMetaTags=1&query=${encodeURIComponent(q)}`;
        console.log('Trying JioSaavn autocomplete');
        const response = await axios.get(url, { headers: HEADERS, timeout: 10000 });
        const data = response.data?.songs?.data || [];
        console.log('JioSaavn autocomplete results:', data.length);

        if (data.length > 0) {
            const songs = data.map(item => ({
                id: item.id,
                title: decodeHtml(item.title || item.song || 'Unknown'),
                artist: decodeHtml(parseArtist(item)),
                thumbnail: (item.image || '').replace('150x150', '500x500'),
                duration: item.duration || ''
            }));
            cache.set(cacheKey, songs);
            return res.json(songs);
        }
    } catch (e) {
        console.error('JioSaavn autocomplete error:', e.message);
    }

    // Try 3: JioSaavn search.getResults
    try {
        const url = `https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&api_version=4&ctx=android&query=${encodeURIComponent(q)}&n=20&p=1`;
        console.log('Trying JioSaavn search.getResults');
        const response = await axios.get(url, { headers: HEADERS, timeout: 10000 });
        const results = response.data?.results || [];
        console.log('JioSaavn search results:', results.length);

        if (results.length > 0) {
            const songs = results.map(item => ({
                id: item.id,
                title: decodeHtml(item.title || item.song || 'Unknown'),
                artist: decodeHtml(parseArtist(item)),
                thumbnail: (item.image || '').replace('150x150', '500x500'),
                duration: item.duration || ''
            }));
            cache.set(cacheKey, songs);
            return res.json(songs);
        }
    } catch (e) {
        console.error('JioSaavn search error:', e.message);
    }

    console.error('All search APIs failed for:', q);
    res.status(500).json({ error: 'Search failed' });
});

// ── Stream URL ───────────────────────────────────────────────────────────────
app.get('/stream/:songId', async (req, res) => {
    const { songId } = req.params;
    console.log('Getting stream for:', songId);

    const cacheKey = `stream_${songId}`;
    const cached = cache.get(cacheKey);
    if (cached) { console.log('Stream cache hit'); return res.json({ url: cached }); }

    // Try 1: saavn.dev
    try {
        const urls = [
            `https://saavn.dev/api/songs?id=${songId}`,
            `https://saavn.dev/api/songs/${songId}`
        ];
        for (const url of urls) {
            const response = await axios.get(url, { headers: HEADERS, timeout: 10000 });
            if (response.data?.success) {
                const song = Array.isArray(response.data.data)
                    ? response.data.data[0] : response.data.data;
                const dlUrls = song?.downloadUrl || [];
                console.log('saavn.dev downloadUrl count:', dlUrls.length);
                const best = dlUrls.find(u => u.quality === '320kbps') || dlUrls[dlUrls.length - 1];
                if (best?.url) {
                    console.log('saavn.dev stream:', best.url.substring(0, 60));
                    cache.set(cacheKey, best.url);
                    return res.json({ url: best.url });
                }
            }
        }
    } catch (e) {
        console.error('saavn.dev stream error:', e.message);
    }

    // Try 2: JioSaavn direct with DES decrypt
    try {
        const url = `https://www.jiosaavn.com/api.php?__call=song.getDetails&cc=in&_marker=0&_format=json&pids=${songId}`;
        const response = await axios.get(url, { headers: HEADERS, timeout: 10000 });
        const songObj = response.data?.[songId] || response.data;
        const encrypted = songObj?.encrypted_media_url || '';
        if (encrypted) {
            const decrypted = decryptDES(encrypted);
            if (decrypted) {
                const hdUrl = decrypted
                    .replace('_96.mp4', '_320.mp4')
                    .replace('_48.mp4', '_320.mp4')
                    .replace('_12.mp4', '_320.mp4');
                console.log('JioSaavn stream:', hdUrl.substring(0, 60));
                cache.set(cacheKey, hdUrl);
                return res.json({ url: hdUrl });
            }
        }
    } catch (e) {
        console.error('JioSaavn stream error:', e.message);
    }

    res.status(404).json({ error: 'Stream URL not found' });
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function decryptDES(encrypted) {
    try {
        const crypto = require('crypto');
        const key = '38346591';
        const encBuf = Buffer.from(encrypted, 'base64');
        const decipher = crypto.createDecipheriv('des-ecb', key, '');
        decipher.setAutoPadding(true);
        return Buffer.concat([decipher.update(encBuf), decipher.final()]).toString('utf8').trim();
    } catch (e) {
        console.error('DES error:', e.message);
        return null;
    }
}

function parseArtist(item) {
    const plain = item.primary_artists || item.singers || item.music || '';
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
app.get('/', (req, res) => {
    res.json({ status: 'Beatify API running ✓', version: '2.0' });
});

app.listen(PORT, () => console.log(`Beatify server running on port ${PORT}`));
