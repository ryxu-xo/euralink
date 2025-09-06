const undici = require("undici")

// Simple in-memory cache
const thumbnailCache = new Map();
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getCacheKey(info) {
    return `${info.sourceName}:${info.identifier || info.uri}`;
}

function setCache(key, value, ttl = DEFAULT_TTL_MS) {
    thumbnailCache.set(key, { value, expires: Date.now() + ttl });
}

function getCached(key) {
    const entry = thumbnailCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
        thumbnailCache.delete(key);
        return null;
    }
    return entry.value;
}

async function fetchWithTimeout(url, ms = 5000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ms);
    try {
        const res = await undici.fetch(url, { signal: controller.signal });
        return res;
    } finally {
        clearTimeout(timeout);
    }
}

async function getImageUrl(info) {
    const cacheKey = getCacheKey(info);
    const cached = getCached(cacheKey);
    if (cached) return cached;
    if (info.sourceName === "spotify") {
        try {
            const match = info.uri.match(/track\/([a-zA-Z0-9]+)/);
            if (match) {
                const res = await fetchWithTimeout(`https://open.spotify.com/oembed?url=${info.uri}`);
                const json = await res.json();
                const url = json.thumbnail_url || null;
                if (url) setCache(cacheKey, url);
                return url
            }
        } catch (error) {
            return null;
        }
    }

    if (info.sourceName === "soundcloud") {
        try {
            const res = await fetchWithTimeout(`https://soundcloud.com/oembed?format=json&url=${info.uri}`);
            const json = await res.json();
            const thumbnailUrl = json.thumbnail_url;
            if (thumbnailUrl) setCache(cacheKey, thumbnailUrl);
            return thumbnailUrl;
        } catch (error) {
            return null;
        }
    }

    if (info.sourceName === "youtube") {
        const maxResUrl = `https://img.youtube.com/vi/${info.identifier}/maxresdefault.jpg`;
        const hqDefaultUrl = `https://img.youtube.com/vi/${info.identifier}/hqdefault.jpg`;
        const mqDefaultUrl = `https://img.youtube.com/vi/${info.identifier}/mqdefault.jpg`;
        const defaultUrl = `https://img.youtube.com/vi/${info.identifier}/default.jpg`;

        try {
            const maxResResponse = await fetchWithTimeout(maxResUrl, 4000);

            if (maxResResponse.ok) {
                setCache(cacheKey, maxResUrl);
                return maxResUrl;
            } else {
                const hqDefaultResponse = await fetchWithTimeout(hqDefaultUrl, 4000);

                if (hqDefaultResponse.ok) {
                    setCache(cacheKey, hqDefaultUrl);
                    return hqDefaultUrl;
                } else {
                    const mqDefaultResponse = await fetchWithTimeout(mqDefaultUrl, 4000);

                    if (mqDefaultResponse.ok) {
                        setCache(cacheKey, mqDefaultUrl);
                        return mqDefaultUrl;
                    } else {
                        const defaultResponse = await fetchWithTimeout(defaultUrl, 4000);

                        if (defaultResponse.ok) {
                            setCache(cacheKey, defaultUrl);
                            return defaultUrl;
                        } else {
                            return null;
                        }
                    }
                }
            }
        } catch (error) {
            return null;
        }
    }
    return null;
}

module.exports = { getImageUrl }; 