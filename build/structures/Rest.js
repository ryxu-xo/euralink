const { fetch: undiciFetch, Response } = require("undici");
const { Agent } = require("undici");
const nodeUtil = require("node:util");

class Rest {
  /**
   * @param {import('./Euralink').Euralink} eura
   * @param {Object} options - Node-specific options: host, port, secure, password, sessionId, restVersion
   */
  constructor(eura, options) {
    this.eura = eura;
    if (!options.host || !options.port || !options.password) {
      throw new Error('[Rest.js] Missing required node options: host, port, or password');
    }
    this.url = `http${options.secure ? "s" : ""}://${options.host}:${options.port}`;
    console.log('[Rest.js] Creating Agent with origin:', this.url);
    this.sessionId = options.sessionId;
    this.password = options.password;
    this.version = options.restVersion || 'v4';
    
    // Create persistent agent for better performance
    try {
      this.agent = new Agent({
        pipelining: 1, // Enable pipelining for faster requests
        connections: 100, // Increase connection pool
        tls: {
          rejectUnauthorized: false // Allow self-signed certificates
        },
        connect: {
          timeout: 10000 // Faster timeout
        },
        // Performance optimizations
        keepAliveTimeout: 60000, // Keep connections alive longer
        keepAliveMaxTimeout: 300000, // Maximum keep-alive time
        // HTTP/2 optimizations
        allowH2: true, // Enable HTTP/2
        maxConcurrentStreams: 100, // More concurrent streams
        // Buffer optimizations
        bodyTimeout: 30000, // Body timeout
        headersTimeout: 10000, // Headers timeout
      });
    } catch (error) {
      this.eura.emit("debug", `Failed to create agent: ${error.message}, falling back to default`);
      this.agent = null; // Fallback to default fetch
    }

    // Request batching for better performance
    this.pendingRequests = new Map();
    this.batchTimeout = null;
    this.batchDelay = 10; // ms
    
    // Cache for frequently accessed data
    this.cache = new Map();
    this.cacheTimeout = 30000; // 30 seconds
    
    // Smart cache for track searches
    this.trackCache = new Map();
    this.trackCacheTimeout = 300000; // 5 minutes for track searches
    
    // Cache for node info
    this.nodeInfoCache = new Map();
    this.nodeInfoCacheTimeout = 60000; // 1 minute for node info

    // Retry/timeout config
    this.maxRetries = typeof options.retryCount === 'number' ? options.retryCount : 3;
    this.requestTimeoutMs = typeof options.timeout === 'number' ? options.timeout : 15000;
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  // Batch requests for better performance
  async batchRequest(method, endpoint, body = null, includeHeaders = false) {
    try {
      const key = `${method}:${endpoint}:${JSON.stringify(body)}`;
      
      if (this.pendingRequests.has(key)) {
        return this.pendingRequests.get(key);
      }

      const promise = this.makeRequest(method, endpoint, body, includeHeaders);
      this.pendingRequests.set(key, promise);
      
      // Clean up after request completes
      promise.finally(() => {
        this.pendingRequests.delete(key);
      });

      return promise;
    } catch (error) {
      this.eura.emit('restError', error);
      throw error;
    }
  }

  async makeRequest(method, endpoint, body = null, includeHeaders = false) {
    const startTime = Date.now();
    try {
      const headers = {
        'Authorization': this.password,
        'Content-Type': 'application/json',
        'User-Agent': `Euralink/${this.version}`
      };
      const requestOptions = {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
      };
      if (this.agent) requestOptions.dispatcher = this.agent;

      const response = await this.requestWithRetry(this.url + endpoint, requestOptions);
      const responseTime = Date.now() - startTime;
      this.eura.emit(
        "debug",
        `[Rest] ${method} ${endpoint.startsWith("/") ? endpoint : `/${endpoint}`} ${body ? `body: ${JSON.stringify(body)}` : ""} -> Status: ${response.status} (${responseTime}ms)`
      );
      
      // Handle non-200 responses
      if (!response.ok) {
        const errorText = await response.text();
        let errorData;
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { message: errorText };
        }
        
        this.eura.emit("debug", `[Rest Error] ${method} ${endpoint} failed: ${response.status} - ${errorData.message || 'Unknown error'}`);
        throw new Error(`HTTP ${response.status}: ${errorData.message || 'Request failed'}`);
      }
      
      // Parse response once
      const data = await this.parseResponse(response);
      // Cache successful GET requests
      if (method === 'GET' && response.ok) {
        const cacheKey = `${method}:${endpoint}`;
        this.cache.set(cacheKey, {
          data,
          timestamp: Date.now()
        });
      }
      return includeHeaders === true ? {
        data,
        headers: response.headers,
        responseTime
      } : data;
    } catch (error) {
      this.eura.emit("debug", `Request failed: ${error.message}`);
      throw error;
    }
  }

  // Internal: execute fetch with timeout, retries, exponential backoff + jitter
  async requestWithRetry(url, options) {
    let attempt = 0;
    let lastError = null;
    while (attempt <= this.maxRetries) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const resp = await undiciFetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeout);
        // Retry on 429/5xx
        if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
          lastError = new Error(`HTTP ${resp.status}`);
          throw lastError;
        }
        return resp;
      } catch (err) {
        clearTimeout(timeout);
        lastError = err;
        attempt++;
        if (attempt > this.maxRetries) break;
        const base = 250;
        const backoff = Math.min(5000, base * Math.pow(2, attempt));
        const jitter = Math.floor(Math.random() * 100);
        await new Promise(r => setTimeout(r, backoff + jitter));
      }
    }
    throw lastError || new Error('Request failed');
  }

  async parseResponse(response) {
    try {
      if (response.status === 204) {
        return null;
      }

      const contentType = response.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        return await response.json();
      } else {
        return await response.text();
      }
    } catch (error) {
      this.eura.emit("debug", `[Rest - Error] Parse error: ${error.message}`);
      return null;
    }
  }

  async updatePlayer(options) {
    const { guildId, data } = options;
    
    return this.makeRequest(
      "PATCH",
      `/${this.version}/sessions/${this.sessionId}/players/${guildId}`,
      data
    );
  }

  async destroyPlayer(guildId) {
    return this.makeRequest(
      "DELETE",
      `/${this.version}/sessions/${this.sessionId}/players/${guildId}`
    );
  }

  async getPlayers() {
    return this.makeRequest(
      "GET",
      `/${this.version}/sessions/${this.sessionId}/players`
    );
  }

  async getTracks(identifier) {
    // Check cache first
    const cacheKey = `tracks:${identifier}`;
    const cached = this.trackCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < this.trackCacheTimeout) {
      this.eura.emit("debug", `[Rest Cache] Track cache hit for ${identifier}`);
      return cached.data;
    }
    
    const result = await this.makeRequest(
      "GET",
      `/${this.version}/loadtracks?identifier=${encodeURIComponent(identifier)}`
    );
    
    // Cache the result
    this.trackCache.set(cacheKey, {
      data: result,
      timestamp: Date.now()
    });
    
    return result;
  }

  async decodeTrack(track) {
    return this.makeRequest(
      "GET",
      `/${this.version}/decodetrack?encodedTrack=${encodeURIComponent(track)}`
    );
  }

  async decodeTracks(tracks) {
    return this.makeRequest(
      "POST",
      `/${this.version}/decodetracks`,
      { tracks }
    );
  }

  async getStats() {
    return this.makeRequest("GET", `/${this.version}/stats`);
  }

  async getInfo() {
    return this.makeRequest("GET", `/${this.version}/info`);
  }

  /**
   * Clear all REST caches.
   */
  clearAllCaches() {
    this.cache.clear();
    this.trackCache.clear();
    this.nodeInfoCache.clear();
    this.eura.emit('restCacheCleared');
  }

  /**
   * Destroy the REST client and close the Agent
   */
  destroy() {
    try {
      if (this.agent && typeof this.agent.close === 'function') {
        this.agent.close();
      }
    } catch (err) {
      this.eura.emit('debug', `[Rest.destroy] ${err.message}`);
    } finally {
      this.pendingRequests.clear();
      this.clearAllCaches();
    }
  }
}

module.exports = Rest;