'use strict';

const Homey = require('homey');

class MarstekBatteryDriver extends Homey.Driver {

  async onInit() {
    this.log('Marstek Battery driver initialized');

    // Flow action: Set mode
    this.homey.flow.getActionCard('set_mode')
      .registerRunListener(async ({ device, mode }) => {
        await device._setMode(mode);
        await device._setCapability('operating_mode', mode);
      });

    // Flow action: Set passive power
    this.homey.flow.getActionCard('set_passive_power')
      .registerRunListener(async ({ device, power }) => {
        await device._setPassivePower(power);
      });

    // Flow action: Set DOD
    this.homey.flow.getActionCard('set_dod')
      .registerRunListener(async ({ device, value }) => {
        await device._setDOD(value);
        await device._setCapability('dod', value);
      });

    // Flow action: Set LED
    this.homey.flow.getActionCard('set_led')
      .registerRunListener(async ({ device, state }) => {
        await device._setLED(state === 'on');
        await device._setCapability('led_control', state === 'on');
      });

    // Flow condition: Mode is
    this.homey.flow.getConditionCard('mode_is')
      .registerRunListener(async ({ device, mode }) => {
        return device.getCapabilityValue('operating_mode') === mode;
      });

    // Flow trigger: Mode changed
    this._modeChangedTrigger = this.homey.flow.getDeviceTriggerCard('mode_changed');
  }

  triggerModeChanged(device, mode) {
    this._modeChangedTrigger.trigger(device, { mode }).catch(this.error);
  }

  _formatName(model, ip) {
    // "VenusE" → "Venus E", "VenusC" → "Venus C"
    const pretty = model.replace(/([a-z])([A-Z])/g, '$1 $2');
    // Use last octet to keep it short
    const lastOctet = ip.split('.').pop();
    return `${pretty} (.${lastOctet})`;
  }

  async onPair(session) {
    this.manualDevices = [];

    session.setHandler('manual_skip', async () => {
      this.log('User skipped manual entry, will auto-discover');
    });

    session.setHandler('manual_add', async ({ address, port }) => {
      this.log(`Manual add requested: ${address}:${port}`);
      try {
        const response = await this.homey.app.sendCommand(address, port, 'Marstek.GetDevice', { ble_mac: '0' });

        if (response.result && response.result.device) {
          const device = {
            ...response.result,
            ip: address,
            port,
          };
          this.manualDevices.push(device);
          const name = this._formatName(device.device, address);
          this.log(`Manual device found: ${name}`);
          return { success: true, name };
        }

        return { success: false, error: 'No valid response from device' };
      } catch (err) {
        this.error('Manual add failed:', err.message);
        return { success: false, error: err.message };
      }
    });

    session.setHandler('list_devices', async () => {
      this.log('Listing devices (auto-discover + manual)...');

      const discovered = await this.homey.app.discover();
      this.log(`Auto-discovered ${discovered.length} device(s)`);

      const all = [...this.manualDevices];
      for (const d of discovered) {
        if (!all.find(m => m.ble_mac === d.ble_mac)) {
          all.push(d);
        }
      }

      this.log(`Total devices to list: ${all.length}`);

      return all.map(device => ({
        name: this._formatName(device.device, device.ip),
        data: {
          id: device.ble_mac,
        },
        store: {
          address: device.ip,
          port: device.port,
          device_type: device.device,
          firmware: device.ver,
        },
        settings: {
          address: device.ip,
          port: device.port,
        },
      }));
    });
  }

}

module.exports = MarstekBatteryDriver;
