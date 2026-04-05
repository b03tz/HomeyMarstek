'use strict';

const Homey = require('homey');

const POLL_INTERVAL = 2;

class MarstekMeterDevice extends Homey.Device {

  async onInit() {
    const { address, port } = this.getSettings();
    const store = this.getStore();
    this.log(`Initializing ${this.getName()} at ${address}:${port}`);
    this.log(`Store: ct_mac=${store.ct_mac} ct_type=${store.ct_type} device_type=${store.device_type}`);

    this.pollInterval = null;
    this.consecutiveErrors = 0;
    this._polling = false;

    this._startPolling();
  }

  // ── Polling ──────────────────────────────────────────

  _startPolling() {
    const intervalSec = this.getSetting('pollInterval') || POLL_INTERVAL;
    this.log(`Starting poll every ${intervalSec}s`);

    this._poll();

    this.pollInterval = this.homey.setInterval(() => {
      this._poll();
    }, intervalSec * 1000);
  }

  _stopPolling() {
    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  async _setCapability(id, value) {
    try {
      if (this.hasCapability(id) && value != null) {
        await this.setCapabilityValue(id, value);
      }
    } catch (err) {
      this.error(`Failed to set ${id}:`, err.message);
    }
  }

  async _poll() {
    if (this._polling) return;
    this._polling = true;

    // Skip polling if socket is being recreated (don't count as error)
    if (!this.homey.app.socket) {
      this.log('Socket not ready, skipping poll');
      this._polling = false;
      return;
    }

    const { address, port } = this.getSettings();
    const { ct_mac, ct_type, device_type } = this.getStore();

    try {
      const data = await this.homey.app.sendMeterCommand(
        address, port,
        device_type || 'HMG-50', '000000000000',
        ct_type || 'HME-3', ct_mac,
      );

      // Phase power
      await this._setCapability('measure_power.phase_a', data.a_phase_power);
      await this._setCapability('measure_power.phase_b', data.b_phase_power);
      await this._setCapability('measure_power.phase_c', data.c_phase_power);

      const total = (data.a_phase_power || 0) + (data.b_phase_power || 0) + (data.c_phase_power || 0);
      const oldTotal = this.getCapabilityValue('measure_power');
      await this._setCapability('measure_power', total);

      if (oldTotal !== total) {
        this.driver.triggerPowerChanged(this, total);
      }

      // Charge power per phase
      await this._setCapability('measure_power.charge_a', data.a_charge_power);
      await this._setCapability('measure_power.charge_b', data.b_charge_power);
      await this._setCapability('measure_power.charge_c', data.c_charge_power);
      await this._setCapability('measure_power.total_charge', data.total_charge_power);

      // Discharge power per phase
      await this._setCapability('measure_power.discharge_a', data.a_discharge_power);
      await this._setCapability('measure_power.discharge_b', data.b_discharge_power);
      await this._setCapability('measure_power.discharge_c', data.c_discharge_power);
      await this._setCapability('measure_power.total_discharge', data.total_discharge_power);

      // Cumulative energy (values are in mWh, convert to kWh)
      if (data.abc_chrg_energy != null) {
        await this._setCapability('meter_power.charge', Math.round(data.abc_chrg_energy / 1000) / 1000);
      }
      if (data.abc_dchrg_energy != null) {
        await this._setCapability('meter_power.discharge', Math.round(data.abc_dchrg_energy / 1000) / 1000);
      }

      this.consecutiveErrors = 0;
      await this.setAvailable();
    } catch (err) {
      this.consecutiveErrors++;
      this.error(`Poll failed (${this.consecutiveErrors}): ${err.message}`);

      if (this.consecutiveErrors >= 5) {
        await this.setUnavailable('Meter not responding').catch(() => {});
      }
    } finally {
      this._polling = false;
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('pollInterval') || changedKeys.includes('address') || changedKeys.includes('port')) {
      this._stopPolling();
      this._startPolling();
    }
  }

  async onDeleted() {
    this._stopPolling();
  }

  async onUninit() {
    this._stopPolling();
  }

}

module.exports = MarstekMeterDevice;
