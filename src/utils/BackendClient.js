/**
 * BackendClient — thin WebSocket client for the ESC Configurator backend.
 *
 * Connects to the Node.js backend server running on the companion computer.
 * All serial/protocol logic runs on the backend; the browser only sends
 * commands and receives events.
 */

class BackendClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.handlers = {};
    this._connectPromise = null;
  }

  /** Register an event handler: client.on('connected', (data) => ...) */
  on(event, handler) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(handler);
    return this;
  }

  off(event, handler) {
    if (!this.handlers[event]) return;
    this.handlers[event] = this.handlers[event].filter((h) => h !== handler);
  }

  _emit(event, data) {
    (this.handlers[event] || []).forEach((h) => h(data));
    (this.handlers['*'] || []).forEach((h) => h(event, data));
  }

  connect() {
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => resolve(this);

      this.ws.onerror = () =>
        reject(new Error(`Cannot connect to backend at ${this.wsUrl}`));

      this.ws.onclose = () => {
        this._connectPromise = null;
        this._emit('wsClose', {});
      };

      this.ws.onmessage = (evt) => {
        let msg;
        try {
          msg = JSON.parse(evt.data);
        } catch (_) {
          return;
        }
        const event = msg.event;
        const payload = Object.assign({}, msg);
        delete payload.event;
        if (event) this._emit(event, payload);
      };
    });

    return this._connectPromise;
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connectPromise = null;
  }

  /** Send a command to the backend */
  send(cmd, payload = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('BackendClient: WebSocket not open');
      return;
    }
    this.ws.send(JSON.stringify({
      cmd,
      ...payload,
    }));
  }

  /** Fetch the list of serial ports from the backend HTTP endpoint */
  async getPorts() {
    const httpBase = this.wsUrl.replace(/^ws(s?)/, 'http$1').replace(/\/+$/, '');
    const response = await fetch(`${httpBase}/ports`);
    if (!response.ok) throw new Error('Failed to fetch ports from backend');
    return response.json();
  }

  // Convenience command methods
  connectSerial(port, baudRate, direct) {
    this.send('connect', {
      port,
      baudRate,
      direct: !!direct,
    });
  }

  disconnectSerial() {
    this.send('disconnect');
  }

  readEscs() {
    this.send('readEscs');
  }
  writeSettings(individual, master) {
    this.send('writeSettings', {
      individual,
      master,
    });
  }

  resetDefaults(individual) {
    this.send('resetDefaults', { individual });
  }

  flashUrl(hexUrl, targets, individual, force, migrate) {
    this.send('flash', {
      hexUrl,
      targets,
      individual,
      force,
      migrate,
    });
  }

  flashText(hexText, targets, individual, force, migrate) {
    this.send('flash', {
      hexText,
      targets,
      individual,
      force,
      migrate,
    });
  }

  readFirmware(target, individual) {
    this.send('readFirmware', {
      target,
      individual,
    });
  }

  setMotorSpeed(index, speed) {
    this.send('motorSpeed', {
      index,
      speed,
    });
  }

  setAllMotorSpeed(speed) {
    this.send('motorSpeed', {
      index: -1,
      speed,
    });
  }
  getBatteryState() {
    this.send('getBatteryState');
  }

  getVersions(firmware) {
    this.send('getVersions', { firmware });
  }
}

export default BackendClient;
