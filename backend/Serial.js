import { SerialPort } from 'serialport';
import Msp from './Msp.js';
import FourWay from './FourWay.js';
import { QueueProcessor } from './helpers/QueueProcessor.js';

class Serial {
  constructor(portPath) {
    this.portPath = portPath;
    this.baudRate = 115200;
    this.msp = null;
    this.fourWay = null;
    this.port = null;
    this.running = false;

    this.executeCommand = this.executeCommand.bind(this);
    this.getUtilization = this.getUtilization.bind(this);

    this.logCallback = null;

    this.qp = new QueueProcessor();

    this.sent = 0;
    this.sentTotal = 0;
    this.received = 0;
    this.receivedTotal = 0;
  }

  setLogCallback(logCallback) {
    this.logCallback = logCallback;
    if (this.fourWay) this.fourWay.setLogCallback(logCallback);
    if (this.msp) this.msp.setLogCallback(logCallback);
  }

  setPacketErrorCallback(cb) {
    if (this.msp) this.msp.setPacketErrorCallback(cb);
    if (this.fourWay) this.fourWay.setPacketErrorCallback(cb);
  }

  async executeCommand(buffer, responseHandler) {
    const sendHandler = async () => {
      await this.writeBuffer(buffer);
    };
    return this.qp.addCommand(sendHandler, responseHandler);
  }

  async writeBuffer(buffer) {
    if (this.port && this.port.isOpen) {
      this.sent += buffer.byteLength;
      await new Promise((resolve, reject) => {
        this.port.write(Buffer.from(buffer), (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }

  getUtilization() {
    const up = Math.round((this.sent * 10 / this.baudRate) * 100);
    const down = Math.round((this.received * 10 / this.baudRate) * 100);

    this.sentTotal += this.sent;
    this.receivedTotal += this.received;

    this.sent = 0;
    this.received = 0;

    return { up, down };
  }

  async open(baudRate = 115200) {
    this.baudRate = baudRate;

    this.port = new SerialPort({
      path: this.portPath,
      baudRate,
      autoOpen: false,
    });

    await new Promise((resolve, reject) => {
      this.port.open((err) => {
        if (err) reject(new Error(`Could not open serial port: ${err.message}`));
        else resolve();
      });
    });

    this.msp = new Msp(this.executeCommand);
    this.fourWay = new FourWay(this.executeCommand);

    if (this.logCallback) {
      this.msp.setLogCallback(this.logCallback);
      this.fourWay.setLogCallback(this.logCallback);
    }

    this.running = true;

    this.port.on('data', (data) => {
      if (this.running) {
        this.received += data.byteLength;
        this.qp.addData(new Uint8Array(data));
      }
    });

    this.port.on('error', (err) => {
      console.debug('Serial port error:', err.message);
      this.running = false;
    });
  }

  async disconnect() {
    this.running = false;

    if (this.fourWay) {
      try {
        await this.fourWay.exit();
      } catch (_) { /* best effort */ }
    }
  }

  async close() {
    this.running = false;

    if (this.msp) {
      try {
        await this.stopAllMotors();
      } catch (_) { /* best effort */ }
    }

    if (this.port && this.port.isOpen) {
      await new Promise((resolve) => {
        this.port.close(() => resolve());
      });
    }

    this.port = null;
    this.msp = null;
    this.fourWay = null;
  }

  // MSP delegation
  enable4WayInterface = () => this.msp.set4WayIf();
  getApiVersion = () => this.msp.getApiVersion();
  getBatteryState = () => this.msp.getBatteryState();
  getBoardInfo = () => this.msp.getBoardInfo();
  getBuildInfo = () => this.msp.getBuildInfo();
  getFcVariant = () => this.msp.getFcVariant();
  getFcVersion = () => this.msp.getFcVersion();
  getFeatures = () => this.msp.getFeatures();
  getMotorData = () => this.msp.getMotorData();
  getStatus = () => this.msp.getStatus();
  getUid = () => this.msp.getUid();
  spinAllMotors = (speed) => this.msp.spinAllMotors(speed);
  spinMotor = (index, speed) => this.msp.spinMotor(index, speed);
  stopAllMotors = () => this.msp.stopAllMotors();

  // FourWay delegation
  exitFourWayInterface = () => this.fourWay.exit();
  flashPreflight = (esc, hex, force) => this.fourWay.flashPreflight(esc, hex, force);
  getFourWayInterfaceInfo = (esc) => this.fourWay.getInfo(esc);
  resetFourWayInterface = (esc) => this.fourWay.reset(esc);
  startFourWayInterface = () => this.fourWay.start();
  writeHex = (index, esc, hex, force, migrate, cbProgress) => this.fourWay.writeHex(index, esc, hex, force, migrate, cbProgress);
  readAddress = (address, bytes, retries = 3) => this.fourWay.read(address, bytes, retries);
  readFirmware = (index, esc, cbProgress) => this.fourWay.readFirmware(index, esc, cbProgress);
  writeSettings = (index, esc, settings) => this.fourWay.writeSettings(index, esc, settings);
}

export default Serial;
