/**
 * ESC Configurator Backend Server
 *
 * Runs on the companion computer. Handles all serial/protocol logic.
 * The browser connects via WebSocket and sends high-level JSON commands.
 *
 * HTTP  GET /ports           — list serial + pts ports as JSON
 * HTTP  GET /versions/:fw    — list firmware versions for a given firmware name
 * WS        /               — JSON command/event channel
 *
 * Usage:
 *   node server.js [port] [host]
 *   Defaults: port=8080, host=0.0.0.0
 */

'use strict';

import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { SerialPort } from 'serialport';

import Serial from './Serial.js';
import AM32Bootloader from './AM32Bootloader.js';
import { fetchHexCached } from './Fetch.js';
import { getMasterSettings } from './helpers/Settings.js';
import { delay } from './helpers/General.js';
import { setConfig } from './helpers/General.js';
import { TimeoutError } from './helpers/QueueProcessor.js';
import { MessageNotOkError } from './Errors.js';

import {
  am32Source,
  blheliAtmelSource,
  blheliSilabsSource,
  blheliSSource,
  bluejaySource,
} from './sources/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_PORT = parseInt(process.argv[2] || '3000', 10);
const SERVER_HOST = process.argv[3] || '0.0.0.0';

// Path to the built React app (served as static files)
const STATIC_DIR = path.resolve(__dirname, '../build');

// ---------------------------------------------------------------------------
// HTTP server — static files + /ports REST endpoint
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // List serial ports
  if (req.method === 'GET' && url.pathname === '/ports') {
    try {
      const ports = await SerialPort.list();
      let ptsPorts = [];
      try {
        ptsPorts = fs.readdirSync('/dev/pts')
          .filter((name) => name !== 'ptmx' && /^\d+$/.test(name))
          .map((name) => ({ path: `/dev/pts/${name}` }));
      } catch (_) { /* headless, no pts */ }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([...ports, ...ptsPorts]));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Serve static React build
  let filePath = path.join(STATIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(STATIC_DIR, 'index.html'); // SPA fallback
  }

  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };

  res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

// ---------------------------------------------------------------------------
// WebSocket server — one session per browser connection
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('[backend] Browser connected');

  /** @type {Serial|null} */
  let serial = null;
  /** @type {AM32Bootloader|null} */
  let am32 = null;
  let lastConnected = 0;
  let progressReferences = {};
  let directMode = false;

  // Helper: send JSON event to browser
  const send = (obj) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  };

  // Helper: log message forwarded to browser
  const logCallback = (message, params = {}) => {
    send({ event: 'log', message, params });
  };

  // Helper: packet error counter forwarded as log
  const packetErrorCallback = (count) => {
    send({ event: 'packetErrors', count });
  };

  // ---------------------------------------------------------------------------
  // Command handlers
  // ---------------------------------------------------------------------------

  async function handleConnect({ port, baudRate = 115200, direct = false }) {
    // Close any existing connections
    if (am32) { try { await am32.close(); } catch (_) {} am32 = null; }
    if (serial) { try { await serial.close(); } catch (_) {} serial = null; }

    directMode = direct;

    // ---------------------------------------------------------------------------
    // Direct mode: AM32 native bootloader — open port once via AM32Bootloader.
    // ---------------------------------------------------------------------------
    if (direct) {
      am32 = new AM32Bootloader(port, 19200);
      am32.setLogCallback((msg) => send({ event: 'log', message: msg, params: {} }));

      try {
        await am32.open();
        const info = await am32.connect();
        send({
          event: 'connected',
          apiVersion: '1.39.0',
          fc: {
            variant: 'AM32-DIRECT',
            version: '0.0.0',
            build: `Direct AM32 bootloader — MCU: ${info.mcuType}`,
            board: port,
            boardVersion: '',
            uid: '000000000000',
          },
          features: {},
          motorCount: 1,
        });
      } catch (e) {
        send({ event: 'error', cmd: 'connect', message: e.message });
        try { await am32.close(); } catch (_) {}
        am32 = null;
        serial = null;
      }
      return;
    }

    // ---------------------------------------------------------------------------
    // Normal mode: FC connected, use MSP then 4-way interface.
    // ---------------------------------------------------------------------------
    serial = new Serial(port);
    serial.setLogCallback(logCallback);

    try {
      await serial.open(baudRate);
      serial.setPacketErrorCallback(packetErrorCallback);
    } catch (e) {
      send({ event: 'error', cmd: 'connect', message: e.message });
      serial = null;
      return;
    }

    try {
      let apiVersion = null;

      try {
        apiVersion = await serial.getApiVersion();
      } catch (e) {
        if (e instanceof TimeoutError) {
          // Try resetting leftover 4-way state
          let i = 0;
          try {
            while (await serial.getFourWayInterfaceInfo(i)) {
              await serial.resetFourWayInterface(i);
              i += 1;
            }
          } catch (ex) {
            if (!(ex instanceof MessageNotOkError)) {
              send({ event: 'error', cmd: 'connect', message: `Reset ESC ${i + 1} failed` });
              throw ex;
            }
          } finally {
            if (i > 0) await serial.exitFourWayInterface();
          }
          apiVersion = await serial.getApiVersion();
        } else {
          throw e;
        }
      }

      const fcVariant = await serial.getFcVariant();
      const fcVersion = await serial.getFcVersion();
      const buildInfo = await serial.getBuildInfo();
      const boardInfo = await serial.getBoardInfo();
      const uid = (await serial.getUid()).uid;
      const features = await serial.getFeatures();
      let motorData = await serial.getMotorData();
      motorData = motorData.filter((m) => m > 0);

      send({
        event: 'connected',
        apiVersion: apiVersion.apiVersion,
        fc: {
          variant: fcVariant.flightControllerIdentifier,
          version: fcVersion.flightControllerVersion,
          build: buildInfo.buildInfo,
          board: boardInfo.boardIdentifier,
          boardVersion: boardInfo.boardVersion,
          uid: uid.map((v) => v.toString(16)).join(''),
        },
        features,
        motorCount: motorData.length,
      });
    } catch (e) {
      send({ event: 'error', cmd: 'connect', message: e.message });
      try { await serial.close(); } catch (_) {}
      serial = null;
    }
  }

  async function handleDisconnect() {
    if (!serial && !am32) { send({ event: 'disconnected' }); return; }

    try {
      if (directMode && am32) {
        await am32.close();
        am32 = null;
      } else if (!directMode && serial) {
        const escCount = lastConnected;
        for (let i = 0; i < escCount; i += 1) {
          try { await serial.resetFourWayInterface(i); } catch (_) {}
        }
        await serial.exitFourWayInterface();
        await serial.close();
      }
    } catch (_) {}

    serial = null;
    lastConnected = 0;
    directMode = false;
    progressReferences = {};
    send({ event: 'disconnected' });
  }

  async function handleReadEscs() {
    if (!directMode && !serial) { send({ event: 'error', cmd: 'readEscs', message: 'Not connected' }); return; }

    send({ event: 'stateChange', isReading: true });

    const individual = [];

    // -------------------------------------------------------------------------
    // Direct mode: AM32 native bootloader — read EEPROM settings directly
    // -------------------------------------------------------------------------
    if (directMode) {
      if (!am32 || !am32.connected) {
        send({ event: 'error', cmd: 'readEscs', message: 'AM32 bootloader not connected' });
        send({ event: 'stateChange', isReading: false });
        return;
      }

      try {
        const raw = await am32.readSettings();

        // Build a minimal ESC info object matching what the frontend expects
        const escInfo = {
          index: 0,
          am32Direct: true,
          eepromAddress: raw.eepromAddress,
          settingsArray: raw.settingsArray,
          rawArray: raw.rawArray,
          settings: buildAM32Settings(raw.settingsArray),
          defaultSettings: {},
          meta: { interfaceMode: 4, signature: 0x1F06 }, // ARMBLB, AM32
          layout: null,
          layoutSize: 48,
          individualSettings: {},
        };

        lastConnected = 1;
        send({ event: 'escRead', index: 0, data: serializeEsc(escInfo) });
        send({
          event: 'escsReady',
          individual: [serializeEsc(escInfo)],
          master: {},
          fourWay: false,
          connected: 1,
        });
      } catch (e) {
        send({ event: 'error', cmd: 'readEscs', message: e.message });
      }

      send({ event: 'stateChange', isReading: false });
      return;
    }

    // -------------------------------------------------------------------------
    // Normal mode: FC passthrough → FourWay
    // -------------------------------------------------------------------------
    let connected = 0;
    let fourWay = true;

    try {
      if (lastConnected === 0) {
        const result = await serial.enable4WayInterface();
        connected = result.connectedESCs;
        await serial.startFourWayInterface();
        await delay(1200);
      } else {
        connected = lastConnected;
      }
    } catch (e) {
      fourWay = false;
      send({ event: 'log', message: 'fourWayFailed', params: {} });
    }

    for (let i = 0; i < connected; i += 1) {
      try {
        const settings = await serial.getFourWayInterfaceInfo(i);
        settings.index = i;
        individual.push(settings);
        send({ event: 'escRead', index: i, data: serializeEsc(settings) });
      } catch (e) {
        send({ event: 'log', message: 'readEscFailed', params: { index: i + 1 } });
      }
    }

    lastConnected = connected;
    const master = getMasterSettings(individual);

    send({
      event: 'escsReady',
      individual: individual.map(serializeEsc),
      master,
      fourWay,
      connected,
    });
    send({ event: 'stateChange', isReading: false });
  }

  async function handleWriteSettings({ individual, master }) {
    if (!serial && !am32) { send({ event: 'error', cmd: 'writeSettings', message: 'Not connected' }); return; }

    send({ event: 'stateChange', isWriting: true });

    if (directMode && am32) {
      const esc = individual[0];
      if (esc) {
        try {
          const settings48 = Buffer.from(esc.settingsArray.slice(0, 48));
          await am32.writeSettings(settings48);
          send({ event: 'settingsWritten', individual });
        } catch (e) {
          send({ event: 'error', cmd: 'writeSettings', message: e.message });
          send({ event: 'log', message: `writeSettingsFailed: ${e.message}`, params: { index: 1 } });
        }
      }
      send({ event: 'stateChange', isWriting: false });
      return;
    }

    const updatedIndividual = [...individual];

    for (let i = 0; i < individual.length; i += 1) {
      const esc = individual[i];
      const target = esc.index;

      const mergedSettings = {
        ...esc.settings,
        ...master,
        ...esc.individualSettings,
      };

      try {
        await serial.writeSettings(target, esc, mergedSettings);
        const newInfo = await serial.getFourWayInterfaceInfo(target);
        newInfo.index = target;
        updatedIndividual[i] = serializeEsc(newInfo);
      } catch (e) {
        send({ event: 'log', message: 'writeSettingsFailed', params: { index: i + 1 } });
      }
    }

    send({ event: 'settingsWritten', individual: updatedIndividual });
    send({ event: 'stateChange', isWriting: false });
  }

  async function handleResetDefaults({ individual }) {
    if (!serial && !am32) { send({ event: 'error', cmd: 'resetDefaults', message: 'Not connected' }); return; }

    send({ event: 'stateChange', isWriting: true });

    for (let i = 0; i < individual.length; i += 1) {
      const esc = individual[i];
      const target = esc.index;
      const mergedSettings = { ...esc.settings, ...esc.defaultSettings };
      try {
        await serial.writeSettings(target, esc, mergedSettings);
      } catch (e) {
        send({ event: 'log', message: 'restoreSettingsFailed', params: { index: i + 1 } });
      }
    }

    send({ event: 'stateChange', isWriting: false });

    // Re-read ESCs after reset
    await handleReadEscs();
  }

  async function handleFlash({ hexText, hexUrl, targets, individual, force = false, migrate = false }) {
    if (!serial && !am32) { send({ event: 'error', cmd: 'flash', message: 'Not connected' }); return; }

    send({ event: 'stateChange', isFlashing: true });

    // Direct AM32 bootloader mode — flash firmware binary directly
    if (directMode && am32) {
      let text = hexText;
      if (!text && hexUrl) {
        try { text = await fetchHexCached(hexUrl); } catch (e) {
          send({ event: 'error', cmd: 'flash', message: 'Failed to fetch firmware' });
          send({ event: 'stateChange', isFlashing: false });
          return;
        }
      }
      if (!text) {
        send({ event: 'error', cmd: 'flash', message: 'No firmware provided' });
        send({ event: 'stateChange', isFlashing: false });
        return;
      }

      try {
        // Convert Intel HEX to binary
        const binary = hexToBinary(text);
        await am32.flashFirmware(binary, (percent) => {
          send({ event: 'progress', target: 0, percent });
        });
        send({ event: 'flashComplete', target: 0, data: null });
      } catch (e) {
        send({ event: 'flashError', target: 0, message: e.message });
      }

      send({ event: 'stateChange', isFlashing: false });
      return;
    }

    let text = hexText;
    if (!text && hexUrl) {
      try {
        text = await fetchHexCached(hexUrl);
      } catch (e) {
        send({ event: 'error', cmd: 'flash', message: 'Failed to fetch firmware' });
        send({ event: 'stateChange', isFlashing: false });
        return;
      }
    }

    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      const esc = individual.find((e) => e.index === target);

      try {
        await serial.flashPreflight(esc, text, force);
      } catch (e) {
        send({ event: 'flashError', target, message: e.message });
        continue;
      }

      const cbProgress = (percent) => {
        send({ event: 'progress', target, percent });
      };

      send({ event: 'log', message: 'flashingEsc', params: { index: target + 1 } });

      try {
        const result = await serial.writeHex(target, esc, text, force, migrate, cbProgress);
        cbProgress(0);
        if (result) {
          result.index = target;
          send({ event: 'flashComplete', target, data: serializeEsc(result) });
        } else {
          send({ event: 'log', message: 'flashingEscFailed', params: { index: target + 1 } });
        }
      } catch (e) {
        send({ event: 'flashError', target, message: e.message });
      }
    }

    send({ event: 'stateChange', isFlashing: false });
  }

  async function handleReadFirmware({ target, individual }) {
    if (!serial && !am32) { send({ event: 'error', cmd: 'readFirmware', message: 'Not connected' }); return; }

    const esc = individual.find((e) => e.index === target);
    send({ event: 'stateChange', isFlashing: true });

    const cbProgress = (percent) => send({ event: 'progress', target, percent });

    try {
      const dataBin = await serial.readFirmware(target, esc, cbProgress);
      cbProgress(0);
      // Send as base64-encoded binary
      const b64 = Buffer.from(dataBin).toString('base64');
      send({ event: 'firmwareDump', target, data: b64 });
    } catch (e) {
      send({ event: 'error', cmd: 'readFirmware', message: e.message });
    }

    send({ event: 'stateChange', isFlashing: false });
  }

  async function handleMotorSpeed({ index, speed }) {
    if (!serial || directMode) return;
    try {
      if (index === -1) {
        await serial.spinAllMotors(speed);
      } else {
        await serial.spinMotor(index, speed);
      }
    } catch (e) {
      send({ event: 'error', cmd: 'motorSpeed', message: e.message });
    }
  }

  async function handleGetBatteryState() {
    if (!serial || directMode) return;
    try {
      const battery = await serial.getBatteryState();
      send({ event: 'batteryState', ...battery });
    } catch (e) {
      send({ event: 'error', cmd: 'getBatteryState', message: e.message });
    }
  }

  async function handleGetVersions({ firmware }) {
    const sourceMap = {
      AM32: am32Source,
      BLHeli_S: blheliSSource,
      Bluejay: bluejaySource,
      BLHeli: blheliAtmelSource,
      BLHeliSilabs: blheliSilabsSource,
    };
    const source = sourceMap[firmware];
    if (!source) {
      send({ event: 'error', cmd: 'getVersions', message: `Unknown firmware: ${firmware}` });
      return;
    }
    try {
      const versions = await source.getVersions();
      send({ event: 'versions', firmware, versions });
    } catch (e) {
      send({ event: 'error', cmd: 'getVersions', message: e.message });
    }
  }

  // ---------------------------------------------------------------------------
  // Message dispatch
  // ---------------------------------------------------------------------------
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      send({ event: 'error', message: 'Invalid JSON' });
      return;
    }

    const { cmd, ...payload } = msg;

    try {
      switch (cmd) {
        case 'connect':       await handleConnect(payload); break;
        case 'disconnect':    await handleDisconnect(); break;
        case 'readEscs':      await handleReadEscs(); break;
        case 'writeSettings': await handleWriteSettings(payload); break;
        case 'resetDefaults': await handleResetDefaults(payload); break;
        case 'flash':         await handleFlash(payload); break;
        case 'readFirmware':  await handleReadFirmware(payload); break;
        case 'motorSpeed':    await handleMotorSpeed(payload); break;
        case 'getBatteryState': await handleGetBatteryState(); break;
        case 'getVersions':   await handleGetVersions(payload); break;
        default:
          send({ event: 'error', message: `Unknown command: ${cmd}` });
      }
    } catch (e) {
      console.error(`[backend] Unhandled error in ${cmd}:`, e);
      send({ event: 'error', cmd, message: e.message });
    }
  });

  ws.on('close', async () => {
    console.log('[backend] Browser disconnected');
    if (serial) {
      try { await serial.close(); } catch (_) {}
      serial = null;
    }
  });

  ws.on('error', (err) => {
    console.error('[backend] WebSocket error:', err.message);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse Intel HEX text into a binary Buffer starting at address 0.
 * Only handles record types 0x00 (data) and 0x01 (EOF).
 */
function hexToBinary(hexText) {
  const lines = hexText.split(/\r?\n/);
  let maxAddr = 0;

  // First pass: find max address to size the buffer
  for (const line of lines) {
    if (!line.startsWith(':')) continue;
    const byteCount = parseInt(line.slice(1, 3), 16);
    const address = parseInt(line.slice(3, 7), 16);
    const type = parseInt(line.slice(7, 9), 16);
    if (type === 0x00) maxAddr = Math.max(maxAddr, address + byteCount);
  }

  const buf = Buffer.alloc(maxAddr, 0xFF);

  for (const line of lines) {
    if (!line.startsWith(':')) continue;
    const byteCount = parseInt(line.slice(1, 3), 16);
    const address = parseInt(line.slice(3, 7), 16);
    const type = parseInt(line.slice(7, 9), 16);
    if (type === 0x01) break; // EOF
    if (type !== 0x00) continue;
    for (let i = 0; i < byteCount; i++) {
      buf[address + i] = parseInt(line.slice(9 + i * 2, 11 + i * 2), 16);
    }
  }

  return buf;
}

/**
 * Build a minimal settings object from raw 48-byte AM32 EEPROM array.
 * Byte offsets from AM32 eeprom.js LAYOUT.
 */
function buildAM32Settings(arr) {
  const dec = new TextDecoder();
  const nameBytes = arr.slice(5, 17);
  return {
    BOOT_BYTE: arr[0],
    LAYOUT_REVISION: arr[1],
    BOOT_LOADER_REVISION: arr[2],
    MAIN_REVISION: arr[3],
    SUB_REVISION: arr[4],
    NAME: dec.decode(Uint8Array.from(nameBytes).filter((b) => b !== 0)),
  };
}

/**
 * Strip non-serializable fields (Uint8Array → plain Array, etc.) from an ESC
 * info object so it can be sent as JSON.
 */
function serializeEsc(esc) {
  if (!esc) return null;
  const out = { ...esc };

  // Convert any Uint8Array/TypedArrays to plain arrays
  for (const [k, v] of Object.entries(out)) {
    if (v instanceof Uint8Array || ArrayBuffer.isView(v)) {
      out[k] = Array.from(v);
    }
  }

  return out;
}

server.listen(SERVER_PORT, SERVER_HOST, () => {
  console.log(`[backend] ESC Configurator backend listening on ${SERVER_HOST}:${SERVER_PORT}`);
  console.log(`[backend] Ports endpoint: http://${SERVER_HOST}:${SERVER_PORT}/ports`);
  console.log(`[backend] WebSocket endpoint: ws://${SERVER_HOST}:${SERVER_PORT}`);
  console.log(`[backend] Serving React app from: ${STATIC_DIR}`);
});
