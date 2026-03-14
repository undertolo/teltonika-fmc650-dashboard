# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Real-time GPS tracking dashboard for Teltonika FMC650 fleet management devices. Three-tier architecture:
1. **Python TCP server** — receives raw AVL data from devices via Teltonika Codec 8/8E protocol
2. **Node.js/Express API** — REST API + serves frontend static files
3. **Vanilla JS frontend** — interactive map dashboard using Leaflet + OpenStreetMap

## Commands

### Backend (Node.js)
```bash
cd backend
npm install          # Install dependencies
npm start            # Production (node server.js, port 3001)
npm run dev          # Development with auto-reload (nodemon)
npm run setup        # Initialize/reset MySQL database schema
```

### Python TCP Server
```bash
cd python_server
python3 teltonika_server.py   # Start TCP listener (port 8000 by default)
```

### Systemd Services (production)
Both servers run as systemd services and start automatically on boot.

```bash
# Python TCP server
systemctl status|start|stop|restart teltonika-server
journalctl -u teltonika-server -f

# Node.js backend
systemctl status|start|stop|restart teltonika-backend
journalctl -u teltonika-backend -f
```

Service unit files are in `systemd/` and installed at `/etc/systemd/system/`.
To install on a new server:
```bash
cp systemd/*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now teltonika-server teltonika-backend
```

## Logging

- **Python server** — logs to stdout, captured by journald (`journalctl -u teltonika-server -f`)
- **Node.js backend** — logs to stdout, captured by journald (`journalctl -u teltonika-backend -f`)
- `mysql.connector` library logs are suppressed to WARNING in `teltonika_server.py`

## Architecture

### Data Flow
```
Teltonika FMC650 device → TCP:8000 → python_server/teltonika_server.py
  → MySQL (teltonika DB)
  → HTTP:3001 → backend/server.js (Express REST API)
  → /frontend/public/js/app.js (polls every 30s)
```

### Backend API Endpoints (`backend/server.js`)
- `GET /api/devices` — all devices with online/offline status
- `GET /api/device/:imei/latest` — latest GPS position
- `GET /api/device/:imei/route?hours=N` — historical route
- `GET /api/device/:imei/stats` — speed/altitude/satellite statistics
- `GET /api/health` — system health check

### Database Schema (`backend/database.js`, `backend/setup-database.js`)
- `devices` — registered devices (IMEI, timestamps)
- `gps_data` — GPS records (lat/lng decimal(10,7), speed, altitude, satellites)
- `io_data` — digital/analog I/O elements linked to gps_data records
- `connections` — device connection/disconnection history

### Frontend (`frontend/public/`)
- `index.html` — entry point, loads Leaflet from CDN
- `js/app.js` — all frontend logic (device list, map markers, route polyline, auto-refresh)
- `css/styles.css` — responsive styles

## Configuration

Both servers use `.env` files (not committed):

**`backend/.env`:**
```
DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME=teltonika, PORT=3001
```

**`python_server/.env`:**
```
DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME=teltonika, PORT=8000
```

Reference: `backend/.env.example` for required variables.

## Key Implementation Details

- Python server parses raw Teltonika binary protocol — codec parsing logic is in `teltonika_server.py`
- MySQL connection pool managed in `backend/database.js`; all DB queries go through that module
- Frontend auto-refreshes every 30 seconds via `setInterval` in `app.js`
- No build step for frontend — served as static files directly by Express
