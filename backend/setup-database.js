// setup-database.js - Script de configuración de base de datos
const mysql = require('mysql2/promise');
const readline = require('readline');
const crypto = require('crypto');
const fs = require('fs').promises;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

function generatePassword(length = 16) {
  return crypto.randomBytes(length).toString('base64').slice(0, length);
}

async function setupDatabase() {
  console.log('='.repeat(60));
  console.log('CONFIGURACIÓN DE BASE DE DATOS TELTONIKA');
  console.log('='.repeat(60));
  console.log();

  try {
    // Solicitar credenciales de root
    console.log('Ingresa las credenciales de MySQL root:');
    const rootPassword = await question('Password root de MySQL: ');
    console.log();

    // Configuración de la nueva base de datos
    console.log('Configuración de nueva base de datos:');
    let dbName = await question('Nombre de la base de datos [teltonika]: ');
    dbName = dbName.trim() || 'teltonika';

    let dbUser = await question('Usuario de la base de datos [teltonika_user]: ');
    dbUser = dbUser.trim() || 'teltonika_user';

    let dbPassword = await question('Password del usuario (dejar vacío para generar): ');
    dbPassword = dbPassword.trim();

    if (!dbPassword) {
      dbPassword = generatePassword();
      console.log(`\n🔑 Password generado: ${dbPassword}`);
    }

    console.log('\n🔌 Conectando a MySQL como root...');
    
    // Conectar como root
    const connection = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: rootPassword
    });

    console.log('✅ Conectado a MySQL como root');

    // Crear base de datos
    console.log(`\n📦 Creando base de datos '${dbName}'...`);
    await connection.query(`CREATE DATABASE IF NOT EXISTS ${dbName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`✅ Base de datos '${dbName}' creada`);

    // Crear usuario
    console.log(`\n👤 Creando usuario '${dbUser}'...`);
    await connection.query(`CREATE USER IF NOT EXISTS '${dbUser}'@'localhost' IDENTIFIED BY '${dbPassword}'`);
    await connection.query(`GRANT ALL PRIVILEGES ON ${dbName}.* TO '${dbUser}'@'localhost'`);
    await connection.query('FLUSH PRIVILEGES');
    console.log(`✅ Usuario '${dbUser}' creado con permisos`);

    await connection.end();

    // Crear tablas
    console.log(`\n📋 Creando tablas en '${dbName}'...`);
    const dbConnection = await mysql.createConnection({
      host: 'localhost',
      user: dbUser,
      password: dbPassword,
      database: dbName
    });

    // Crear tablas
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS devices (
        id INT AUTO_INCREMENT PRIMARY KEY,
        imei VARCHAR(20) UNIQUE NOT NULL,
        first_seen DATETIME NOT NULL,
        last_seen DATETIME NOT NULL,
        total_records INT DEFAULT 0,
        INDEX idx_imei (imei)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await dbConnection.query(`
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

    await dbConnection.query(`
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

    await dbConnection.query(`
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

    console.log('✅ Tablas creadas exitosamente');
    await dbConnection.end();

    // Guardar configuración
    console.log('\n💾 Guardando configuración...');
    await saveEnvFile(dbName, dbUser, dbPassword);

    console.log('\n' + '='.repeat(60));
    console.log('✅ CONFIGURACIÓN COMPLETADA');
    console.log('='.repeat(60));
    console.log(`\nBase de datos: ${dbName}`);
    console.log(`Usuario: ${dbUser}`);
    console.log(`Password: ${dbPassword}`);
    console.log('\n⚠️  GUARDA ESTA INFORMACIÓN EN UN LUGAR SEGURO');
    console.log('\nLa configuración se ha guardado en .env');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

async function saveEnvFile(dbName, dbUser, dbPassword) {
  const envContent = `# Configuración de Base de Datos MySQL
DB_HOST=localhost
DB_PORT=3306
DB_USER=${dbUser}
DB_PASSWORD=${dbPassword}
DB_NAME=${dbName}

# Configuración del Servidor
PORT=3000
NODE_ENV=development
`;

  await fs.writeFile('.env', envContent, 'utf8');
  console.log('✅ Archivo .env creado');
}

// Ejecutar
setupDatabase().catch(error => {
  console.error('Error inesperado:', error);
  process.exit(1);
});
