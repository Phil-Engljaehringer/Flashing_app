/**
 * WebSocket-backed Serial API
 *
 * Provides drop-in replacements for the browser's Web Serial API objects,
 * backed by a WebSocket connection to the bridge server running on the
 * companion computer (see bridge/server.js).
 *
 * WebSocketSerialApi  ≈  navigator.serial
 * WebSocketSerialPort ≈  SerialPort  (from Web Serial API)
 */

/**
 * Mimics a Web Serial API SerialPort object, but communicates over WebSocket.
 */
class WebSocketSerialPort {
  /**
   * @param {string} wsSerialUrl - Full WebSocket endpoint, e.g. ws://host:8080/serial
   * @param {{ path: string, manufacturer?: string }} portInfo - Port descriptor from /ports
   */
  constructor(wsSerialUrl, portInfo) {
    this.wsSerialUrl = wsSerialUrl;
    this.portInfo = portInfo;
    this.ws = null;
    this.readable = null;
    this.writable = null;
  }

  /**
   * Opens the serial port via WebSocket and exposes WHATWG ReadableStream /
   * WritableStream on this.readable / this.writable, matching the Web Serial
   * API contract expected by Serial.js.
   *
   * @param {{ baudRate: number }} options
   */
  async open({ baudRate }) {
    const url =
      `${this.wsSerialUrl}` +
      `?port=${encodeURIComponent(this.portInfo.path)}` +
      `&baudRate=${baudRate}`;

    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';
      this.ws.onopen = () => resolve();
      this.ws.onerror = () =>
        reject(new Error(`WebSocket bridge could not open ${this.portInfo.path}`));
    });

    const ws = this.ws;

    // Build a ReadableStream driven by incoming WebSocket messages.
    let readableController;
    this.readable = new ReadableStream({
      start(controller) {
        readableController = controller;

        ws.onmessage = (event) => {
          controller.enqueue(new Uint8Array(event.data));
        };

        ws.onclose = () => {
          try { controller.close(); } catch (_) { /* already closed */ }
        };
      },
      cancel() {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      },
    });

    // Build a WritableStream that forwards data to the WebSocket.
    this.writable = new WritableStream({
      write(chunk) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        }
      },
      close() {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      },
    });
  }

  /**
   * Closes the underlying WebSocket connection.
   */
  async close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
  }

  /**
   * Returns port metadata in the same shape as the Web Serial API.
   * The port path is surfaced as usbProductId so it appears in the
   * port-picker dropdown (e.g. "WS:/dev/ttyUSB0").
   */
  getInfo() {
    return {
      usbVendorId: 'WS',
      usbProductId: this.portInfo.path,
    };
  }
}

/**
 * Mimics navigator.serial, fetching the port list from the bridge server's
 * HTTP /ports endpoint and creating WebSocketSerialPort instances.
 */
class WebSocketSerialApi {
  /**
   * @param {string} bridgeUrl - Base URL of the bridge server, e.g. ws://192.168.1.100:8080
   *                             May use ws:// or wss:// scheme.
   */
  constructor(bridgeUrl) {
    const base = bridgeUrl.replace(/\/$/, '');
    this.wsSerialUrl = `${base}/serial`;
    // Convert ws(s):// → http(s):// for the REST /ports call
    this.httpBaseUrl = base.replace(/^ws(s?)/, 'http$1');
    this._ports = [];
  }

  /**
   * Fetches the list of available serial ports from the bridge server.
   *
   * @returns {Promise<WebSocketSerialPort[]>}
   */
  async getPorts() {
    try {
      const response = await fetch(`${this.httpBaseUrl}/ports`);
      if (!response.ok) {
        throw new Error(`Bridge server returned HTTP ${response.status}`);
      }
      const ports = await response.json();
      this._ports = ports
        .filter((p) => p.path)
        .map((p) => new WebSocketSerialPort(this.wsSerialUrl, p));
      return this._ports;
    } catch (e) {
      console.debug('WebSocket serial bridge unavailable:', e);
      return [];
    }
  }

  /**
   * Returns the first available port, mirroring the intent of
   * navigator.serial.requestPort() in contexts where there is no native
   * browser picker dialog.  Port selection is handled via the dropdown in
   * the PortPicker component.
   *
   * @returns {Promise<WebSocketSerialPort>}
   */
  async requestPort() {
    const ports = await this.getPorts();
    if (ports.length === 0) {
      throw new Error('No serial ports available on bridge server');
    }
    return ports[0];
  }

  // No-ops — the bridge has no plug/unplug events to forward.
  addEventListener() {}
  removeEventListener() {}
}

export {
  WebSocketSerialApi,
  WebSocketSerialPort,
};
