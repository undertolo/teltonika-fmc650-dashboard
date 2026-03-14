// database.js - Módulo de conexión y consultas MySQL
const mysql = require('mysql2/promise');
require('dotenv').config();

// Pool de conexiones
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'teltonika_user',
  password: process.env.DB_PASSWORD || 'teltonika_pass',
  database: process.env.DB_NAME || 'teltonika',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

// Verificar conexión
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('✅ Conectado a MySQL');
    connection.release();
    return true;
  } catch (error) {
    console.error('❌ Error conectando a MySQL:', error.message);
    return false;
  }
}

// Crear tablas si no existen
async function createTables() {
  const connection = await pool.getConnection();
  
  try {
    // Tabla devices
    await connection.query(`
      CREATE TABLE IF NOT EXISTS devices (
        id INT AUTO_INCREMENT PRIMARY KEY,
        imei VARCHAR(20) UNIQUE NOT NULL,
        first_seen DATETIME NOT NULL,
        last_seen DATETIME NOT NULL,
        total_records INT DEFAULT 0,
        INDEX idx_imei (imei)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Tabla gps_data
    await connection.query(`
      CREATE TABLE IF NOT EXISTS gps_data (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        device_id INT NOT NULL,
        timestamp DATETIME NOT NULL,
        timestamp_ms BIGINT NOT NULL,
        priority TINYINT,
        latitude DECIMAL(10, 7) NOT NULL,
        longitude DECIMAL(10, 7) NOT NULL,
        altitude SMALLINT,
        angle SMALLINT,
        satellites TINYINT,
        speed SMALLINT,
        received_at DATETIME NOT NULL,
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
        INDEX idx_device_timestamp (device_id, timestamp),
        INDEX idx_timestamp (timestamp),
        INDEX idx_location (latitude, longitude)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Tabla io_data
    await connection.query(`
      CREATE TABLE IF NOT EXISTS io_data (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        gps_record_id BIGINT NOT NULL,
        event_id SMALLINT,
        io_id SMALLINT NOT NULL,
        io_name VARCHAR(100),
        io_value BIGINT,
        io_size TINYINT,
        FOREIGN KEY (gps_record_id) REFERENCES gps_data(id) ON DELETE CASCADE,
        INDEX idx_gps_record (gps_record_id),
        INDEX idx_io_id (io_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Tabla connections
    await connection.query(`
      CREATE TABLE IF NOT EXISTS connections (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        device_id INT NOT NULL,
        ip_address VARCHAR(45) NOT NULL,
        connected_at DATETIME NOT NULL,
        disconnected_at DATETIME,
        records_received INT DEFAULT 0,
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
        INDEX idx_device_connected (device_id, connected_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Tabla users
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('superuser', 'admin', 'owner', 'driver') NOT NULL,
        name VARCHAR(100),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    console.log('✅ Tablas verificadas/creadas');
  } catch (error) {
    console.error('❌ Error creando tablas:', error.message);
    throw error;
  } finally {
    connection.release();
  }
}

// Consultas de base de datos
const db = {
  // Obtener todos los dispositivos con estadísticas
  async getDevices() {
    const [rows] = await pool.query(`
      SELECT 
        d.imei,
        d.first_seen,
        d.last_seen,
        d.total_records,
        COUNT(DISTINCT c.id) as total_connections,
        MAX(g.timestamp) as latest_gps,
        AVG(g.speed) as avg_speed,
        MAX(g.speed) as max_speed
      FROM devices d
      LEFT JOIN connections c ON d.id = c.device_id
      LEFT JOIN gps_data g ON d.id = g.device_id
      GROUP BY d.id
      ORDER BY d.last_seen DESC
    `);
    return rows;
  },

  // Obtener última posición de un dispositivo
  async getLatestPosition(imei) {
    const [rows] = await pool.query(`
      SELECT 
        d.imei,
        g.timestamp,
        g.latitude,
        g.longitude,
        g.altitude,
        g.speed,
        g.angle,
        g.satellites
      FROM devices d
      JOIN gps_data g ON d.id = g.device_id
      WHERE d.imei = ?
      ORDER BY g.timestamp DESC
      LIMIT 1
    `, [imei]);
    return rows[0];
  },

  // Obtener ruta histórica
  async getRouteHistory(imei, hours = 24, limit = 1000) {
    const startDate = new Date();
    startDate.setHours(startDate.getHours() - hours);

    const [rows] = await pool.query(`
      SELECT 
        g.timestamp,
        g.latitude,
        g.longitude,
        g.altitude,
        g.speed,
        g.angle,
        g.satellites
      FROM devices d
      JOIN gps_data g ON d.id = g.device_id
      WHERE d.imei = ? AND g.timestamp >= ?
      ORDER BY g.timestamp DESC
      LIMIT ?
    `, [imei, startDate, limit]);
    return rows;
  },

  // Obtener estadísticas de un dispositivo
  async getDeviceStats(imei) {
    const [rows] = await pool.query(`
      SELECT 
        d.imei,
        d.first_seen,
        d.last_seen,
        d.total_records,
        COUNT(DISTINCT c.id) as total_connections,
        MAX(g.timestamp) as latest_gps,
        AVG(g.speed) as avg_speed,
        MAX(g.speed) as max_speed
      FROM devices d
      LEFT JOIN connections c ON d.id = c.device_id
      LEFT JOIN gps_data g ON d.id = g.device_id
      WHERE d.imei = ?
      GROUP BY d.id
    `, [imei]);
    return rows[0];
  },

  // Health check
  async healthCheck() {
    try {
      const [rows] = await pool.query('SELECT COUNT(*) as count FROM devices');
      return {
        status: 'healthy',
        database: 'connected',
        devices_count: rows[0].count
      };
    } catch (error) {
      throw new Error('Database unhealthy');
    }
  }
};

module.exports = {
  pool,
  testConnection,
  createTables,
  db
};
