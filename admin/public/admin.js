/**
 * NearTRIP Admin Dashboard JavaScript
 */

// Global variables for UI elements
const stationModal = new bootstrap.Modal(document.getElementById('stationModal'));
let refreshInterval;
let configEditorLoaded = false;
let configEditorLoading = false;

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

    // Restore the page from the URL so refresh and back/forward keep the view
    if (!window.location.hash) {
        history.replaceState(null, '', '#stations');
    }
    loadTabFromUrlHash();
    window.addEventListener('hashchange', loadTabFromUrlHash);

    // Setup event listeners
    setupEventListeners();
});

const PAGES = ['home', 'stations', 'connections', 'map', 'users', 'statistics', 'security', 'settings'];

/**
 * Load the appropriate tab based on the URL hash
 */
function loadTabFromUrlHash() {
    let hash = window.location.hash.substring(1);
    if (!PAGES.includes(hash)) {
        hash = 'stations';
        history.replaceState(null, '', '#stations');
    }

    document.querySelectorAll('#stations, #connections, #map, #users, #statistics, #security, #settings').forEach(section => {
        section.style.display = 'none';
    });

    if (hash === 'home') {
        document.getElementById('stations').style.display = 'block';
        document.getElementById('connections').style.display = 'block';
    } else {
        document.getElementById(hash).style.display = 'block';
    }

    const activeHref = hash === 'home' ? '#stations' : `#${hash}`;
    document.querySelectorAll('.navbar-nav .nav-link').forEach(navLink => {
        navLink.classList.toggle('active', navLink.getAttribute('href') === activeHref);
    });

    if (hash === 'map' && map) {
        setTimeout(() => {
            map.invalidateSize();
            updateMap().then(() => { if (!atlasShown) { stationAtlas?.fit(); atlasShown = true; } });
        }, 100);
    }

    if (hash === 'settings' && !configEditorLoaded) {
        loadConfigEditor();
    }
    if (hash === 'connections' || hash === 'home') {
        loadConnections();
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

    // Navigation links update the URL; hashchange renders the page
    document.querySelectorAll('.navbar-nav .nav-link, .navbar-brand').forEach(link => {
        link.addEventListener('click', function(e) {
            const href = this.getAttribute('href') || '';
            if (!href.startsWith('#')) return;

            e.preventDefault();
            const targetId = href.substring(1);
            if (window.location.hash === `#${targetId}`) {
                loadTabFromUrlHash();
                return;
            }
            window.location.hash = targetId;
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

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

function connectionCounts(connections) {
    const active = connections.filter(conn => conn.active === true);
    return {
        tcp: active.length,
        rovers: active.filter(conn => conn.authenticated === true).length,
        streaming: active.filter(conn => conn.status === 'streaming' && conn.upstreamStatus === 'connected').length,
    };
}

/**
 * Load active connections
 */
async function loadConnections() {
    try {
        const response = await fetch('/api/connections');
        if (!response.ok) throw new Error('Failed to fetch connections');
        
        const connections = await response.json();
        
        const counts = connectionCounts(connections);
        document.getElementById('connectionSummary').textContent =
            `${counts.tcp} connected sockets · ${counts.rovers} active rovers · ${counts.streaming} streaming`;
        const tableBody = document.querySelector('#connectionsTable tbody');
        tableBody.innerHTML = '';
        
        if (connections.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="17" class="text-center">No connections found</td></tr>';
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
                    ${escapeHtml(conn.status || (isActive ? 'connected' : 'disconnected'))}
                </td>
                <td>${conn.id.substring(0, 8)}...</td>
                <td>${conn.clientIp}</td>
                <td>${formatTimestamp(conn.connectedAt)}</td>
                <td>${conn.disconnectedAt ? formatTimestamp(conn.disconnectedAt) : '-'}</td>
                <td>${escapeHtml(conn.currentStation || '-')}</td>
                <td>${conn.latitude != null ? conn.latitude.toFixed(6) : '-'}</td>
                <td>${conn.longitude != null ? conn.longitude.toFixed(6) : '-'}</td>
                <td>${getFixQualityText(conn.fixQuality)}</td>
                <td>${conn.numSatellites !== undefined ? conn.numSatellites : '-'}</td>
                <td>${formatBytes(conn.bytesSent)}</td>
                <td>${formatBytes(conn.bytesReceived)}</td>
                <td>${conn.lastGgaAt ? formatTimestamp(conn.lastGgaAt) : '-'}</td>
                <td>${escapeHtml(conn.upstreamStatus || '-')}<br>${escapeHtml(conn.lastUpstreamError || '')}</td>
                <td>${conn.readIdleTimeoutSecs || '-'} s</td>
                <td>${escapeHtml(conn.disconnectReason || '-')}</td>
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
            <tr><td colspan="17" class="text-center text-danger">Error loading connections: ${error.message}</td></tr>
        `;
    }
    
    // Update map with new client positions if map is initialized
    if (map) {
        updateStationMarkers();
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
    
    return `${date.toLocaleDateString()} ${hours}:${minutes}:${seconds}`;
}

/**
 * Initialize the map
 */
let stationAtlas;
let atlasShown = false;
function initMap() {
    try {
        stationAtlas = new NetworkMap('mapContainer', { admin: true });
        map = stationAtlas.map;
        document.getElementById('fitAdminNetwork').addEventListener('click', () => stationAtlas.fit());
        updateMap();
    } catch (error) { console.error('Map unavailable:', error); }
}
async function updateMap() {
    await Promise.all([updateStationMarkers(), updateClientMarkers()]);
}
async function updateStationMarkers() {
    if (!stationAtlas) return;
    try {
        const response = await fetch('/api/public/stations');
        if (!response.ok) throw new Error('Station map unavailable');
        stationAtlas.setStations(await response.json());
    } catch (error) { console.error(error); }
}
async function updateClientMarkers() {
    if (!stationAtlas) return;
    try {
        const response = await fetch('/api/connections');
        if (!response.ok) throw new Error('Client map unavailable');
        stationAtlas.setClients(await response.json());
    } catch (error) { console.error(error); }
}

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
    if (configEditorLoading) return;
    configEditorLoading = true;
    try {
        const response = await fetch('/api/config');
        if (!response.ok) throw new Error('Failed to fetch configuration');
        
        const config = await response.json();
        
        // Format the JSON with 2-space indentation for better readability
        document.getElementById('configEditor').value = JSON.stringify(config, null, 2);
        configEditorLoaded = true;
    } catch (error) {
        console.error('Error loading configuration:', error);
        document.getElementById('configEditor').value = `Error loading configuration: ${error.message}`;
    } finally {
        configEditorLoading = false;
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
            mountPoint: document.getElementById('stationMountPoint').value,
            casterHost: document.getElementById('stationCasterHost').value,
            casterPort: parseInt(document.getElementById('stationCasterPort').value, 10),
            username: document.getElementById('stationUsername').value,
            password: document.getElementById('stationPassword').value,
            latitude: parseFloat(document.getElementById('stationLatitude').value),
            longitude: parseFloat(document.getElementById('stationLongitude').value)
        };
        
        // Validate required fields
        if (!station.mountPoint || !station.casterHost || !station.casterPort ||
            isNaN(station.latitude) || isNaN(station.longitude)) {
            alert('Please fill in all required fields');
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
        
        stationModal.hide();
        loadStations();
        
        if (map) {
            updateStationMarkers();
        }
    } catch (error) {
        console.error('Error saving station:', error);
        alert(`Error saving station: ${error.message}`);
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
