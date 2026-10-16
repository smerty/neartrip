/**
 * NearTRIP Admin Dashboard JavaScript
 */

/**
 * Show a styled alert message
 * @param {string} type - Alert type (success, error, warning, info)
 * @param {string} title - Alert title
 * @param {string} message - Alert message
 */
function showAlert(type, title, message) {
    // Remove any existing alerts
    const existingAlert = document.querySelector('.custom-alert');
    if (existingAlert) {
        existingAlert.remove();
    }
    
    const alertClass = {
        'success': 'alert-success',
        'error': 'alert-danger',
        'warning': 'alert-warning',
        'info': 'alert-info'
    }[type] || 'alert-info';
    
    const alertHtml = `
        <div class="alert ${alertClass} alert-dismissible fade show custom-alert" role="alert" style="position: fixed; top: 20px; right: 20px; z-index: 9999; max-width: 400px;">
            <strong>${title}</strong><br>
            ${message}
            <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', alertHtml);
    
    // Auto-dismiss after 5 seconds
    setTimeout(() => {
        const alert = document.querySelector('.custom-alert');
        if (alert) {
            alert.remove();
        }
    }, 5000);
}

// Global variables for UI elements
const stationModal = new bootstrap.Modal(document.getElementById('stationModal'));
let refreshInterval;

// Map variables
let map = null;
let stationMarkers = [];
let clientMarkers = [];

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
    // Initial data load
    loadServerInfo();
    loadStations();
    loadConnections();
    
    // Initialize map
    initMap();
    
    // Set up periodic refresh (every 5 seconds)
    refreshInterval = setInterval(() => {
        loadConnections();
        
        // Only refresh server info and don't auto-refresh the config editor
        // This prevents overwriting user edits in the config
        updateServerInfoWithoutConfigRefresh();
    }, 5000);

    // Show the appropriate tab based on URL hash
    loadTabFromUrlHash();

    // Setup event listeners
    setupEventListeners();
});

/**
 * Load the appropriate tab based on the URL hash
 */
function loadTabFromUrlHash() {
    // Get the hash from the URL (without the # symbol)
    const hash = window.location.hash.substring(1) || 'stations'; // Default to stations if no hash
    
    // Hide all sections
    document.querySelectorAll('#stations, #connections, #map, #settings').forEach(section => {
        section.style.display = 'none';
    });
    
    // Show appropriate sections based on hash
    if (hash === 'home') {
        // For home, show both stations and connections sections
        document.getElementById('stations').style.display = 'block';
        document.getElementById('connections').style.display = 'block';
        
        // Highlight the stations tab
        document.querySelectorAll('.navbar-nav .nav-link').forEach(navLink => {
            navLink.classList.remove('active');
        });
        document.querySelector('.navbar-nav .nav-link[href="#stations"]').classList.add('active');
    } else if (['stations', 'connections', 'map', 'settings'].includes(hash)) {
        // For other valid hashes, show just that section
        document.getElementById(hash).style.display = 'block';
        
        // Highlight the appropriate nav link
        document.querySelectorAll('.navbar-nav .nav-link').forEach(navLink => {
            navLink.classList.remove('active');
        });
        document.querySelector(`.navbar-nav .nav-link[href="#${hash}"]`).classList.add('active');
        
        // If showing map, make sure it renders correctly
        if (hash === 'map' && map) {
            setTimeout(() => {
                map.invalidateSize();
                updateMap();
            }, 100);
        }
    } else {
        // If hash is invalid, default to stations
        document.getElementById('stations').style.display = 'block';
        document.getElementById('connections').style.display = 'block';
        
        // Highlight the stations tab
        document.querySelectorAll('.navbar-nav .nav-link').forEach(navLink => {
            navLink.classList.remove('active');
        });
        document.querySelector('.navbar-nav .nav-link[href="#stations"]').classList.add('active');
    }
}

/**
 * Set up event listeners for all interactive elements
 */
function setupEventListeners() {    // Add station button
    document.getElementById('addStationBtn').addEventListener('click', () => {
        document.getElementById('formAction').value = 'add';
        document.getElementById('modalTitle').textContent = 'Add Station';
        document.getElementById('stationForm').reset();
        stationModal.show();
    });

    // Save station button
    document.getElementById('saveStationBtn').addEventListener('click', saveStation);

    // Reload config button
    document.getElementById('reloadConfigBtn').addEventListener('click', reloadConfig);
    
    // Config editor buttons
    document.getElementById('saveConfigBtn').addEventListener('click', saveFullConfig);
    document.getElementById('cancelConfigBtn').addEventListener('click', loadConfigEditor);
    document.getElementById('resetConfigBtn').addEventListener('click', resetToDefaultConfig);

    // Navigation links
    document.querySelectorAll('.navbar-nav .nav-link, .navbar-brand').forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const targetId = this.getAttribute('href').substring(1);
            
            // Hide all sections
            document.querySelectorAll('#stations, #connections, #map, #settings').forEach(section => {
                section.style.display = 'none';
            });
            
            // Show target section(s)
            if (targetId === 'home') {
                // For home, show both stations and connections sections
                document.getElementById('stations').style.display = 'block';
                document.getElementById('connections').style.display = 'block';
            } else {
                document.getElementById(targetId).style.display = 'block';
            }
            
            // Update active nav link
            document.querySelectorAll('.navbar-nav .nav-link').forEach(navLink => {
                navLink.classList.remove('active');
            });
            
            // If clicking the navbar brand, highlight the stations link
            if (targetId === 'home') {
                document.querySelector('.navbar-nav .nav-link[href="#stations"]').classList.add('active');
            } else {
                this.classList.add('active');
            }
            
            // Refresh map if showing map view
            if (targetId === 'map' && map) {
                map.invalidateSize();
                updateMap();
            }
        });
    });
}

/**
 * Load server information
 */
async function loadServerInfo() {
    try {
        const response = await fetch('/api/info');
        if (!response.ok) throw new Error('Failed to fetch server info');
        
        const data = await response.json();
        
        // Format and display server information
        const uptime = formatUptime(data.uptime);
        const memoryUsage = formatMemoryUsage(data.memoryUsage);
        
        document.getElementById('serverInfo').innerHTML = `
            <strong>NearTRIP v${data.version}</strong> | 
            Node ${data.nodeVersion} | 
            Uptime: ${uptime} | 
            Memory: ${memoryUsage} | 
            Mount Point: ${data.config.mountPoint} | 
            Stations: ${data.config.stations.length}
        `;
        
        // Load config editor if we're on the settings tab
        if (document.getElementById('settings').style.display !== 'none') {
            loadConfigEditor();
        }
    } catch (error) {
        console.error('Error loading server info:', error);
        document.getElementById('serverInfo').innerHTML = `
            <strong>Error:</strong> Could not load server information. ${error.message}
        `;
    }
}

/**
 * Load stations list 
 */
async function loadStations() {
    try {
        const response = await fetch('/api/stations');
        if (!response.ok) throw new Error('Failed to fetch stations');
        
        const stations = await response.json();
        
        const tableBody = document.querySelector('#stationsTable tbody');
        tableBody.innerHTML = '';
        
        if (stations.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="7" class="text-center">No stations configured</td></tr>';
            return;
        }
        
        stations.forEach(station => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>
                    <span class="status-indicator ${station.active ? 'status-active' : 'status-inactive'}" 
                          title="${station.active ? 'Active' : 'Inactive'}"></span>
                </td>
                <td>${station.mountPoint}</td>
                <td>${station.casterHost}</td>
                <td>${station.casterPort}</td>
                <td>${station.latitude.toFixed(6)}</td>
                <td>${station.longitude.toFixed(6)}</td>
                <td>
                    <button class="btn btn-sm btn-primary edit-btn" data-mount="${station.mountPoint}">Edit</button>
                    <button class="btn btn-sm btn-danger delete-btn" data-mount="${station.mountPoint}">Delete</button>
                </td>
            `;
            tableBody.appendChild(row);
            
            // Add event listeners for the edit and delete buttons
            row.querySelector('.edit-btn').addEventListener('click', () => editStation(station));
            row.querySelector('.delete-btn').addEventListener('click', () => deleteStation(station.mountPoint));
        });
    } catch (error) {
        console.error('Error loading stations:', error);
        document.querySelector('#stationsTable tbody').innerHTML = `
            <tr><td colspan="7" class="text-center text-danger">Error loading stations: ${error.message}</td></tr>
        `;
    }
}

/**
 * Load active connections
 */
async function loadConnections() {
    try {
        const response = await fetch('/api/connections');
        if (!response.ok) throw new Error('Failed to fetch connections');
        
        const connections = await response.json();
        
        const tableBody = document.querySelector('#connectionsTable tbody');
        tableBody.innerHTML = '';
        
        if (connections.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="13" class="text-center">No connections found</td></tr>';
            return;
        }
        
        connections.forEach(conn => {
            const row = document.createElement('tr');
            const isActive = conn.active === true;
            
            // Apply styling based on active status
            if (!isActive) {
                row.classList.add('connection-inactive');
            } else {
                row.classList.add('connection-active');
            }
            
            row.innerHTML = `
                <td>
                    <span class="status-indicator ${isActive ? 'status-active' : 'status-inactive'}" 
                          title="${isActive ? 'Active' : 'Inactive'}"></span>
                </td>
                <td>${conn.id.substring(0, 8)}...</td>
                <td>${conn.clientIp}</td>
                <td>${formatTimestamp(conn.connectedAt)}</td>
                <td>${conn.disconnectedAt ? formatTimestamp(conn.disconnectedAt) : '-'}</td>
                <td>${conn.currentStation || '-'}</td>
                <td>${conn.latitude ? conn.latitude.toFixed(6) : '-'}</td>
                <td>${conn.longitude ? conn.longitude.toFixed(6) : '-'}</td>
                <td>${getFixQualityText(conn.fixQuality)}</td>
                <td>${conn.numSatellites !== undefined ? conn.numSatellites : '-'}</td>
                <td>${formatBytes(conn.bytesSent)}</td>
                <td>${formatBytes(conn.bytesReceived)}</td>
                <td>
                    <a href="/api/connections/${conn.id}/nmea-log" class="btn btn-sm btn-info" 
                       download="connection-${conn.id}.nmea.log">Download</a>
                </td>
            `;
            tableBody.appendChild(row);
        });
    } catch (error) {
        console.error('Error loading connections:', error);
        document.querySelector('#connectionsTable tbody').innerHTML = `
            <tr><td colspan="13" class="text-center text-danger">Error loading connections: ${error.message}</td></tr>
        `;
    }
    
    // Update map with new client positions if map is initialized
    if (map) {
        updateClientMarkers();
    }
}

/**
 * Convert a fix quality number to descriptive text
 * 
 * @param {number|undefined} fixQuality - GPS fix quality value (0-8)
 * @returns {string} Human-readable fix quality description
 */
function getFixQualityText(fixQuality) {
    if (fixQuality === undefined || fixQuality === null) return '-';
    
    switch (parseInt(fixQuality, 10)) {
        case 0: return 'Invalid';
        case 1: return 'GPS Fix';
        case 2: return 'DGPS Fix';
        case 3: return 'PPS Fix';
        case 4: return 'RTK Fix';
        case 5: return 'Float RTK';
        case 6: return 'Estimated';
        case 7: return 'Manual';
        case 8: return 'Simulation';
        default: return `Unknown (${fixQuality})`;
    }
}

/**
 * Generate a formatted uptime string
 * 
 * @param {number} uptime - Server uptime in seconds
 * @returns {string} Formatted uptime string
 */
function formatUptime(uptime) {
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    
    if (days > 0) {
        return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    } else {
        return `${seconds}s`;
    }
}

/**
 * Format bytes to human-readable format
 * 
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted string (e.g. "1.5 MB")
 */
function formatBytes(bytes) {
    if (bytes === 0 || bytes === undefined) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Format memory usage
 * 
 * @param {Object} memoryUsage - Node.js memory usage object
 * @returns {string} Formatted memory usage string
 */
function formatMemoryUsage(memoryUsage) {
    return `${formatBytes(memoryUsage.rss)} / ${formatBytes(memoryUsage.heapTotal)}`;
}

/**
 * Format a timestamp
 * 
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} Formatted time string
 */
function formatTimestamp(timestamp) {
    if (!timestamp) return '-';
    
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    
    return `${hours}:${minutes}:${seconds}`;
}

/**
 * Initialize the map
 */
function initMap() {
    // Create a map centered around a default location
    map = L.map('mapContainer').setView([37.7749, -122.4194], 5);
    
    // Add the OpenStreetMap tile layer
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    
    // Update the map with station and client markers
    updateMap();
}

/**
 * Update the map with all markers
 */
function updateMap() {
    updateStationMarkers();
    updateClientMarkers();
}

/**
 * Update the station markers on the map
 */
async function updateStationMarkers() {
    try {
        const response = await fetch('/api/stations');
        if (!response.ok) throw new Error('Failed to fetch stations');
        
        const stations = await response.json();
        
        // Clear existing station markers
        stationMarkers.forEach(marker => marker.remove());
        stationMarkers = [];
        
        // Add markers for each station
        stations.forEach(station => {            
            if (station.latitude && station.longitude) {
                // Use default Leaflet marker but customize the icon
                const markerIcon = L.icon({
                    iconUrl: station.active ? 
                        'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-green.png' : 
                        'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png',
                    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
                    iconSize: [25, 41],
                    iconAnchor: [12, 41],
                    popupAnchor: [1, -34],
                    shadowSize: [41, 41]
                });
                
                  const marker = L.marker([station.latitude, station.longitude], {
                    icon: markerIcon
                }).addTo(map);
                
                // Only add range rings for active stations
                if (station.active) {
                    // Add 10km green circle around station
                    const circle10km = L.circle([station.latitude, station.longitude], {
                        color: 'green',
                        fillColor: '#3f3',
                        fillOpacity: 0.1,
                        radius: 10000 // 10km in meters
                    }).addTo(map);
                    
                    // Add 20km orange circle around station
                    const circle20km = L.circle([station.latitude, station.longitude], {
                        color: 'orange',
                        fillColor: '#fa3',
                        fillOpacity: 0.1,
                        radius: 20000 // 20km in meters
                    }).addTo(map);
                    
                    // Store circles for later removal
                    stationMarkers.push(circle10km);
                    stationMarkers.push(circle20km);
                }
                  marker.bindPopup(`
                    <strong>${station.mountPoint}</strong><br>
                    ${station.casterHost}:${station.casterPort}<br>
                    Status: ${station.active ? 'Active' : 'Inactive'}
                `);
                
                // Store marker for later removal
                stationMarkers.push(marker);
            }
        });
    } catch (error) {
        console.error('Error updating station markers:', error);
    }
}

/**
 * Update the client markers on the map
 */
async function updateClientMarkers() {
    try {
        const response = await fetch('/api/connections');
        if (!response.ok) throw new Error('Failed to fetch connections');
        
        const connections = await response.json();
        
        // Clear existing client markers
        clientMarkers.forEach(marker => marker.remove());
        clientMarkers = [];
        
        // Add markers for each client
        connections.forEach(conn => {
            if (conn.latitude && conn.longitude) {
                // Use a blue marker for clients
                const clientIcon = L.icon({
                    iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-blue.png',
                    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
                    iconSize: [25, 41],
                    iconAnchor: [12, 41],
                    popupAnchor: [1, -34],
                    shadowSize: [41, 41]
                });
                
                const marker = L.marker([conn.latitude, conn.longitude], {
                    icon: clientIcon
                }).addTo(map);
                
                // Include fix quality and satellites in the popup
                marker.bindPopup(`
                    <strong>Client ID:</strong> ${conn.id.substring(0, 8)}...<br>
                    <strong>IP:</strong> ${conn.clientIp}<br>
                    <strong>Current Station:</strong> ${conn.currentStation || '-'}<br>
                    <strong>Fix Quality:</strong> ${getFixQualityText(conn.fixQuality)}<br>
                    <strong>Satellites:</strong> ${conn.numSatellites !== undefined ? conn.numSatellites : '-'}<br>
                    <strong>Data Sent:</strong> ${formatBytes(conn.bytesSent)}<br>
                    <strong>Data Received:</strong> ${formatBytes(conn.bytesReceived)}
                `);
                
                clientMarkers.push(marker);
            }
        });
    } catch (error) {
        console.error('Error updating client markers:', error);
    }
}

/**
 * Update server info without refreshing the config editor
 * 
 * This function refreshes just the server status information
 * without reloading the config editor to avoid disrupting any
 * edits a user might be making.
 */
async function updateServerInfoWithoutConfigRefresh() {
    try {
        const response = await fetch('/api/info');
        if (!response.ok) throw new Error('Failed to fetch server info');
        
        const data = await response.json();
        
        // Format and display server information
        const uptime = formatUptime(data.uptime);
        const memoryUsage = formatMemoryUsage(data.memoryUsage);
        
        document.getElementById('serverInfo').innerHTML = `
            <strong>NearTRIP v${data.version}</strong> | 
            Node ${data.nodeVersion} | 
            Uptime: ${uptime} | 
            Memory: ${memoryUsage} | 
            Mount Point: ${data.config.mountPoint} | 
            Stations: ${data.config.stations.length}
        `;
    } catch (error) {
        console.error('Error updating server info:', error);
    }
}

/**
 * Load the configuration editor with the current config
 */
async function loadConfigEditor() {
    try {
        const response = await fetch('/api/config');
        if (!response.ok) throw new Error('Failed to fetch configuration');
        
        const config = await response.json();
        
        // Format the JSON with 2-space indentation for better readability
        document.getElementById('configEditor').value = JSON.stringify(config, null, 2);
    } catch (error) {
        console.error('Error loading configuration:', error);
        document.getElementById('configEditor').value = `Error loading configuration: ${error.message}`;
    }
}

/**
 * Save the full configuration
 */
async function saveFullConfig() {
    try {
        const configText = document.getElementById('configEditor').value;
        
        // Validate JSON
        let config;
        try {
            config = JSON.parse(configText);
        } catch (parseError) {
            alert(`Invalid JSON: ${parseError.message}`);
            return;
        }
        
        // Send to server
        const response = await fetch('/api/config', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: configText
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || 'Failed to save configuration');
        }
        
        alert('Configuration saved successfully');
        
        // Reload the server info to reflect changes
        loadServerInfo();
    } catch (error) {
        console.error('Error saving configuration:', error);
        alert(`Error saving configuration: ${error.message}`);
    }
}

/**
 * Reset to default configuration
 */
async function resetToDefaultConfig() {
    if (!confirm('Are you sure you want to reset to the default configuration? This will overwrite all your changes.')) {
        return;
    }
    
    try {
        const response = await fetch('/api/config/reset', {
            method: 'POST'
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || 'Failed to reset configuration');
        }
        
        alert('Configuration reset to defaults');
        
        // Reload the config editor and server info
        loadConfigEditor();
        loadServerInfo();
    } catch (error) {
        console.error('Error resetting configuration:', error);
        alert(`Error resetting configuration: ${error.message}`);
    }
}

/**
 * Reload the server configuration
 */
async function reloadConfig() {
    try {
        const response = await fetch('/api/reload', {
            method: 'POST'
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || 'Failed to reload configuration');
        }
        
        alert('Configuration reloaded successfully');
        
        // Reload the server info to reflect changes
        loadServerInfo();
    } catch (error) {
        console.error('Error reloading configuration:', error);
        alert(`Error reloading configuration: ${error.message}`);
    }
}

/**
 * Edit a station
 * 
 * @param {Object} station - The station data to edit
 */
function editStation(station) {
    document.getElementById('formAction').value = 'edit';
    document.getElementById('modalTitle').textContent = 'Edit Station';
    
    // Populate form fields
    document.getElementById('stationMountPoint').value = station.mountPoint;
    document.getElementById('stationCasterHost').value = station.casterHost;
    document.getElementById('stationCasterPort').value = station.casterPort;
    document.getElementById('stationUsername').value = station.username || '';
    document.getElementById('stationPassword').value = station.password || '';
    document.getElementById('stationLatitude').value = station.latitude;
    document.getElementById('stationLongitude').value = station.longitude;
    
    // Store original mount point for reference in case it changes
    document.getElementById('originalMountPoint').value = station.mountPoint;
    
    stationModal.show();
}

/**
 * Save a station (add or edit)
 */
async function saveStation() {
    try {
        const formAction = document.getElementById('formAction').value;
        const originalMountPoint = document.getElementById('originalMountPoint').value;
        
        // Get form values
        const station = {
            mountPoint: document.getElementById('mountPoint').value.trim(),
            casterHost: document.getElementById('casterHost').value.trim(),
            casterPort: parseInt(document.getElementById('casterPort').value, 10),
            username: document.getElementById('stationUsername').value.trim(),
            password: document.getElementById('stationPassword').value,
            latitude: parseFloat(document.getElementById('latitude').value),
            longitude: parseFloat(document.getElementById('longitude').value),
            active: document.getElementById('active').checked
        };
        
        // Enhanced validation
        const errors = [];
        
        if (!station.mountPoint) {
            errors.push('Mount Point is required');
        } else if (!/^[A-Z0-9_-]+$/i.test(station.mountPoint)) {
            errors.push('Mount Point can only contain letters, numbers, hyphens, and underscores');
        }
        
        if (!station.casterHost) {
            errors.push('Caster Host is required');
        } else if (!/^[a-zA-Z0-9.-]+$/.test(station.casterHost)) {
            errors.push('Caster Host must be a valid hostname or IP address');
        }
        
        if (!station.casterPort || isNaN(station.casterPort) || station.casterPort < 1 || station.casterPort > 65535) {
            errors.push('Caster Port must be a valid port number (1-65535)');
        }
        
        if (isNaN(station.latitude) || station.latitude < -90 || station.latitude > 90) {
            errors.push('Latitude must be a valid number between -90 and 90');
        }
        
        if (isNaN(station.longitude) || station.longitude < -180 || station.longitude > 180) {
            errors.push('Longitude must be a valid number between -180 and 180');
        }
        
        if (errors.length > 0) {
            showAlert('error', 'Validation Error', errors.join('<br>'));
            return;
        }
        
        let url = '/api/stations';
        let method = 'POST';
        
        // If editing, use PUT method and include original mount point
        if (formAction === 'edit') {
            url = `/api/stations/${encodeURIComponent(originalMountPoint)}`;
            method = 'PUT';
        }
        
        const response = await fetch(url, {
            method: method,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(station)
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || 'Failed to save station');
        }
        
        showAlert('success', 'Success', `Station ${formAction === 'edit' ? 'updated' : 'added'} successfully`);
        stationModal.hide();
        loadStations();
        
        if (map) {
            updateStationMarkers();
        }
    } catch (error) {
        console.error('Error saving station:', error);
        showAlert('error', 'Error', `Failed to save station: ${error.message}`);
    }
}

/**
 * Delete a station
 * 
 * @param {string} mountPoint - The mount point of the station to delete
 */
async function deleteStation(mountPoint) {
    if (!confirm(`Are you sure you want to delete station "${mountPoint}"?`)) {
        return;
    }
    
    try {
        const response = await fetch(`/api/stations/${encodeURIComponent(mountPoint)}`, {
            method: 'DELETE'
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || 'Failed to delete station');
        }
        
        loadStations();
        
        if (map) {
            updateStationMarkers();
        }
    } catch (error) {
        console.error('Error deleting station:', error);
        alert(`Error deleting station: ${error.message}`);
    }
}
