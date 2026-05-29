/**
 * AM32Bootloader — native AM32 bootloader protocol for Node.js.
 *
 * Ported from BF_ROOTLOADER.cpp and widget.cpp of the Offline Configurator
 * (Offline-Configurator-1.95, C++ / Qt source).
 *
 * The AM32 ESC has a bootloader that speaks a simple custom protocol
 * (NOT FourWay). When the ESC powers on it sends 0xC1 every ~100ms waiting
 * for a host to connect. The host initiates with a 21-byte magic packet and
 * then communicates using address/buffer-size/data/write-flash commands, each
 * protected by CRC-16/Modbus.
 *
 * Protocol summary:
 *   setAddress(addr)    → [0xFF, 0x00, addrHi, addrLo, crcLo, crcHi]
 *   setBufferSize(size) → [0xFE, 0x00, 0x00, size, crcLo, crcHi]
 *   sendBuffer(data)    → [...data, crcLo, crcHi]
 *   writeFlash()        → [0x01, 0x01, crcLo, crcHi]
 *   readFlash(size)     → [0x03, size, crcLo, crcHi]
 *
 *   ACK byte from ESC: 0x30 = success
 *
 * MCU types (from readInitData byte[4]):
 *   0x2B → G071 (2 KB page, eeprom at 0x7E00, divides address by 4)
 *   0x1F → F0   (1 KB page, eeprom at 0x7C00)
 *   0x35 → F3   (2 KB page, eeprom at 0xF800)
 */

import { SerialPort } from 'serialport';

const INIT_PACKET = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x0D,
  0x42, 0x4C, 0x48, 0x65, 0x6C, 0x69, // 'BLHeli'
  0xF4, 0x7D,
]);

const ACK_OK = 0x30;
const FIRMWARE_START = 0x0200; // AM32 firmware starts at 0x0200 (512 bytes)

/**
 * CRC16-XMODEM (used by the FourWay interface trigger packet).
 */
function crc16Xmodem(buf, length) {
  let crc = 0;
  for (let i = 0; i < length; i++) {
    crc ^= buf[i] << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      else crc = (crc << 1) & 0xFFFF;
    }
  }
  return crc;
}

/**
 * FourWay cmd_DeviceInitFlash (0x37) with ARM interface type (0x02).
 * Sending this wakes the AM32 bootloader which responds with 0xC1.
 * Packet: [0x2F, 0x37, addrHi, addrLo, paramLen, param, crcHi, crcLo]
 */
function buildFourWayInitFlash() {
  const body = Buffer.from([0x2F, 0x37, 0x00, 0x00, 0x01, 0x02]);
  const crc = crc16Xmodem(body, body.length);
  return Buffer.concat([body, Buffer.from([(crc >> 8) & 0xFF, crc & 0xFF])]);
}

/**
 * CRC-16/Modbus
 */
function makeCRC(buf, length) {
  let crc = 0;
  for (let i = 0; i < length; i++) {
    let xb = buf[i];
    for (let j = 0; j < 8; j++) {
      if (((xb & 0x01) ^ (crc & 0x0001)) !== 0) {
        crc = (crc >> 1) ^ 0xA001;
      } else {
        crc >>= 1;
      }
      xb >>= 1;
    }
  }
  return crc; // low byte = crc & 0xFF, high byte = (crc >> 8) & 0xFF
}

function buildSetAddress(address) {
  const buf = Buffer.alloc(6);
  buf[0] = 0xFF;
  buf[1] = 0x00;
  buf[2] = (address >> 8) & 0xFF;
  buf[3] = address & 0xFF;
  const crc = makeCRC(buf, 4);
  buf[4] = crc & 0xFF;
  buf[5] = (crc >> 8) & 0xFF;
  return buf;
}

function buildSetBufferSize(size) {
  const s = size === 256 ? 0 : size;
  const buf = Buffer.alloc(6);
  buf[0] = 0xFE;
  buf[1] = 0x00;
  buf[2] = 0x00;
  buf[3] = s & 0xFF;
  const crc = makeCRC(buf, 4);
  buf[4] = crc & 0xFF;
  buf[5] = (crc >> 8) & 0xFF;
  return buf;
}

function buildSendBuffer(data) {
  const buf = Buffer.alloc(data.length + 2);
  data.copy(buf);
  const crc = makeCRC(buf, data.length);
  buf[data.length] = crc & 0xFF;
  buf[data.length + 1] = (crc >> 8) & 0xFF;
  return buf;
}

function buildWriteFlash() {
  const buf = Buffer.alloc(4);
  buf[0] = 0x01;
  buf[1] = 0x01;
  const crc = makeCRC(buf, 2);
  buf[2] = crc & 0xFF;
  buf[3] = (crc >> 8) & 0xFF;
  return buf;
}

function buildReadFlash(size) {
  const buf = Buffer.alloc(4);
  buf[0] = 0x03;
  buf[1] = size & 0xFF;
  const crc = makeCRC(buf, 2);
  buf[2] = crc & 0xFF;
  buf[3] = (crc >> 8) & 0xFF;
  return buf;
}

function checkCRC(buf, payloadLength) {
  // payloadLength bytes of data, then 2 bytes of CRC
  const crc = makeCRC(buf, payloadLength);
  return buf[payloadLength] === (crc & 0xFF) && buf[payloadLength + 1] === ((crc >> 8) & 0xFF);
}

class AM32Bootloader {
  constructor(portPath, baudRate = 19200) {
    this.portPath = portPath;
    this.baudRate = baudRate;
    this.port = null;

    // Discovered per-ESC
    this.eepromAddress = null;
    this.memoryDividerRequired = false; // true for G071 (divide address by 4)
    this.connected = false;

    this.logCallback = null;
    this.progressCallback = null;

    this._rxBuf = Buffer.alloc(0);
    this._rxResolve = null;
    this._rxMinBytes = 0;
    this._rxTimeout = null;
  }

  setLogCallback(cb) { this.logCallback = cb; }
  setProgressCallback(cb) { this.progressCallback = cb; }

  _log(msg) {
    if (this.logCallback) this.logCallback(msg);
    else console.debug('[AM32]', msg);
  }

  // ---------------------------------------------------------------------------
  // Low-level serial I/O
  // ---------------------------------------------------------------------------

  async open() {
    this.port = new SerialPort({
      path: this.portPath,
      baudRate: this.baudRate,
      autoOpen: false,
    });

    await new Promise((resolve, reject) => {
      this.port.open((err) => {
        if (err) reject(new Error(`Cannot open port: ${err.message}`));
        else resolve();
      });
    });

    this.port.on('data', (chunk) => {
      this._rxBuf = Buffer.concat([this._rxBuf, chunk]);

      if (this._rxResolve && this._rxBuf.length >= this._rxMinBytes) {
        clearTimeout(this._rxTimeout);
        const resolve = this._rxResolve;
        this._rxResolve = null;
        resolve(this._rxBuf);
        this._rxBuf = Buffer.alloc(0);
      }
    });
  }

  async close() {
    const wasConnected = this.connected;
    this.connected = false;

    if (this.port && this.port.isOpen) {
      // Only send reset if we actually reached the bootloader
      if (wasConnected) {
        try {
          await this._write(Buffer.from([0x00, 0x00, 0x00, 0x00]));
        } catch (_) {}
      }
      await new Promise((resolve) => this.port.close(resolve));
    }
  }

  _write(buf) {
    return new Promise((resolve, reject) => {
      this.port.write(buf, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Wait for at least `minBytes` bytes from the ESC within `timeout` ms.
   */
  _read(minBytes, timeout = 500) {
    return new Promise((resolve, reject) => {
      // Already have enough buffered
      if (this._rxBuf.length >= minBytes) {
        const data = this._rxBuf;
        this._rxBuf = Buffer.alloc(0);
        return resolve(data);
      }

      this._rxMinBytes = minBytes;
      this._rxResolve = resolve;
      this._rxTimeout = setTimeout(() => {
        this._rxResolve = null;
        const data = this._rxBuf;
        this._rxBuf = Buffer.alloc(0);
        if (data.length > 0) resolve(data);
        else reject(new Error(`AM32 read timeout (waiting for ${minBytes} bytes)`));
      }, timeout);
    });
  }

  /**
   * Flush any pending RX data.
   */
  async _flush(wait = 50) {
    this._rxBuf = Buffer.alloc(0);
    await new Promise((resolve) => setTimeout(resolve, wait));
    this._rxBuf = Buffer.alloc(0);
  }

  // ---------------------------------------------------------------------------
  // Protocol
  // ---------------------------------------------------------------------------

  /**
   * Connect to an ESC. The ESC must be in its bootloader window (just powered
   * on). Sends the 21-byte init packet and parses the response to determine
   * MCU type and EEPROM address.
   *
   * @returns {object} { eepromAddress, memoryDividerRequired, mcuType }
   */
  async connect() {
    this.connected = false;
    this._rxBuf = Buffer.alloc(0);

    // Step 1: send FourWay cmd_DeviceInitFlash (ARM type 0x02) to wake the
    // AM32 bootloader. The ESC responds with 0xC1 when ready.
    // If the ESC is already in bootloader mode (e.g. after a failed flash),
    // it will respond with 0xC2 — in that case skip the trigger and send
    // the AM32 init directly.
    this._log('Sending FourWay DeviceInitFlash trigger...');
    await this._write(buildFourWayInitFlash());

    let bootByte;
    try {
      bootByte = await this._read(1, 2000);
    } catch (e) {
      throw new Error('No bootloader response — power-cycle the ESC and retry');
    }

    const bootVal = bootByte[bootByte.length - 1];
    if (bootVal === 0xC2) {
      // Already in bootloader (e.g. after failed flash) — flush and proceed
      this._log('Got 0xC2 — ESC already in bootloader mode, skipping trigger');
      this._rxBuf = Buffer.alloc(0);
    } else if (bootVal === 0xC1) {
      this._log('Got 0xC1 — sending AM32 init packet...');
      this._rxBuf = Buffer.alloc(0);
    } else {
      throw new Error(`Unexpected boot byte: 0x${bootVal.toString(16)}`);
    }

    // Step 2: send 21-byte AM32 init
    await this._write(INIT_PACKET);

    let data;
    try {
      // Response: 9 bytes (MCU info + 0x30 ACK)
      data = await this._read(9, 2000);
    } catch (e) {
      throw new Error('No response from ESC to AM32 init packet');
    }

    // The Qt code strips the first 21 bytes if response > 21 bytes
    // (the init echo), leaving the 9-byte response
    let resp = data;
    if (resp.length > 21) {
      resp = resp.slice(21);
    }

    // byte[8] = ACK (0x30), byte[4] = MCU type
    if (resp.length < 9 || resp[8] !== ACK_OK) {
      throw new Error(`ESC did not ACK init (got 0x${resp[resp.length - 1]?.toString(16) ?? '??'})`);
    }

    const mcuByte = resp[4];
    let mcuType;

    if (mcuByte === 0x2B) {
      mcuType = 'G071';
      this.memoryDividerRequired = true;
      this.eepromAddress = 0x7E00;
    } else if (mcuByte === 0x1F) {
      mcuType = 'F0';
      this.memoryDividerRequired = false;
      this.eepromAddress = 0x7C00;
    } else if (mcuByte === 0x35) {
      mcuType = 'F3';
      this.memoryDividerRequired = false;
      this.eepromAddress = 0xF800;
    } else {
      mcuType = `unknown(0x${mcuByte.toString(16)})`;
      this.memoryDividerRequired = false;
      this.eepromAddress = 0x7C00; // safe default
    }

    this._log(`ESC connected: MCU=${mcuType}, eepromAddress=0x${this.eepromAddress.toString(16)}`);
    this.connected = true;

    return {
      eepromAddress: this.eepromAddress,
      memoryDividerRequired: this.memoryDividerRequired,
      mcuType,
    };
  }

  /**
   * Read `size` bytes starting at `address`. Returns a Buffer.
   * The Qt code reads eepromAddress - 32 to get 48+32 bytes, then strips the
   * first 4 bytes and last 2 bytes (CRC + ACK).
   */
  async readFlash(address, size) {
    await this._write(buildSetAddress(address));
    const ackAddr = await this._read(1, 500);
    if (ackAddr[ackAddr.length - 1] !== ACK_OK) {
      throw new Error('setAddress: bad ACK');
    }

    await this._write(buildReadFlash(size));
    // Response: size data bytes + 2 CRC bytes + 1 ACK = size + 3
    // (The Qt offline configurator special-cases size+7 which includes a 4-byte
    // header echo that appears in some variants but NOT with serialpassthrough.)
    const resp = await this._read(size + 3, 2000);

    if (resp[resp.length - 1] !== ACK_OK) {
      throw new Error('readFlash: bad ACK');
    }

    // If we somehow got the longer form (4-byte header prepended), strip it
    let payload = resp;
    if (payload.length === size + 4 + 2 + 1) {
      payload = payload.slice(4);
    }

    // payload = [data(size), crcLo, crcHi, ack]
    if (!checkCRC(payload, size)) {
      throw new Error('readFlash: CRC mismatch');
    }

    return payload.slice(0, size);
  }

  /**
   * Write `data` to `address`. Equivalent to Qt's sendDirect().
   * Steps: setAddress → setBufferSize → sendBuffer → writeFlash
   */
  async writeBlock(address, data) {
    // 1. Set address
    await this._write(buildSetAddress(address));
    const ack1 = await this._read(1, 500);
    if (ack1[ack1.length - 1] !== ACK_OK) {
      throw new Error(`setAddress 0x${address.toString(16)}: bad ACK 0x${ack1[ack1.length-1].toString(16)}`);
    }

    // 2. Set buffer size — no ACK, but ESC needs a small gap before data
    await this._write(buildSetBufferSize(data.length));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 3. Send buffer
    await this._write(buildSendBuffer(data));
    const ack2 = await this._read(1, 1000);
    const a2 = ack2[ack2.length - 1];
    if (a2 === 0xC2) {
      // 0xC2 = CRC error on data — caller should retry entire block
      throw new Error(`sendBuffer CRC error (0xC2) at 0x${address.toString(16)}`);
    }
    if (a2 !== ACK_OK) {
      throw new Error(`sendBuffer bad ACK 0x${a2.toString(16)} at 0x${address.toString(16)}`);
    }

    // 4. Write flash
    await this._write(buildWriteFlash());
    const ack3 = await this._read(1, 1000);
    const a3 = ack3[ack3.length - 1];
    // 0x30 = OK, 0xC1 = "page written, bootloader ready for next" — both are success
    if (a3 !== ACK_OK && a3 !== 0xC1) {
      throw new Error(`writeFlash bad ACK 0x${a3.toString(16)} at 0x${address.toString(16)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // High-level operations
  // ---------------------------------------------------------------------------

  /**
   * Read the EEPROM settings (48 bytes at eepromAddress).
   * Returns a plain JS object with the raw bytes array.
   */
  async readSettings() {
    if (!this.connected) throw new Error('Not connected');

    const addr = this.eepromAddress - 32;
    const size = 48 + 32;
    const raw = await this.readFlash(addr, size);

    // First 32 bytes are pre-EEPROM data (bootloader area), next 48 are settings
    const settings = raw.slice(32, 32 + 48);
    return {
      settingsArray: Array.from(settings),
      rawArray: Array.from(raw),
      eepromAddress: this.eepromAddress,
      mcuType: this.mcuType,
    };
  }

  /**
   * Write 48-byte EEPROM settings.
   * @param {Uint8Array|Buffer|number[]} settings48 — exactly 48 bytes
   */
  async writeSettings(settings48) {
    if (!this.connected) throw new Error('Not connected');
    const data = Buffer.from(settings48);
    if (data.length !== 48) throw new Error(`settings must be 48 bytes, got ${data.length}`);
    await this.writeBlock(this.eepromAddress, data);
  }

  /**
   * Flash a firmware binary.
   * @param {Buffer} binary — raw firmware bytes
   * @param {function} cbProgress — called with 0-100 percent
   */
  async flashFirmware(binary, cbProgress) {
    if (!this.connected) throw new Error('Not connected');

    const CHUNK_SIZE = 128;
    const PAGE_SIZE = 2048;
    const firmwareStart = FIRMWARE_START;

    // The hex buffer is indexed from address 0x0000. Skip the bootloader region
    // (0x0000..firmwareStart-1) — only flash from firmwareStart onwards.
    const flashRegion = binary.slice(firmwareStart);
    const pages = Math.floor(flashRegion.length / PAGE_SIZE);
    let index = 0;
    const total = flashRegion.length;

    for (let i = 0; i <= pages; i++) {
      for (let j = 0; j < PAGE_SIZE / CHUNK_SIZE; j++) {
        const offset = i * PAGE_SIZE + j * CHUNK_SIZE;
        if (offset >= total) break;

        const chunkEnd = Math.min(offset + CHUNK_SIZE, total);
        const chunk = flashRegion.slice(offset, chunkEnd);

        // Pad to CHUNK_SIZE if partial
        const padded = Buffer.alloc(CHUNK_SIZE, 0xFF);
        chunk.copy(padded);

        let address = firmwareStart + offset;
        if (this.memoryDividerRequired) {
          address = address >> 2;
        }

        let written = false;
        for (let retry = 0; retry < 8; retry++) {
          try {
            await this.writeBlock(address, padded);
            written = true;
            break;
          } catch (e) {
            this._log(`Retry ${retry + 1} for chunk at 0x${address.toString(16)}: ${e.message}`);
          }
        }

        if (!written) {
          throw new Error(`Flash failed at offset 0x${offset.toString(16)}`);
        }

        index = chunkEnd;
        if (cbProgress) cbProgress(Math.round((index * 100) / total));
      }
    }

    if (cbProgress) cbProgress(0);
    this._log('Flash complete');
  }
}

export default AM32Bootloader;
export { FIRMWARE_START };
