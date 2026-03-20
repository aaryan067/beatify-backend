const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 });
const PORT = process.env.PORT || 3000;

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.jiosaavn.com/',
    'Origin': 'https://www.jiosaavn.com'
};

app.get('/search', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'query required' });

    const cacheKey = 'search_' + q;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    console.log('Searching:', q);

    try {
        const url = 'https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&api_version=4&ctx=android&q=' + encodeURIComponent(q) + '&n=50&p=1';
        const r = await axios.get(url, { headers: HEADERS, timeout: 10000 });
        const results = r.data && r.data.results ? r.data.results : [];
        if (results.length > 0) {
            const songs = results.map(function(item) {
                return {
                    id: item.id,
                    title: decodeHtml(item.title || item.song || 'Unknown'),
                    artist: decodeHtml(parseArtist(item)),
                    thumbnail: (item.image || '').replace('50x50', '500x500').replace('150x150', '500x500'),
                    duration: item.duration || ''
                };
            });
            cache.set(cacheKey, songs);
            return res.json(songs);
        }
    } catch (e) {
        console.error('JioSaavn search error:', e.message);
    }

    try {
        const url = 'https://www.jiosaavn.com/api.php?__call=autocomplete.get&_format=json&_marker=0&cc=in&includeMetaTags=1&q=' + encodeURIComponent(q);
        const r = await axios.get(url, { headers: HEADERS, timeout: 10000 });
        const data = r.data && r.data.songs && r.data.songs.data ? r.data.songs.data : [];
        if (data.length > 0) {
            const songs = data.map(function(item) {
                return {
                    id: item.id,
                    title: decodeHtml(item.title || item.song || 'Unknown'),
                    artist: decodeHtml(parseArtist(item)),
                    thumbnail: (item.image || '').replace('50x50', '500x500').replace('150x150', '500x500'),
                    duration: item.duration || ''
                };
            });
            cache.set(cacheKey, songs);
            return res.json(songs);
        }
    } catch (e) {
        console.error('JioSaavn autocomplete error:', e.message);
    }

    res.status(500).json({ error: 'Search failed' });
});

app.get('/encrypted/:songId', async (req, res) => {
    const songId = req.params.songId;
    console.log('Encrypted request for:', songId);

    const cacheKey = 'enc_' + songId;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    try {
        const url = 'https://www.jiosaavn.com/api.php?__call=song.getDetails&cc=in&_marker=0&_format=json&pids=' + songId;
        const r = await axios.get(url, { headers: HEADERS, timeout: 12000 });
        const songObj = r.data[songId] || r.data;
        const encrypted = songObj.encrypted_media_url || '';
        const plain = songObj.media_url || songObj.vlink || '';

        if (encrypted) {
            const result = { encrypted: encrypted, plain: plain };
            cache.set(cacheKey, result);
            return res.json(result);
        }
        if (plain && plain.indexOf('jiotune') === -1) {
            const result = { encrypted: '', plain: plain };
            cache.set(cacheKey, result);
            return res.json(result);
        }
        res.status(404).json({ error: 'No URL found' });
    } catch (e) {
        console.error('Encrypted error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

function parseArtist(item) {
    const direct = item.primary_artists || item.singers || item.music || '';
    if (direct && direct.indexOf('{') !== 0 && direct.trim() !== '') {
        return direct;
    }
    try {
        const moreInfo = item.more_info;
        if (typeof moreInfo === 'object' && moreInfo !== null) {
            const a = moreInfo.primary_artists || moreInfo.singers || moreInfo.music || '';
            if (a && a.trim() !== '') return a;
        }
        if (typeof moreInfo === 'string' && moreInfo.indexOf('{') === 0) {
            const info = JSON.parse(moreInfo);
            const a = info.primary_artists || info.singers || info.music || '';
            if (a && a.trim() !== '') return a;
        }
    } catch (e) {}
    const subtitle = item.subtitle || item.description || '';
    if (subtitle && subtitle.trim() !== '') {
        return subtitle.split(' - ')[0].trim();
    }
    return 'Unknown Artist';
}

function decodeHtml(text) {
    return (text || '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

app.get('/', function(req, res) {
    res.json({ status: 'Beatify API running', version: '4.0' });
});

app.listen(PORT, function() {
    console.log('Beatify server on port ' + PORT);
});
