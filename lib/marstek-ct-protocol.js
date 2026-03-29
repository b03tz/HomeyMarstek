'use strict';

const dgram = require('dgram');

const SOH = 0x01;
const STX = 0x02;
const ETX = 0x03;
const SEPARATOR = '|';
const DEFAULT_PORT = 12345;

const RESPONSE_LABELS = [
  'meter_dev_type', 'meter_mac', 'battery_dev_type', 'battery_mac',
  'a_phase_power', 'b_phase_power', 'c_phase_power', 'a_charge_power',
  'b_charge_power', 'c_charge_power', 'total_power', 'a_discharge_power',
  'b_discharge_power', 'c_discharge_power', 'total_charge_power', 'total_discharge_power',
  'a_chrg_nb', 'b_chrg_nb', 'c_chrg_nb', 'abc_chrg_nb', 'wifi_rssi',
  'info_idx', 'x_chrg_energy', 'a_chrg_energy', 'b_chrg_energy', 'c_chrg_energy',
  'abc_chrg_energy', 'x_dchrg_energy', 'a_dchrg_energy', 'b_dchrg_energy',
  'c_dchrg_energy', 'abc_dchrg_energy',
];

function buildPayload(deviceType, batteryMac, ctType, ctMac) {
  const fields = [deviceType, batteryMac, ctType, ctMac, '0', '0'];
  const messageStr = SEPARATOR + fields.join(SEPARATOR);
  const messageBytes = Buffer.from(messageStr, 'ascii');

  let baseSize = 1 + 1 + messageBytes.length + 1 + 2;
  let totalLength = baseSize + String(baseSize + 2).length;
  if (String(totalLength).length !== String(baseSize + 2).length) {
    totalLength = baseSize + String(totalLength).length;
  }

  const buf = Buffer.alloc(2 + String(totalLength).length + messageBytes.length + 1 + 2);
  let offset = 0;
  buf[offset++] = SOH;
  buf[offset++] = STX;
  const lenStr = String(totalLength);
  buf.write(lenStr, offset, 'ascii');
  offset += lenStr.length;
  messageBytes.copy(buf, offset);
  offset += messageBytes.length;
  buf[offset++] = ETX;

  let xor = 0;
  for (let i = 0; i < offset; i++) xor ^= buf[i];
  buf.write(xor.toString(16).padStart(2, '0'), offset, 'ascii');

  return buf.slice(0, offset + 2);
}

function decodeResponse(data) {
  const body = data.slice(4, data.length - 3).toString('ascii');
  const fields = body.split(SEPARATOR).slice(1);
  const parsed = {};
  for (let i = 0; i < RESPONSE_LABELS.length && i < fields.length; i++) {
    const val = fields[i];
    const num = parseInt(val, 10);
    // Only treat as number if the entire field is numeric (avoid truncating MACs like '24215edb2eab')
    parsed[RESPONSE_LABELS[i]] = (!isNaN(num) && String(num) === val) ? num : val;
  }
  return parsed;
}

function safeClose(sock) {
  try { sock.close(); } catch (e) { /* already closed */ }
}

function query(host, port, deviceType, batteryMac, ctType, ctMac, timeout = 5000) {
  port = parseInt(port, 10) || DEFAULT_PORT;

  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const payload = buildPayload(deviceType, batteryMac, ctType, ctMac);
    let settled = false;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      safeClose(sock);
      if (err) reject(err);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      finish(new Error(`Timeout: CT meter at ${host}:${port}`));
    }, timeout);

    sock.on('message', (msg) => {
      try {
        finish(null, decodeResponse(msg));
      } catch (e) {
        finish(e);
      }
    });

    sock.on('error', (err) => finish(err));

    sock.bind(0, () => {
      sock.send(payload, port, host, (err) => {
        if (err) finish(err);
      });
    });
  });
}

function discover(port = DEFAULT_PORT, timeout = 6000) {
  return new Promise((resolve) => {
    const meters = [];
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const payload = buildPayload('HMG-50', '000000000000', 'HME-3', '000000000000');

    const timer = setTimeout(() => {
      safeClose(sock);
      resolve(meters);
    }, timeout);

    sock.on('message', (msg, rinfo) => {
      try {
        const data = decodeResponse(msg);
        if (data.meter_mac && !meters.find(m => m.meter_mac === data.meter_mac)) {
          meters.push({ ...data, ip: rinfo.address, port });
        }
      } catch (e) { /* ignore non-meter responses */ }
    });

    sock.on('error', () => {
      clearTimeout(timer);
      safeClose(sock);
      resolve(meters);
    });

    sock.bind(0, () => {
      sock.setBroadcast(true);
      sock.send(payload, port, '255.255.255.255');
      setTimeout(() => sock.send(payload, port, '255.255.255.255'), 2000);
      setTimeout(() => sock.send(payload, port, '255.255.255.255'), 4000);
    });
  });
}

module.exports = { buildPayload, decodeResponse, query, discover, DEFAULT_PORT };
