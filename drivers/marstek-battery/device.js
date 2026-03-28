'use strict';

const Homey = require('homey');

const POLL_INTERVAL = 60;
const REQUEST_SPACING = 2000;

class MarstekBatteryDevice extends Homey.Device {

  async onInit() {
    const { address, port } = this.getSettings();
    this.log(`Initializing ${this.getName()} at ${address}:${port}`);

    this.pollInterval = null;
    this.consecutiveErrors = 0;

    // Register setters
    this.registerCapabilityListener('operating_mode', (value) => this._setMode(value));
    this.registerCapabilityListener('led_control', (value) => this._setLED(value));

    this._startPolling();
  }

  // ── Setters ──────────────────────────────────────────

  async _setMode(mode) {
    this.log(`Setting mode to: ${mode}`);

    const config = { mode };

    switch (mode) {
      case 'Auto':
        config.auto_cfg = { enable: 1 };
        break;
      case 'AI':
        config.ai_cfg = { enable: 1 };
        break;
      case 'Manual':
        config.manual_cfg = {
          time_num: 0,
          start_time: '00:00',
          end_time: '23:59',
          week_set: 127,
          power: 100,
          enable: 1,
        };
        break;
      case 'Passive':
        const power = this.getCapabilityValue('passive_power') || 0;
        config.passive_cfg = {
          power: Math.abs(power),
          cd_time: 86400,
        };
        break;
      case 'Ups':
        config.ups_cfg = { enable: 1 };
        break;
    }

    const response = await this._sendCommand('ES.SetMode', { id: 0, config });
    this.log('SetMode response:', JSON.stringify(response));

    if (response.result && response.result.set_result === false) {
      throw new Error('Device rejected mode change');
    }
  }

  async _setPassivePower(power) {
    this.log(`Setting passive power to: ${power}W`);

    const response = await this._sendCommand('ES.SetMode', {
      id: 0,
      config: {
        mode: 'Passive',
        passive_cfg: {
          power,
          cd_time: 86400,
        },
      },
    });

    this.log('SetPassivePower response:', JSON.stringify(response));

    if (response.result && response.result.set_result === false) {
      throw new Error('Device rejected power setting');
    }

    await this._setCapability('operating_mode', 'Passive');
  }

  async _setDOD(value) {
    this.log(`Setting DOD to: ${value}`);

    const response = await this._sendCommand('DOD.SET', { value });
    this.log('SetDOD response:', JSON.stringify(response));

    if (response.result && response.result.set_result === false) {
      throw new Error('Device rejected DOD setting');
    }
  }

  async _setLED(on) {
    this.log(`Setting LED: ${on ? 'on' : 'off'}`);

    const response = await this._sendCommand('Led.Ctrl', { state: on ? 1 : 0 });
    this.log('SetLED response:', JSON.stringify(response));

    if (response.result && response.result.set_result === false) {
      throw new Error('Device rejected LED setting');
    }
  }

  // ── Polling ──────────────────────────────────────────

  _startPolling() {
    const intervalSec = this.getSetting('pollInterval') || POLL_INTERVAL;

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

  _delay(ms) {
    return new Promise(resolve => this.homey.setTimeout(resolve, ms));
  }

  async _sendCommand(method, params = { id: 0 }) {
    const { address, port } = this.getSettings();
    return this.homey.app.sendCommand(address, port, method, params);
  }

  async _pollEndpoint(method, handler) {
    try {
      const response = await this._sendCommand(method);
      if (response.result) {
        await handler(response.result);
        return true;
      }
    } catch (err) {
      this.log(`${method}: ${err.message}`);
    }
    return false;
  }

  async _poll() {
    let anySuccess = false;

    // 1) ES.GetStatus - power and energy data
    const esOk = await this._pollEndpoint('ES.GetStatus', async (r) => {
      await this._setCapability('measure_battery', r.bat_soc);
      await this._setCapability('measure_power', r.ongrid_power);
      await this._setCapability('measure_power.solar', r.pv_power);
      await this._setCapability('measure_power.battery', r.bat_power);
      await this._setCapability('measure_power.offgrid', r.offgrid_power);

      if (r.total_grid_input_energy != null) {
        await this._setCapability('meter_power.imported', Math.round(r.total_grid_input_energy / 100) / 10);
      }
      if (r.total_grid_output_energy != null) {
        await this._setCapability('meter_power.exported', Math.round(r.total_grid_output_energy / 100) / 10);
      }
      if (r.total_pv_energy != null) {
        await this._setCapability('meter_power.solar', Math.round(r.total_pv_energy / 100) / 10);
      }
    });
    anySuccess = anySuccess || esOk;

    await this._delay(REQUEST_SPACING);

    // 2) Bat.GetStatus - temperature, voltage, current
    const batOk = await this._pollEndpoint('Bat.GetStatus', async (r) => {
      await this._setCapability('measure_temperature', r.bat_temp);
      if (r.bat_voltage != null) {
        await this._setCapability('measure_voltage', Math.round(r.bat_voltage) / 100);
      }
      if (r.bat_current != null) {
        await this._setCapability('measure_current', Math.round(r.bat_current) / 100);
      }
    });
    anySuccess = anySuccess || batOk;

    await this._delay(REQUEST_SPACING);

    // 3) ES.GetMode - operating mode
    const modeOk = await this._pollEndpoint('ES.GetMode', async (r) => {
      if (r.mode) {
        const oldMode = this.getCapabilityValue('operating_mode');
        await this._setCapability('operating_mode', r.mode);
        if (oldMode && oldMode !== r.mode) {
          this.driver.triggerModeChanged(this, r.mode);
        }
      }
    });
    anySuccess = anySuccess || modeOk;

    // Track consecutive full failures
    if (anySuccess) {
      this.consecutiveErrors = 0;
      await this.setAvailable();
    } else {
      this.consecutiveErrors++;
      this.log(`All endpoints failed (${this.consecutiveErrors} consecutive)`);

      if (this.consecutiveErrors >= 5) {
        await this.setUnavailable('Device not responding').catch(() => {});
      }
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

module.exports = MarstekBatteryDevice;
