const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 }); // cache 1 hour
const PORT = process.env.PORT || 3000;

app.use(express.json());

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.jiosaavn.com/'
};

// ── Search songs ─────────────────────────────────────────────────────────────
app.get('/search', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'query required' });

    const cacheKey = `search_${q}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    try {
        const url = `https://saavn.dev/api/search/songs?query=${encodeURIComponent(q)}&page=1&limit=20`;
        const response = await axios.get(url, { headers: HEADERS, timeout: 10000 });

        if (!response.data?.success) {
            return res.status(500).json({ error: 'Search failed' });
        }

        const results = response.data.data?.results || [];
        const songs = results.map(item => ({
            id: item.id,
            title: item.name,
            artist: item.artists?.primary?.map(a => a.name).join(', ') || 'Unknown',
            thumbnail: item.image?.[item.image.length - 1]?.url || '',
            duration: item.duration?.toString() || ''
        }));

        cache.set(cacheKey, songs);
        res.json(songs);
    } catch (e) {
        console.error('Search error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Get stream URL ────────────────────────────────────────────────────────────
app.get('/stream/:songId', async (req, res) => {
    const { songId } = req.params;

    const cacheKey = `stream_${songId}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ url: cached });

    try {
        // Try saavn.dev first
        const url = `https://saavn.dev/api/songs/${songId}`;
        const response = await axios.get(url, { headers: HEADERS, timeout: 10000 });

        if (response.data?.success) {
            const song = Array.isArray(response.data.data)
                ? response.data.data[0]
                : response.data.data;

            const downloadUrls = song?.downloadUrl || [];
            // Get 320kbps or highest available
            const best = downloadUrls.find(u => u.quality === '320kbps')
                || downloadUrls[downloadUrls.length - 1];

            if (best?.url) {
                cache.set(cacheKey, best.url);
                return res.json({ url: best.url });
            }
        }

        // Fallback: JioSaavn direct
        const saavnUrl = `https://www.jiosaavn.com/api.php?__call=song.getDetails&cc=in&_marker=0&_format=json&pids=${songId}`;
        const saavnRes = await axios.get(saavnUrl, { headers: HEADERS, timeout: 10000 });
        const songObj = saavnRes.data?.[songId] || saavnRes.data;

        const encrypted = songObj?.encrypted_media_url || '';
        if (encrypted) {
            const streamUrl = decryptDES(encrypted);
            if (streamUrl) {
                const hdUrl = streamUrl.replace('_96.mp4', '_320.mp4').replace('_48.mp4', '_320.mp4');
                cache.set(cacheKey, hdUrl);
                return res.json({ url: hdUrl });
            }
        }

        res.status(404).json({ error: 'Stream URL not found' });
    } catch (e) {
        console.error('Stream error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── DES decrypt (same as Android app) ────────────────────────────────────────
function decryptDES(encrypted) {
    try {
        const crypto = require('crypto');
        const key = '38346591';
        const encBuf = Buffer.from(encrypted, 'base64');
        const decipher = crypto.createDecipheriv('des-ecb', key, '');
        decipher.setAutoPadding(true);
        const decrypted = Buffer.concat([decipher.update(encBuf), decipher.final()]);
        return decrypted.toString('utf8').trim();
    } catch (e) {
        console.error('DES decrypt error:', e.message);
        return null;
    }
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'Beatify API running ✓', version: '1.0' });
});

app.listen(PORT, () => {
    console.log(`Beatify server running on port ${PORT}`);
});
