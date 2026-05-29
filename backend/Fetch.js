// Node.js fetch backend using node-fetch with simple in-memory cache.
// Drop-in replacement for the browser Fetch.js used by source classes.

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fetch from 'node-fetch';

// Load settings.json — try the source tree first, then the build output,
// then fall back to a hard-coded default so the backend works when only
// backend/ and build/ are deployed to the companion.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let corsProxy = 'https://cors.bubblesort.me/?';
for (const candidate of [
  path.resolve(__dirname, '../src/settings.json'),
  path.resolve(__dirname, '../build/settings.json'),
]) {
  try {
    corsProxy = require(candidate).corsProxy || corsProxy;
    break;
  } catch (_) { /* try next */ }
}

const ONE_DAY = 24 * 60 * 60 * 1000;
const ONE_YEAR = ONE_DAY * 365;

// Simple in-memory cache: url → { data, cachedAt }
const jsonCache = new Map();
const hexCache = new Map();

async function fetchProxy(url) {
  return fetch(`${corsProxy}${url}`);
}

async function fetchResponse(url) {
  let response = await fetch(url);
  if (!response.ok) {
    response = await fetchProxy(url);
    if (!response.ok) {
      throw new Error(response.statusText);
    }
  }
  return response;
}

async function fetchJsonCached(url, skip = false, maxAge = ONE_DAY) {
  const cached = jsonCache.get(url);
  if (!skip && cached && (Date.now() - cached.cachedAt) < maxAge) {
    return cached.data;
  }

  const response = await fetchResponse(url);
  const data = await response.json();
  jsonCache.set(url, { data, cachedAt: Date.now() });
  return data;
}

async function fetchHexCached(url, maxAge = ONE_YEAR) {
  const cached = hexCache.get(url);
  if (cached && (Date.now() - cached.cachedAt) < maxAge) {
    return cached.data;
  }

  const response = await fetchProxy(url);
  if (!response.ok) {
    throw new Error(response.statusText);
  }
  const data = await response.text();
  hexCache.set(url, { data, cachedAt: Date.now() });
  return data;
}

export {
  fetchJsonCached,
  fetchHexCached,
  fetchResponse,
};
