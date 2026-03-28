'use strict';

const Homey = require('homey');
const dgram = require('dgram');

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
            clearTimeout(req.timer);
            this.pendingRequests.delete(key);
            req.resolve(data);
          }
        } catch (e) {
          this.error('UDP parse error:', e.message);
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
