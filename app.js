'use strict';

const Homey = require('homey');
const dgram = require('dgram');
const { buildPayload, decodeResponse } = require('./lib/marstek-ct-protocol');

class MarstekApp extends Homey.App {

  async onInit() {
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.socket = null;

    await this._initSocket();
    this.log('Marstek Energy app started');
  }

  async _initSocket() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.socket.on('message', (msg, rinfo) => {
        try {
          const data = JSON.parse(msg.toString());
          const key = data.id;
          if (this.pendingRequests.has(key)) {
            const req = this.pendingRequests.get(key);
            this.homey.clearTimeout(req.timer);
            this.pendingRequests.delete(key);
            req.resolve(data);
          }
        } catch (e) {
          // Not JSON — binary CT responses are handled by temporary collectors
        }
      });

      this.socket.on('error', (err) => {
        this.error('UDP socket error:', err.message);
        reject(err);
      });

      this.socket.bind(30000, () => {
        this.socket.setBroadcast(true);
        this.log('UDP socket bound to port 30000');
        resolve();
      });
    });
  }

  // ── Battery commands (JSON protocol) ────────────────

  sendCommand(ip, port, method, params = { id: 0 }, timeout = 5000) {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        return reject(new Error('UDP socket not initialized'));
      }

      const id = ++this.requestId;
      const message = JSON.stringify({ id, method, params });

      const timer = this.homey.setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, timeout);

      this.pendingRequests.set(id, { resolve, reject, timer });

      this.socket.send(message, port, ip, (err) => {
        if (err) {
          this.homey.clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  async discover(port = 30000) {
    const devices = [];

    const collector = (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.result && data.result.device) {
          if (!devices.find(d => d.ble_mac === data.result.ble_mac)) {
            this.log(`Discovered: ${data.result.device} at ${rinfo.address}`);
            devices.push({
              ...data.result,
              ip: rinfo.address,
              port,
            });
          }
        }
      } catch (e) { /* ignore */ }
    };

    this.socket.on('message', collector);

    const message = JSON.stringify({
      id: ++this.requestId,
      method: 'Marstek.GetDevice',
      params: { ble_mac: '0' },
    });

    // Send multiple broadcasts to improve reliability
    for (let i = 0; i < 3; i++) {
      this.socket.send(message, port, '255.255.255.255');
      await new Promise(resolve => this.homey.setTimeout(resolve, 2000));
    }

    this.socket.removeListener('message', collector);

    return devices;
  }

  // ── Meter commands (binary CT protocol) ─────────────

  sendMeterCommand(host, port, deviceType, batteryMac, ctType, ctMac, timeout = 5000) {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        return reject(new Error('UDP socket not initialized'));
      }

      port = parseInt(port, 10) || 12345;
      const payload = buildPayload(deviceType, batteryMac, ctType, ctMac);
      let settled = false;

      // Use same temporary listener pattern as discovery (proven to work on Homey)
      const collector = (msg, rinfo) => {
        if (settled) return;
        try {
          const data = decodeResponse(msg);
          if (data.meter_mac && data.meter_mac === ctMac) {
            settled = true;
            this.homey.clearTimeout(timer);
            this.socket.removeListener('message', collector);
            resolve(data);
          }
        } catch (e) { /* not a CT response, ignore */ }
      };

      const timer = this.homey.setTimeout(() => {
        if (settled) return;
        settled = true;
        this.socket.removeListener('message', collector);
        reject(new Error(`Timeout: CT meter ${ctMac} at ${host}:${port}`));
      }, timeout);

      this.socket.on('message', collector);

      this.socket.send(payload, port, '255.255.255.255', (err) => {
        if (err && !settled) {
          settled = true;
          this.homey.clearTimeout(timer);
          this.socket.removeListener('message', collector);
          reject(err);
        }
      });
    });
  }

  async discoverMeters(port = 12345) {
    const meters = [];
    const payload = buildPayload('HMG-50', '000000000000', 'HME-3', '000000000000');

    const collector = (msg, rinfo) => {
      try {
        const data = decodeResponse(msg);
        if (data.meter_mac && !meters.find(m => m.meter_mac === data.meter_mac)) {
          this.log(`Discovered meter: ${data.meter_dev_type} (${data.meter_mac}) at ${rinfo.address}`);
          meters.push({ ...data, ip: rinfo.address, port });
        }
      } catch (e) { /* ignore non-meter responses */ }
    };

    this.socket.on('message', collector);

    for (let i = 0; i < 3; i++) {
      this.socket.send(payload, port, '255.255.255.255');
      await new Promise(resolve => this.homey.setTimeout(resolve, 2000));
    }

    this.socket.removeListener('message', collector);

    return meters;
  }

  // ── Cleanup ─────────────────────────────────────────

  async onUninit() {
    for (const [id, req] of this.pendingRequests) {
      this.homey.clearTimeout(req.timer);
    }
    this.pendingRequests.clear();

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

}

module.exports = MarstekApp;
