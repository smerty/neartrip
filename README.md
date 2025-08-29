# NearTRIP - Smart NTRIP Proxy

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](https://github.com/smerty/neartrip)

NearTRIP is an intelligent NTRIP proxy that automatically connects to the closest NTRIP base station based on the user's current location. It acts as an NTRIP server to GNSS receivers while connecting as a client to upstream NTRIP casters.

## Features

- 🌍 Automatically selects the closest NTRIP base station
- 🔄 Seamlessly switches between base stations as the user's location changes
- 🔌 Acts as an NTRIP server that can be used with any GNSS receiver
- 📊 Logs NMEA messages for diagnostic purposes
- 🚀 Simple setup and configuration
- 🔥 Hot reloading of configuration (change stations without server restart)
- 🧑‍💻 Web UI to manage it all

## Use Cases

- RTK corrections for precision agriculture
- UAV ground control stations needing RTK data
- Mobile mapping applications
- Any application needing RTK corrections from the closest base station

## Installation

1. Clone this repository:
   ```
   git clone https://github.com/smerty/neartrip.git
   cd neartrip
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Create configuration file:
   ```
   cp config.json.sample config.json
   ```

4. Edit `config.json` with your settings and available NTRIP stations.

## Configuration

The `config.json` file contains all the settings needed to run NearTRIP:

```json
{
  "username": "your_ntrip_username",
  "password": "your_ntrip_password",
  "interface": "0.0.0.0",
  "port": 2101,
  "mountPoint": "NEAR-Station",
  "userAgent": "NearTRIP/1.0",
  "adminPort": 3000,
  "adminUsername": "your_adminui_username",
  "adminPassword": "your_adminui_password",
  "stations": [
    {
      "mountPoint": "STATION1",
      "casterHost": "example-caster.com",
      "casterPort": 2101,
      "username": "station_username",
      "password": "station_password",
      "latitude": 37.123,
      "longitude": -122.456,
      "active": true
    },
    // Add more stations as needed
  ]
}
```

### Hot Reloading Configuration

NearTRIP supports hot reloading of configuration, allowing you to modify settings without restarting the server or disrupting existing connections:

1. Edit the `config.json` file while the server is running
2. Save the file
3. Changes are automatically detected and applied

You can:
- Add or remove stations
- Change station details (coordinates, credentials, active status)
- Update server settings

Existing client connections will remain stable. Changes take effect:
- Immediately for new connections
- When clients send updated location information
- When clients reconnect

## Usage

Start the NearTRIP server:

```
npm start
```

Connect your GNSS receiver to the NearTRIP server using the IP address and port specified in your configuration.

## How it Works

1. Your GNSS receiver connects to NearTRIP as if it were a standard NTRIP server
2. The receiver sends its location via NMEA GPGGA sentences
3. NearTRIP analyzes the location to find the closest base station
4. NearTRIP connects to the selected base station as an NTRIP client
5. RTK correction data from the base station is forwarded to your receiver
6. As you move, NearTRIP automatically switches to the closest station

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
