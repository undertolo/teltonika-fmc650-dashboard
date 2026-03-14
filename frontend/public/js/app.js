// app.js - Aplicación principal del dashboard
// Works when served from root (Node.js direct) or from /newdashboard/ (nginx)
const BASE_PATH = window.location.pathname.startsWith('/newdashboard') ? '/newdashboard' : '';
const API_BASE_URL = window.location.origin + BASE_PATH;

const app = {
  // Variables de estado
  map: null,
  markers: {},
  devices: [],
  selectedDevice: null,
  routePolyline: null,
  autoRefreshInterval: null,
  user: null,

  // Inicialización
  async init() {
    if (!this.initAuth()) return;
    this.initDarkMode();
    this.initMap();
    await this.loadDevices();
    this.startAutoRefresh();
    this.updateServerStatus();
  },

  // Auth
  initAuth() {
    const token = localStorage.getItem('token');
    const user = localStorage.getItem('user');
    if (!token || !user) {
      window.location.replace(BASE_PATH + '/login.html');
      return false;
    }
    this.user = JSON.parse(user);
    this.showUserInfo();
    return true;
  },

  showUserInfo() {
    const roleColors = { superuser: '#9b59b6', admin: '#e74c3c', owner: '#e67e22', driver: '#2ecc71' };
    const color = roleColors[this.user.role] || '#3498db';
    document.getElementById('user-info').innerHTML = `
      <span class="user-name">${this.user.name || this.user.username}</span>
      <span class="role-badge" style="background:${color}">${this.user.role}</span>
    `;
  },

  authHeaders() {
    return { 'Authorization': `Bearer ${localStorage.getItem('token')}` };
  },

  logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.replace(BASE_PATH + '/login.html');
  },

  // Handle 401 from any API call
  handleUnauthorized() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.replace(BASE_PATH + '/login.html');
  },

  // Dark mode
  initDarkMode() {
    if (localStorage.getItem('darkMode') === 'true') {
      document.body.classList.add('dark');
      document.querySelector('.dark-mode-btn').textContent = '☀️';
    }
  },

  toggleDarkMode() {
    const isDark = document.body.classList.toggle('dark');
    document.querySelector('.dark-mode-btn').textContent = isDark ? '☀️' : '🌙';
    localStorage.setItem('darkMode', isDark);
  },

  // Inicializar mapa
  initMap() {
    this.map = L.map('map').setView([23.6345, -102.5528], 5); // Centro de México

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 18
    }).addTo(this.map);

    console.log('✅ Mapa inicializado');
  },

  // Cargar dispositivos
  async loadDevices() {
    try {
      const response = await fetch(`${API_BASE_URL}/api/devices`, { headers: this.authHeaders() });
      if (response.status === 401) { this.handleUnauthorized(); return; }
      const data = await response.json();

      if (data.success) {
        this.displayDevices(data.devices);
        this.updateLastUpdate();
        this.updateServerStatus(true);
      } else {
        this.showError('device-list', 'Error cargando dispositivos');
      }
    } catch (error) {
      console.error('Error:', error);
      this.showError('device-list', 'Error de conexión');
      this.updateServerStatus(false);
    }
  },

  // Mostrar dispositivos en la lista
  displayDevices(devices) {
    this.devices = devices;
    const container = document.getElementById('device-list');

    if (devices.length === 0) {
      container.innerHTML = '<div class="no-data">No hay dispositivos registrados</div>';
      return;
    }

    container.innerHTML = '';

    devices.forEach(device => {
      const isOnline = this.isDeviceOnline(device.last_seen);

      const div = document.createElement('div');
      div.className = 'device-item';
      div.dataset.imei = device.imei;
      if (this.selectedDevice === device.imei) {
        div.classList.add('active');
      }

      div.onclick = () => this.selectDevice(device.imei);

      div.innerHTML = `
        <div class="device-imei">
          <span class="status-indicator ${isOnline ? 'status-online' : 'status-offline'}"></span>
          ${device.imei}
        </div>
        <div class="device-meta">
          ${device.total_records || 0} registros
          <br>
          ${this.formatDate(device.last_seen)}
        </div>
      `;

      container.appendChild(div);
    });

    console.log(`✅ ${devices.length} dispositivos cargados`);

    // Show all device positions on the live map
    this.updateMapMarkers(devices);
  },

  // Update all device markers on the map
  async updateMapMarkers(devices) {
    // Fetch all latest positions in parallel
    const results = await Promise.allSettled(
      devices.map(d =>
        fetch(`${API_BASE_URL}/api/device/${d.imei}/latest`, { headers: this.authHeaders() }).then(r => r.json())
      )
    );

    // Remove markers for devices no longer present
    const activeImeis = new Set(devices.map(d => d.imei));
    Object.keys(this.markers).forEach(imei => {
      if (!activeImeis.has(imei)) {
        this.map.removeLayer(this.markers[imei]);
        delete this.markers[imei];
      }
    });

    results.forEach((result, i) => {
      if (result.status !== 'fulfilled' || !result.value.success || !result.value.position) return;
      const pos = result.value.position;
      const device = devices[i];
      const isOnline = this.isDeviceOnline(device.last_seen);
      const isSelected = this.selectedDevice === pos.imei;

      if (this.markers[pos.imei]) {
        // Update existing marker
        this.markers[pos.imei].setLatLng([pos.latitude, pos.longitude]);
        this.markers[pos.imei].setIcon(this.createDeviceIcon(isOnline, isSelected));
        this.markers[pos.imei].setPopupContent(this.buildMarkerPopup(pos, isOnline));
      } else {
        // Create new marker
        const marker = L.marker([pos.latitude, pos.longitude], {
          icon: this.createDeviceIcon(isOnline, isSelected)
        }).addTo(this.map);

        marker.bindPopup(this.buildMarkerPopup(pos, isOnline));
        marker.on('click', () => this.selectDevice(pos.imei));
        this.markers[pos.imei] = marker;
      }
    });

    // If no device is selected, fit map to show all markers
    const markerList = Object.values(this.markers);
    if (!this.selectedDevice && markerList.length > 0) {
      const group = L.featureGroup(markerList);
      this.map.fitBounds(group.getBounds().pad(0.2));
    }
  },

  // Create a colored circle icon for a device marker
  createDeviceIcon(isOnline, isSelected) {
    const color = isSelected ? '#e74c3c' : isOnline ? '#2ecc71' : '#95a5a6';
    const size = isSelected ? 18 : 14;
    return L.divIcon({
      html: `<div style="background:${color};width:${size}px;height:${size}px;border-radius:50%;border:2px solid white;box-shadow:0 1px 5px rgba(0,0,0,0.5)"></div>`,
      className: '',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -(size / 2) - 4]
    });
  },

  // Build popup HTML for a marker
  buildMarkerPopup(pos, isOnline) {
    const statusColor = isOnline ? '#2ecc71' : '#95a5a6';
    const statusLabel = isOnline ? 'En línea' : 'Sin conexión';
    return `
      <b>${pos.imei}</b><br>
      <span style="color:${statusColor}">● ${statusLabel}</span><br>
      Velocidad: ${pos.speed || 0} km/h<br>
      Altitud: ${pos.altitude || 0} m<br>
      Satélites: ${pos.satellites || 0}<br>
      ${this.formatDate(pos.timestamp)}
    `;
  },

  // Seleccionar dispositivo
  async selectDevice(imei) {
    this.selectedDevice = imei;

    // Update sidebar active state
    document.querySelectorAll('.device-item').forEach(item => {
      item.classList.toggle('active', item.dataset.imei === imei);
    });

    // Update marker icons to reflect new selection
    const deviceMap = Object.fromEntries(this.devices.map(d => [d.imei, d]));
    Object.entries(this.markers).forEach(([markerImei, marker]) => {
      const device = deviceMap[markerImei];
      if (device) {
        const isOnline = this.isDeviceOnline(device.last_seen);
        marker.setIcon(this.createDeviceIcon(isOnline, markerImei === imei));
      }
    });

    // Load device data (position, route, stats)
    await this.loadDeviceData(imei);
  },

  // Cargar datos del dispositivo
  async loadDeviceData(imei) {
    try {
      // Cargar última posición
      const posResponse = await fetch(`${API_BASE_URL}/api/device/${imei}/latest`, { headers: this.authHeaders() });
      if (posResponse.status === 401) { this.handleUnauthorized(); return; }
      const posData = await posResponse.json();

      if (posData.success && posData.position) {
        this.displayDevicePosition(posData.position);
      }

      // Cargar estadísticas
      const statsResponse = await fetch(`${API_BASE_URL}/api/device/${imei}/stats`, { headers: this.authHeaders() });
      const statsData = await statsResponse.json();

      if (statsData.success && statsData.stats) {
        this.displayDeviceStats(statsData.stats);
      }

      // Cargar ruta (últimas 24 horas)
      const routeResponse = await fetch(`${API_BASE_URL}/api/device/${imei}/route?hours=24&limit=500`, { headers: this.authHeaders() });
      const routeData = await routeResponse.json();

      if (routeData.success && routeData.route) {
        this.displayRoute(routeData.route);
      }

      this.updateLastUpdate();

    } catch (error) {
      console.error('Error cargando datos del dispositivo:', error);
    }
  },

  // Centrar mapa en el dispositivo seleccionado y actualizar stats
  displayDevicePosition(position) {
    const lat = position.latitude;
    const lon = position.longitude;

    // Center map on selected device
    this.map.setView([lat, lon], 14);

    // Open the marker popup
    if (this.markers[position.imei]) {
      this.markers[position.imei].openPopup();
    }

    // Actualizar estadísticas en pantalla
    document.getElementById('stat-speed').textContent = position.speed || 0;
    document.getElementById('stat-altitude').textContent = position.altitude || 0;
    document.getElementById('stat-satellites').textContent = position.satellites || 0;
    document.getElementById('stats-grid').style.display = 'grid';

    console.log(`📍 Posición mostrada: ${lat}, ${lon}`);
  },

  // Mostrar estadísticas del dispositivo
  displayDeviceStats(stats) {
    document.getElementById('stat-records').textContent = stats.total_records || 0;

    const detailsDiv = document.getElementById('device-details');
    detailsDiv.innerHTML = `
      <div class="info-row">
        <span class="info-label">IMEI:</span>
        <span class="info-value">${stats.imei}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Primera conexión:</span>
        <span class="info-value">${this.formatDate(stats.first_seen)}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Última conexión:</span>
        <span class="info-value">${this.formatDate(stats.last_seen)}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Total registros:</span>
        <span class="info-value">${stats.total_records || 0}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Velocidad promedio:</span>
        <span class="info-value">${stats.avg_speed ? stats.avg_speed.toFixed(1) : 0} km/h</span>
      </div>
      <div class="info-row">
        <span class="info-label">Velocidad máxima:</span>
        <span class="info-value">${stats.max_speed || 0} km/h</span>
      </div>
    `;

    document.getElementById('device-info').style.display = 'block';
    console.log(`📊 Estadísticas cargadas para ${stats.imei}`);
  },

  // Mostrar ruta en el mapa
  displayRoute(route) {
    // Limpiar ruta anterior
    if (this.routePolyline) {
      this.map.removeLayer(this.routePolyline);
    }

    if (route.length === 0) {
      console.log('⚠️  Sin datos de ruta');
      return;
    }

    // Crear array de coordenadas (invertir orden para que vaya del más antiguo al más reciente)
    const coordinates = route.slice().reverse().map(point => [point.latitude, point.longitude]);

    // Crear polyline
    this.routePolyline = L.polyline(coordinates, {
      color: '#3498db',
      weight: 3,
      opacity: 0.7
    }).addTo(this.map);

    console.log(`🛣️  Ruta mostrada: ${route.length} puntos`);
  },

  // Verificar si dispositivo está online (últimos 5 minutos)
  isDeviceOnline(lastSeen) {
    if (!lastSeen) return false;
    const now = new Date();
    const lastSeenDate = new Date(lastSeen);
    const diffMinutes = (now - lastSeenDate) / 1000 / 60;
    return diffMinutes < 5;
  },

  // Formatear fecha
  formatDate(dateStr) {
    if (!dateStr) return 'N/A';
    const date = new Date(dateStr);
    return date.toLocaleString('es-MX', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  },

  // Mostrar error
  showError(containerId, message) {
    const container = document.getElementById(containerId);
    container.innerHTML = `<div class="error">${message}</div>`;
  },

  // Actualizar indicador de última actualización
  updateLastUpdate() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('es-MX', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    document.getElementById('last-update').textContent = `Última actualización: ${timeStr}`;
  },

  // Actualizar estado del servidor
  updateServerStatus(online = true) {
    const badge = document.getElementById('server-status');
    if (online) {
      badge.classList.add('online');
      badge.classList.remove('offline');
    } else {
      badge.classList.add('offline');
      badge.classList.remove('online');
    }
  },

  // Iniciar auto-refresh
  startAutoRefresh() {
    // Actualizar cada 30 segundos
    this.autoRefreshInterval = setInterval(() => {
      this.loadDevices();
      if (this.selectedDevice) {
        this.loadDeviceData(this.selectedDevice);
      }
    }, 30000);

    console.log('🔄 Auto-refresh iniciado (30s)');
  },

  // Reset map to show all devices
  showAllDevices() {
    this.selectedDevice = null;

    // Clear route
    if (this.routePolyline) {
      this.map.removeLayer(this.routePolyline);
      this.routePolyline = null;
    }

    // Deselect sidebar item and update marker icons
    document.querySelectorAll('.device-item').forEach(item => item.classList.remove('active'));
    const deviceMap = Object.fromEntries(this.devices.map(d => [d.imei, d]));
    Object.entries(this.markers).forEach(([imei, marker]) => {
      const device = deviceMap[imei];
      if (device) marker.setIcon(this.createDeviceIcon(this.isDeviceOnline(device.last_seen), false));
    });

    // Hide info panels
    document.getElementById('device-info').style.display = 'none';
    document.getElementById('stats-grid').style.display = 'none';

    // Fit map to all markers
    const markerList = Object.values(this.markers);
    if (markerList.length > 0) {
      this.map.fitBounds(L.featureGroup(markerList).getBounds().pad(0.2));
    }
  },

  // Detener auto-refresh
  stopAutoRefresh() {
    if (this.autoRefreshInterval) {
      clearInterval(this.autoRefreshInterval);
      console.log('🛑 Auto-refresh detenido');
    }
  }
};

// Inicializar cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', () => {
  console.log('🚀 Iniciando dashboard...');
  app.init();
});

// Limpiar al cerrar
window.addEventListener('beforeunload', () => {
  app.stopAutoRefresh();
});
