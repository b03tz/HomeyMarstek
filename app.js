'use strict';

const Homey = require('homey');
const dgram = require('dgram');
const { buildPayload, decodeResponse } = require('./lib/marstek-ct-protocol');

class MarstekApp extends Homey.App {

  async onInit() {
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.socket = null;
    this._recreating = false;

    await this._initSocket();
    this.log('Marstek Energy app started');
  }

  async _initSocket() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      sock.on('message', (msg, rinfo) => {
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

      sock.on('error', (err) => {
        this.error('UDP socket error:', err.message);
        if (!this.socket) {
          reject(err);
        } else {
          this._recreateSocket();
        }
      });

      sock.on('close', () => {
        this.log('UDP socket closed unexpectedly');
        if (this.socket) {
          this.socket = null;
          this._recreateSocket();
        }
      });

      sock.bind(30000, () => {
        sock.setBroadcast(true);
        this.socket = sock;
        this.log('UDP socket bound to port 30000');
        resolve();
      });
    });
  }

  async _recreateSocket() {
    if (this._recreating) return;
    this._recreating = true;

    // Reject all pending requests immediately (fast failure)
    for (const [id, req] of this.pendingRequests) {
      this.homey.clearTimeout(req.timer);
      req.reject(new Error('Socket reconnecting'));
    }
    this.pendingRequests.clear();

    if (this.socket) {
      try {
        this.socket.removeAllListeners('error');
        this.socket.removeAllListeners('close');
        this.socket.close();
      } catch (e) { /* already closed */ }
      this.socket = null;
    }

    const delays = [2000, 5000, 10000, 30000, 60000];
    for (let i = 0; i < delays.length; i++) {
      this.log(`Recreating socket in ${delays[i] / 1000}s (attempt ${i + 1}/${delays.length})...`);
      await new Promise(r => this.homey.setTimeout(r, delays[i]));
      try {
        await this._initSocket();
        this.log('Socket recreated successfully');
        this._recreating = false;
        return;
      } catch (err) {
        this.error(`Socket recreation attempt ${i + 1} failed:`, err.message);
      }
    }

    this.error('Failed to recreate socket after all attempts');
    this._recreating = false;
  }

  // ── Battery commands (JSON protocol) ────────────────

  sendCommand(ip, port, method, params = { id: 0 }, timeout = 5000) {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        return reject(new Error('Socket not ready'));
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
    if (!this.socket) throw new Error('Socket not ready');

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
        return reject(new Error('Socket not ready'));
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

      this.socket.send(payload, port, host, (err) => {
        if (err) {
          if (!settled) {
            settled = true;
            this.homey.clearTimeout(timer);
            this.socket.removeListener('message', collector);
            reject(err);
          }
        }
      });
    });
  }

  async discoverMeters(port = 12345) {
    if (!this.socket) throw new Error('Socket not ready');

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
      try { this.socket.removeAllListeners(); this.socket.close(); } catch (e) { /* */ }
      this.socket = null;
    }
  }

}

module.exports = MarstekApp;
