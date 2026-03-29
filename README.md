# Marstek Energy for Homey

Control and monitor Marstek Venus battery systems and CT003 smart meters via local UDP — no cloud required.

## Supported devices

- **Marstek Venus batteries** (Venus C, D, E) — full control and monitoring
- **Marstek CT003 smart meter** — real-time 3-phase power monitoring

## Features

### Venus Battery
- Real-time monitoring: grid power, solar power, battery power, off-grid power, SoC, temperature, voltage, current
- Cumulative energy tracking: grid import/export, solar production
- Operating mode control: Auto, AI, Manual, Passive, UPS
- Passive power charging/discharging (-5000W to +5000W)
- Depth of discharge (DOD) configuration
- LED panel control
- Flow cards for automation (triggers, conditions, actions)

### CT003 Meter
- Real-time 3-phase power monitoring (Phase A, B, C)
- Per-phase charge and discharge power
- Cumulative energy tracking
- Polling as fast as every 2 seconds
- Flow cards: power change trigger, total/per-phase power conditions

## Reliable polling

This app is designed for stability. Unlike other integrations that silently fail when a device doesn't respond:

- **Battery polling** retries every 2 seconds within the poll interval until it gets a successful response. If your poll interval is 30 seconds and the first attempt fails, the app keeps trying every 2 seconds until it succeeds — no missed data points.
- **Setter commands** (mode changes, DOD, LED, passive power) retry up to 5 times with exponential backoff (2s, 5s, 10s, 30s) before giving up.
- Devices are only marked as unavailable after 5 consecutive full poll cycle failures.

## Auto-discovery

Both device types support automatic discovery via UDP broadcast. During pairing, devices on your local network are found automatically. Manual IP entry is also available as a fallback.

## Installation

1. Install from the Homey App Store, or sideload via `homey app install`
2. Add a device and choose either **Marstek Venus Battery** or **Marstek CT003 Meter**
3. Use auto-discovery or enter the device IP manually
4. Adjust poll interval in device settings if needed

## Technical details

- Venus batteries communicate via JSON-RPC over UDP port 30000
- CT003 meters use a binary protocol over UDP port 12345
- All communication is local — no cloud, no internet required
- Compatible with Homey Pro and Homey (2023+)
