# Event4U Print Agent

Desktop application for thermal ticket printing with Event4U management system.

## Supported Printers

- X PRINTER XP-420B (80mm thermal)
- Any ESC/POS compatible thermal printer

## Installation

### Prerequisites
- Node.js 18+
- Windows 10/11 or macOS

### Development
```bash
npm install
npm start
```

### Build for Distribution
```bash
# Windows
npm run build:win

# macOS
npm run build:mac
```

## Configuration

1. Launch the application
2. Go to "Configurazione" tab
3. Enter:
   - **URL Server**: `wss://manage.eventfouryou.com` (default)
   - **ID Azienda**: Your company ID (ask your administrator)
   - **Nome Stampante**: Printer name as shown in OS settings
4. Click "Salva Configurazione"
5. Click "Connetti" to establish connection

## Features

- Automatic reconnection on connection loss
- Heartbeat monitoring for connection health
- Print queue management
- Test print functionality
- Activity logging

## Architecture

The Print Agent connects to the Event4U server via WebSocket relay and receives print jobs from the web application. Jobs are printed to the configured thermal printer using ESC/POS commands.

```
[Event4U Web App] → [WebSocket Relay] → [Print Agent] → [Thermal Printer]
```
