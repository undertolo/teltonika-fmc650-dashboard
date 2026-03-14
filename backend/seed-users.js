// seed-users.js - Create default users for each role
// Usage: node seed-users.js
const bcrypt = require('bcryptjs');
const { pool, testConnection, createTables } = require('./database');
require('dotenv').config();

const DEFAULT_USERS = [
  { username: 'superuser', password: 'superuser123', role: 'superuser', name: 'Super User' },
  { username: 'admin',     password: 'admin123',     role: 'admin',     name: 'Administrator' },
  { username: 'owner',     password: 'owner123',     role: 'owner',     name: 'Fleet Owner' },
  { username: 'driver',    password: 'driver123',    role: 'driver',    name: 'Driver' },
];

async function seedUsers() {
  await testConnection();
  await createTables();

  for (const user of DEFAULT_USERS) {
    const hash = await bcrypt.hash(user.password, 10);
    const [result] = await pool.query(
      `INSERT INTO users (username, password_hash, role, name)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE role = VALUES(role), name = VALUES(name)`,
      [user.username, hash, user.role, user.name]
    );
    console.log(`✅ User '${user.username}' (${user.role}) — ${result.affectedRows === 1 ? 'created' : 'updated'}`);
  }

  console.log('\nDefault credentials:');
  DEFAULT_USERS.forEach(u => console.log(`  ${u.role.padEnd(12)} ${u.username} / ${u.password}`));

  await pool.end();
}

seedUsers().catch(e => { console.error('❌', e.message); process.exit(1); });
