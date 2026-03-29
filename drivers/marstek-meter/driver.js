'use strict';

const Homey = require('homey');
const { DEFAULT_PORT } = require('../../lib/marstek-ct-protocol');

class MarstekMeterDriver extends Homey.Driver {

  async onInit() {
    this.log('Marstek Meter driver initialized');

    // Flow trigger: Power changed
    this._powerChangedTrigger = this.homey.flow.getDeviceTriggerCard('meter_power_changed');

    // Flow condition: Total power above/below
    this.homey.flow.getConditionCard('meter_power_above')
      .registerRunListener(async ({ device, power }) => {
        const current = device.getCapabilityValue('measure_power') || 0;
        return current > power;
      });

    // Flow condition: Phase power above/below
    this.homey.flow.getConditionCard('meter_phase_above')
      .registerRunListener(async ({ device, phase, power }) => {
        const cap = `measure_power.phase_${phase}`;
        const current = device.getCapabilityValue(cap) || 0;
        return current > power;
      });
  }

  triggerPowerChanged(device, power) {
    this._powerChangedTrigger.trigger(device, { power }).catch(this.error);
  }

  async onPair(session) {
    this.manualDevices = [];

    session.setHandler('manual_skip', async () => {
      this.log('User skipped manual entry, will auto-discover');
    });

    session.setHandler('manual_add', async ({ address, port }) => {
      this.log(`Manual add requested: ${address}:${port}`);
      try {
        const data = await this.homey.app.sendMeterCommand(
          address, port,
          'HMG-50', '000000000000',
          'HME-3', '000000000000',
        );

        if (data.meter_mac) {
          this.manualDevices.push({ ...data, ip: address, port });
          const name = `CT003 (.${address.split('.').pop()})`;
          this.log(`Manual meter found: ${name}`);
          return { success: true, name };
        }

        return { success: false, error: 'No valid response from meter' };
      } catch (err) {
        this.error('Manual add failed:', err.message);
        return { success: false, error: err.message };
      }
    });

    session.setHandler('list_devices', async () => {
      this.log('Discovering meters...');

      const discovered = await this.homey.app.discoverMeters();
      this.log(`Discovered ${discovered.length} meter(s)`);

      const all = [...this.manualDevices];
      for (const d of discovered) {
        if (!all.find(m => m.meter_mac === d.meter_mac)) {
          all.push(d);
        }
      }

      this.log(`Total meters to list: ${all.length}`);

      return all.map(meter => ({
        name: `CT003 (.${meter.ip.split('.').pop()})`,
        data: {
          id: meter.meter_mac,
        },
        store: {
          ct_mac: meter.meter_mac,
          ct_type: meter.meter_dev_type,
          device_type: meter.battery_dev_type,
        },
        settings: {
          address: meter.ip,
          port: meter.port || DEFAULT_PORT,
        },
      }));
    });
  }

}

module.exports = MarstekMeterDriver;
