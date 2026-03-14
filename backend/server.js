// server.js - Servidor Express para API REST
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { testConnection, createTables, db } = require('./database');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Servir archivos estáticos del frontend
app.use(express.static('../frontend/public'));

// ==================== RUTAS DE API ====================

// GET /api/devices - Obtener todos los dispositivos
app.get('/api/devices', async (req, res) => {
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
app.get('/api/device/:imei/latest', async (req, res) => {
  try {
    const { imei } = req.params;
    const position = await db.getLatestPosition(imei);
    
    if (position) {
      res.json({
        success: true,
        position
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'No se encontraron datos para este dispositivo'
      });
    }
  } catch (error) {
    console.error('Error obteniendo posición:', error);
    res.status(500).json({
      success: false,
      error: 'Error obteniendo posición'
    });
  }
});

// GET /api/device/:imei/route - Historial de ruta
app.get('/api/device/:imei/route', async (req, res) => {
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
    res.status(500).json({
      success: false,
      error: 'Error obteniendo ruta'
    });
  }
});

// GET /api/device/:imei/stats - Estadísticas de un dispositivo
app.get('/api/device/:imei/stats', async (req, res) => {
  try {
    const { imei } = req.params;
    const stats = await db.getDeviceStats(imei);
    
    if (stats) {
      res.json({
        success: true,
        stats
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Dispositivo no encontrado'
      });
    }
  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({
      success: false,
      error: 'Error obteniendo estadísticas'
    });
  }
});

// GET /api/health - Health check
app.get('/api/health', async (req, res) => {
  try {
    const health = await db.healthCheck();
    res.json({
      success: true,
      ...health,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      status: 'unhealthy',
      error: error.message
    });
  }
});

// Ruta por defecto - Servir index.html
app.get('*', (req, res) => {
  res.sendFile('index.html', { root: '../frontend/public' });
});

// ==================== INICIAR SERVIDOR ====================

async function startServer() {
  try {
    // Verificar conexión a base de datos
    const connected = await testConnection();
    if (!connected) {
      throw new Error('No se pudo conectar a la base de datos');
    }

    // Crear tablas si no existen
    await createTables();

    // Iniciar servidor
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

// Manejo de cierre graceful
process.on('SIGINT', () => {
  console.log('\n🛑 Cerrando servidor...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Cerrando servidor...');
  process.exit(0);
});

// Iniciar
startServer();
