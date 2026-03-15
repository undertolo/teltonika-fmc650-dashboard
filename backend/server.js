// server.js - Servidor Express para API REST
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { testConnection, createTables, db, fahrDb } = require('./database');
const { login, requireAuth, requireRole } = require('./auth');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Servir archivos estáticos del frontend
app.use(express.static('../frontend/public'));

// ==================== RUTAS DE AUTH ====================

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }
    const result = await login(username, password);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

// ==================== RUTAS DE API ====================

// GET /api/devices - Obtener todos los dispositivos
app.get('/api/devices', requireAuth, async (req, res) => {
  try {
    const devices = await db.getDevices();
    res.json({
      success: true,
      devices,
      count: devices.length
    });
  } catch (error) {
    console.error('Error obteniendo dispositivos:', error);
    res.status(500).json({
      success: false,
      error: 'Error obteniendo dispositivos'
    });
  }
});

// GET /api/device/:imei/latest - Última posición de un dispositivo
app.get('/api/device/:imei/latest', requireAuth, async (req, res) => {
  try {
    const { imei } = req.params;
    const position = await db.getLatestPosition(imei);

    if (position) {
      res.json({ success: true, position });
    } else {
      res.status(404).json({ success: false, error: 'No se encontraron datos para este dispositivo' });
    }
  } catch (error) {
    console.error('Error obteniendo posición:', error);
    res.status(500).json({ success: false, error: 'Error obteniendo posición' });
  }
});

// GET /api/device/:imei/route - Historial de ruta
app.get('/api/device/:imei/route', requireAuth, async (req, res) => {
  try {
    const { imei } = req.params;
    const hours = parseInt(req.query.hours) || 24;
    const limit = parseInt(req.query.limit) || 1000;

    const route = await db.getRouteHistory(imei, hours, limit);

    const startDate = new Date();
    startDate.setHours(startDate.getHours() - hours);

    res.json({
      success: true,
      route,
      count: route.length,
      period: {
        start: startDate.toISOString(),
        end: new Date().toISOString(),
        hours
      }
    });
  } catch (error) {
    console.error('Error obteniendo ruta:', error);
    res.status(500).json({ success: false, error: 'Error obteniendo ruta' });
  }
});

// GET /api/device/:imei/stats - Estadísticas de un dispositivo
app.get('/api/device/:imei/stats', requireAuth, async (req, res) => {
  try {
    const { imei } = req.params;
    const stats = await db.getDeviceStats(imei);

    if (stats) {
      res.json({ success: true, stats });
    } else {
      res.status(404).json({ success: false, error: 'Dispositivo no encontrado' });
    }
  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({ success: false, error: 'Error obteniendo estadísticas' });
  }
});

// ==================== RUTAS DE USUARIOS ====================

// GET /api/users
app.get('/api/users', requireAuth, requireRole('superuser'), async (req, res) => {
  try {
    const users = await db.getUsers();
    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error fetching users' });
  }
});

// POST /api/users
app.post('/api/users', requireAuth, requireRole('superuser'), async (req, res) => {
  try {
    const { username, password, role, name } = req.body;
    if (!username || !password || !role) {
      return res.status(400).json({ success: false, error: 'username, password and role are required' });
    }
    const hash = await bcrypt.hash(password, 10);
    const id = await db.createUser(username, hash, role, name || username);
    res.json({ success: true, id });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, error: 'Username already exists' });
    }
    res.status(500).json({ success: false, error: 'Error creating user' });
  }
});

// PUT /api/users/:id
app.put('/api/users/:id', requireAuth, requireRole('superuser'), async (req, res) => {
  try {
    const { name, role, password } = req.body;
    const fields = {};
    if (name)     fields.name = name;
    if (role)     fields.role = role;
    if (password) fields.password_hash = await bcrypt.hash(password, 10);
    await db.updateUser(req.params.id, fields);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error updating user' });
  }
});

// DELETE /api/users/:id
app.delete('/api/users/:id', requireAuth, requireRole('superuser'), async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.user.id) {
      return res.status(400).json({ success: false, error: 'Cannot delete your own account' });
    }
    await db.deleteUser(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error deleting user' });
  }
});

// ==================== RUTAS DE CLIENTES ====================

// GET /api/device/:imei/dashboard
app.get('/api/device/:imei/dashboard', requireAuth, async (req, res) => {
  try {
    const data = await db.getDeviceDashboard(req.params.imei);
    if (!data) return res.status(404).json({ success: false, error: 'Device not found' });
    // Enrich with J1939 data from fahr_production via plate matching
    const plate = await db.getDevicePlate(req.params.imei);
    const j1939 = plate ? await fahrDb.getDeviceJ1939ByPlate(plate) : null;
    res.json({ success: true, data: { ...data, j1939 } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/clients - Lista de clientes (admin/superuser)
app.get('/api/clients', requireAuth, requireRole('admin', 'superuser'), async (req, res) => {
  try {
    const [clients, counts] = await Promise.all([
      fahrDb.getClients(),
      db.getClientCounts()
    ]);
    const countMap = {};
    counts.forEach(r => { countMap[r.client_id] = r; });
    const merged = clients.map(c => ({
      ...c,
      truck_count:    (countMap[c.id]?.truck_count    || 0),
      device_count:   (countMap[c.id]?.device_count   || 0),
      avg_satellites: (countMap[c.id]?.avg_satellites ?? null)
    }));
    res.json({ success: true, clients: merged });
  } catch (error) {
    console.error('Error fetching clients:', error);
    res.status(500).json({ success: false, error: 'Error fetching clients' });
  }
});

// GET /api/clients/:id/devices - Dispositivos de un cliente
app.get('/api/clients/:id/devices', requireAuth, requireRole('admin', 'superuser'), async (req, res) => {
  try {
    const clientDevices = await fahrDb.getClientDevices(req.params.id);
    // Cross-reference mac_address with teltonika devices (mac stored without colons = last 12 hex = IMEI-like)
    // The fahr device.mac_address field: we try to match by looking at all teltonika devices
    const teltonikaDevices = await db.getDevices();
    const result = clientDevices.map(cd => {
      const mac = (cd.mac_address || '').toLowerCase().replace(/[^a-f0-9]/g, '');
      const matched = teltonikaDevices.find(td => {
        const imei = (td.imei || '').toLowerCase();
        return imei === mac || imei.endsWith(mac) || mac.endsWith(imei);
      });
      return { ...cd, teltonika: matched || null };
    });
    res.json({ success: true, devices: result });
  } catch (error) {
    console.error('Error fetching client devices:', error);
    res.status(500).json({ success: false, error: 'Error fetching client devices' });
  }
});

// ==================== RUTAS DE TRUCKS ====================

// GET /api/trucks/all — all trucks across all clients (vehicles admin page)
app.get('/api/trucks/all', requireAuth, requireRole('admin', 'superuser'), async (req, res) => {
  try {
    const trucks = await db.getAllTrucks();
    res.json({ success: true, trucks });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error fetching trucks' });
  }
});

// GET /api/trucks?client_id=X
app.get('/api/trucks', requireAuth, requireRole('admin', 'superuser'), async (req, res) => {
  try {
    const { client_id } = req.query;
    if (!client_id) return res.status(400).json({ success: false, error: 'client_id required' });
    const trucks = await db.getTrucks(client_id);
    res.json({ success: true, trucks });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error fetching trucks' });
  }
});

// GET /api/trucks/:id
app.get('/api/trucks/:id', requireAuth, requireRole('admin', 'superuser'), async (req, res) => {
  try {
    const truck = await db.getTruck(req.params.id);
    if (!truck) return res.status(404).json({ success: false, error: 'Truck not found' });
    res.json({ success: true, truck });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error fetching truck' });
  }
});

// POST /api/trucks
app.post('/api/trucks', requireAuth, requireRole('admin', 'superuser'), async (req, res) => {
  try {
    const { client_id, name, plate, description, brand, model, year, color } = req.body;
    if (!client_id || !name) return res.status(400).json({ success: false, error: 'client_id and name required' });
    const id = await db.createTruck(client_id, name, plate, description, brand, model, year, color);
    res.json({ success: true, id });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error creating truck' });
  }
});

// PUT /api/trucks/:id
app.put('/api/trucks/:id', requireAuth, requireRole('admin', 'superuser'), async (req, res) => {
  try {
    const { client_id, name, plate, description, brand, model, year, color } = req.body;
    await db.updateTruck(req.params.id, { client_id, name, plate, description, brand, model, year, color });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error updating truck' });
  }
});

// DELETE /api/trucks/:id
app.delete('/api/trucks/:id', requireAuth, requireRole('admin', 'superuser'), async (req, res) => {
  try {
    await db.deleteTruck(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error deleting truck' });
  }
});

// PUT /api/trucks/:id/devices/:imei  — assign device to truck
app.put('/api/trucks/:id/devices/:imei', requireAuth, requireRole('admin', 'superuser'), async (req, res) => {
  try {
    await db.assignDeviceToTruck(req.params.imei, req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error assigning device' });
  }
});

// DELETE /api/trucks/:id/devices/:imei  — remove device from truck
app.delete('/api/trucks/:id/devices/:imei', requireAuth, requireRole('admin', 'superuser'), async (req, res) => {
  try {
    await db.removeDeviceFromTruck(req.params.imei);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error removing device' });
  }
});

// GET /api/devices/admin - Full device list with signal, battery, IO data
app.get('/api/devices/admin', requireAuth, requireRole('admin', 'superuser'), async (req, res) => {
  try {
    const devices = await db.getDevicesAdmin();
    res.json({ success: true, devices });
  } catch (error) {
    console.error('Error fetching devices admin:', error);
    res.status(500).json({ success: false, error: 'Error fetching devices' });
  }
});

// GET /api/devices/unassigned
app.get('/api/devices/unassigned', requireAuth, requireRole('admin', 'superuser'), async (req, res) => {
  try {
    const devices = await db.getUnassignedDevices();
    res.json({ success: true, devices });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error fetching unassigned devices' });
  }
});

// GET /api/health - Health check (public)
app.get('/api/health', async (req, res) => {
  try {
    const health = await db.healthCheck();
    res.json({ success: true, ...health, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success: false, status: 'unhealthy', error: error.message });
  }
});

// Ruta por defecto - Servir index.html
app.get('*', (req, res) => {
  res.sendFile('index.html', { root: '../frontend/public' });
});

// ==================== INICIAR SERVIDOR ====================

async function startServer() {
  try {
    const connected = await testConnection();
    if (!connected) throw new Error('No se pudo conectar a la base de datos');

    await createTables();

    app.listen(PORT, () => {
      console.log('='.repeat(60));
      console.log('🚀 SERVIDOR TELTONIKA NODE.JS');
      console.log('='.repeat(60));
      console.log(`📡 API REST: http://localhost:${PORT}`);
      console.log(`🌐 Dashboard: http://localhost:${PORT}`);
      console.log('='.repeat(60));
    });
  } catch (error) {
    console.error('❌ Error iniciando servidor:', error.message);
    process.exit(1);
  }
}

process.on('SIGINT', () => { console.log('\n🛑 Cerrando servidor...'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n🛑 Cerrando servidor...'); process.exit(0); });

startServer();
