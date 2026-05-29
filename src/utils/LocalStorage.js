import { serial as serialPolyfill } from 'web-serial-polyfill';

import { WebSocketSerialApi } from './WebSocketSerial';
import settings from '../settings.json';

const {
  availableLanguages,
  defaultAppSettings,
  defaultLanguage,
} = settings;

const MAX_LOG_LENGTH = 10000;

/**
 * Returns a previously stored language, an auto detected language or the
 * default language as a last fallback.
 *
 * @returns {string}
 */
function loadLanguage() {
  let storedLanguage = localStorage.getItem('language');
  if(!storedLanguage) {
    const browserLanguage = (navigator.languages && navigator.languages[0]) || navigator.language;
    if(browserLanguage) {
      for(let [, value] of Object.entries(availableLanguages)) {
        if(value.value === browserLanguage) {
          storedLanguage = browserLanguage;
          break;
        }
      }

      if(!storedLanguage && browserLanguage.split('-').length > 1) {
        const part = browserLanguage.split('-')[0];
        for(let [, value] of Object.entries(availableLanguages)) {
          if(value.value === part) {
            storedLanguage = part;
            break;
          }
        }
      }
    }
  }

  return(storedLanguage || defaultLanguage);
}

/**
 * Returns the log. If the log is longer than a set amount of lines, a truncated
 * version of the log is returned.
 *
 * @returns {Array<string>}
 */
function loadLog() {
  const storedLog = JSON.parse(localStorage.getItem('log'));
  if(storedLog) {
    return storedLog.slice(-MAX_LOG_LENGTH);
  }

  return [];
}

/**
 * Clears the log
 *
 * @returns {Array<string>}
 */
function clearLog() {
  localStorage.setItem('log', JSON.stringify([]));

  return [];
}

/**
 * Returns an array of previously stored melodies
 *
 * @returns {Array<object>}
 */
function loadMelodies() {
  const storedMelodies = JSON.parse(localStorage.getItem('melodies'));
  if(storedMelodies) {
    return storedMelodies;
  }

  return [];
}

/**
 * Returns a settings object overwriting the defaults with user saved settings
 *
 * @returns {object}
 */
function loadSettings() {
  const settings = JSON.parse(localStorage.getItem('settings')) || {};
  return {
    ...defaultAppSettings,
    ...settings,
  };
}

/**
 * Returns true if Direct ESC mode is enabled (no FC, FourWay sent straight
 * to the ESC UART).
 *
 * @returns {boolean}
 */
function loadDirectMode() {
  return localStorage.getItem('directMode') === 'true';
}

/**
 * Persists the Direct ESC mode flag.
 *
 * @param {boolean} enabled
 */
function saveDirectMode(enabled) {
  if (enabled) {
    localStorage.setItem('directMode', 'true');
  } else {
    localStorage.removeItem('directMode');
  }
}

/**
 * Returns the stored backend server URL, or null if not set.
 * The backend runs the full serial/protocol logic on the companion.
 *
 * @returns {string|null}
 */
function loadBackendUrl() {
  return localStorage.getItem('backendUrl') || null;
}

/**
 * Persists the backend server URL. Pass null or empty string to clear.
 *
 * @param {string|null} url
 */
function saveBackendUrl(url) {
  if (url) {
    localStorage.setItem('backendUrl', url.trim());
  } else {
    localStorage.removeItem('backendUrl');
  }
}

/**
 * Returns the stored WebSocket bridge URL, or null if not set.
 *
 * @returns {string|null}
 */
function loadWsUrl() {
  return localStorage.getItem('wsUrl') || null;
}

/**
 * Persists the WebSocket bridge URL.  Pass null or empty string to clear.
 *
 * @param {string|null} url
 */
function saveWsUrl(url) {
  if (url) {
    localStorage.setItem('wsUrl', url.trim());
  } else {
    localStorage.removeItem('wsUrl');
  }
}

/**
 * Checks browser and returns preferred serial API.
 * A stored WebSocket bridge URL takes precedence over the native API so the
 * app can reach serial ports on a remote companion computer.
 *
 * @returns {Serial}
 */
function loadSerialApi() {
  const wsUrl = loadWsUrl();
  if (wsUrl) {
    return new WebSocketSerialApi(wsUrl);
  }

  if('serial' in navigator) {
    return navigator.serial;
  }

  // Brave has USB support but it does not work properly with the polyfill
  if(
    'usb' in navigator &&
    !('brave' in navigator)
  ) {
    return serialPolyfill;
  }

  return null;
}

export {
  clearLog,
  loadLanguage,
  loadLog,
  loadMelodies,
  loadSerialApi,
  loadSettings,
  loadWsUrl,
  saveWsUrl,
  loadBackendUrl,
  saveBackendUrl,
  loadDirectMode,
  saveDirectMode,
};
