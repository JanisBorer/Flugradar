const CONFIG = {
    initialCenter: [47.15, 8.35],
    initialZoom: 8,
    maxLatSpan: 11.0,
    maxLonSpan: 16.0,
    refreshIntervalMs: 10000,
    openSkyEndpoint: 'https://opensky-network.org/api/states/all'
};

const state = {
    map: null,
    markers: new Map(),
    aircraftData: new Map(),
    selectedIcao: null,
    followSelected: false,
    autoRefresh: true,
    refreshTimer: null,
    simTimer: null,
    isSimulationMode: false,
    searchQuery: '',
    isFetching: false,
    simAircraft: []
};

function initMap() {
    state.map = L.map('map', {
        center: CONFIG.initialCenter,
        zoom: CONFIG.initialZoom,
        zoomControl: false,
        minZoom: 3,
        maxZoom: 16
    });

    L.control.zoom({ position: 'bottomright' }).addTo(state.map);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors | Daten: OpenSky Network',
    maxZoom: 19
}).addTo(state.map);

    let moveTimeout = null;
    state.map.on('moveend', () => {
        clearTimeout(moveTimeout);
        moveTimeout = setTimeout(() => {
            if (!state.isSimulationMode) {
                fetchFlightData();
            } else {
                renderAircraftOnMap();
            }
        }, 400);
    });

    state.map.on('dragstart', () => {
        state.followSelected = false;
    });
}

function getAltitudeColor(altitudeMeters, onGround) {
    if (onGround || altitudeMeters === null || altitudeMeters < 1000) return '#fbbf24';
    if (altitudeMeters < 7000) return '#34d399';
    return '#38bdf8';
}

function createAircraftIcon(aircraft, isSelected) {
    const heading = aircraft.true_track || 0;
    const color = isSelected ? '#f59e0b' : getAltitudeColor(aircraft.baro_altitude, aircraft.on_ground);
    const scale = isSelected ? 1.25 : 1.0;

    const svgHtml = `
        <div class="aircraft-icon-wrapper ${isSelected ? 'aircraft-selected' : ''}" 
             style="transform: rotate(${heading}deg) scale(${scale});">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="${color}" stroke="#090d16" stroke-width="1.2">
                <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
            </svg>
        </div>
    `;

    return L.divIcon({
        html: svgHtml,
        className: 'aircraft-marker-container',
        iconSize: [32, 32],
        iconAnchor: [16, 16]
    });
}

function isBoundsWithinLimit(bounds) {
    const latSpan = Math.abs(bounds.getNorth() - bounds.getSouth());
    const lonSpan = Math.abs(bounds.getEast() - bounds.getWest());
    return latSpan <= CONFIG.maxLatSpan && lonSpan <= CONFIG.maxLonSpan;
}

function parseOpenSkyState(raw) {
    const lon = raw[5];
    const lat = raw[6];
    if (lon === null || lat === null) return null;

    const callsign = raw[1] ? raw[1].trim() : '';
    return {
        icao24: raw[0],
        callsign: callsign || `N/A (${raw[0].toUpperCase()})`,
        origin_country: raw[2] || 'Unbekannt',
        longitude: lon,
        latitude: lat,
        baro_altitude: raw[7] !== null ? raw[7] : raw[13],
        on_ground: Boolean(raw[8]),
        velocity: raw[9],
        true_track: raw[10] || 0,
        vertical_rate: raw[11]
    };
}

async function fetchFlightData() {
    if (state.isSimulationMode || state.isFetching) return;

    state.isFetching = true;
    const center = state.map.getCenter();
    const url = `https://opendata.adsb.fi/api/v2/lat/${center.lat.toFixed(4)}/lon/${center.lng.toFixed(4)}/dist/250`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP_${response.status}`);

        const data = await response.json();
        document.getElementById('error-banner').classList.add('hidden');
        updateStatusIndicator('live', 'Live-Daten (adsb.fi)');

        state.aircraftData.clear();
        if (data && Array.isArray(data.ac)) {
            for (const ac of data.ac) {
                if (typeof ac.lat !== 'number' || typeof ac.lon !== 'number' || !ac.hex) continue;

                const altMeters = typeof ac.alt_baro === 'number'
                    ? ac.alt_baro * 0.3048
                    : null;

                state.aircraftData.set(ac.hex, {
                    icao24: ac.hex,
                    callsign: (ac.flight || '').trim() || `N/A (${ac.hex.toUpperCase()})`,
                    origin_country: ac.cou || 'Unbekannt',
                    longitude: ac.lon,
                    latitude: ac.lat,
                    baro_altitude: altMeters,
                    on_ground: ac.alt_baro === 'ground',
                    velocity: typeof ac.gs === 'number' ? ac.gs * 0.514444 : null,
                    true_track: typeof ac.track === 'number' ? ac.track : 0,
                    vertical_rate: typeof ac.baro_rate === 'number' ? ac.baro_rate * 0.00508 : null
                });
            }
        }

        updateLastUpdateTime();
        renderAircraftOnMap();
    } catch (error) {
        console.error('Live-API Fehler:', error);
        handleApiError(error.message);
    } finally {
        clearTimeout(timeoutId);
        state.isFetching = false;
    }
}

function handleApiError(errorCode) {
    const errorBanner = document.getElementById('error-banner');
    const errorTitle = document.getElementById('error-title');
    const errorMsg = document.getElementById('error-message');

    if (errorCode === 'RATE_LIMIT') {
        errorTitle.textContent = 'OpenSky Rate-Limit erreicht (HTTP 429)';
        errorMsg.textContent = 'Die kostenlose OpenSky-API hat die Anfragerate begrenzt. Starte den Simulationsmodus zum Testen.';
        updateStatusIndicator('error', 'API-Limit erreicht');
    } else {
        errorTitle.textContent = 'Verbindungsfehler zur API';
        errorMsg.textContent = 'Live-Daten konnten nicht geladen werden. Nutze alternativ den Simulationsmodus.';
        updateStatusIndicator('error', 'Verbindungsfehler');
    }
    errorBanner.classList.remove('hidden');
}

function renderAircraftOnMap() {
    const activeIcaos = new Set();
    let visibleCount = 0;
    const query = state.searchQuery.toLowerCase().trim();

    state.aircraftData.forEach((aircraft, icao) => {
        if (query) {
            const match = aircraft.callsign.toLowerCase().includes(query) ||
                          aircraft.origin_country.toLowerCase().includes(query) ||
                          aircraft.icao24.toLowerCase().includes(query);
            if (!match) return;
        }

        activeIcaos.add(icao);
        visibleCount++;

        const isSelected = state.selectedIcao === icao;
        const icon = createAircraftIcon(aircraft, isSelected);

        if (state.markers.has(icao)) {
            const marker = state.markers.get(icao);
            marker.setLatLng([aircraft.latitude, aircraft.longitude]);
            marker.setIcon(icon);
        } else {
            const marker = L.marker([aircraft.latitude, aircraft.longitude], { icon }).addTo(state.map);
            marker.on('click', () => selectAircraft(icao));
            state.markers.set(icao, marker);
        }
    });

    state.markers.forEach((marker, icao) => {
        if (!activeIcaos.has(icao)) {
            state.map.removeLayer(marker);
            state.markers.delete(icao);
        }
    });

    document.getElementById('aircraft-count').textContent = visibleCount;

    if (state.selectedIcao && state.aircraftData.has(state.selectedIcao)) {
        const selected = state.aircraftData.get(state.selectedIcao);
        updateDetailPanel(selected);
        if (state.followSelected) {
            state.map.panTo([selected.latitude, selected.longitude], { animate: true });
        }
    }
}

function selectAircraft(icao) {
    const prev = state.selectedIcao;
    state.selectedIcao = icao;

    if (prev && state.aircraftData.has(prev) && state.markers.has(prev)) {
        state.markers.get(prev).setIcon(createAircraftIcon(state.aircraftData.get(prev), false));
    }

    const ac = state.aircraftData.get(icao);
    if (!ac) return;

    if (state.markers.has(icao)) {
        state.markers.get(icao).setIcon(createAircraftIcon(ac, true));
    }

    updateDetailPanel(ac);
    document.getElementById('flight-detail-panel').classList.remove('translate-y-[120%]', 'sm:translate-x-[120%]', 'opacity-0', 'pointer-events-none');
}

function closeDetailPanel() {
    document.getElementById('flight-detail-panel').classList.add('translate-y-[120%]', 'sm:translate-x-[120%]', 'opacity-0', 'pointer-events-none');
    const prev = state.selectedIcao;
    state.selectedIcao = null;
    state.followSelected = false;

    if (prev && state.aircraftData.has(prev) && state.markers.has(prev)) {
        state.markers.get(prev).setIcon(createAircraftIcon(state.aircraftData.get(prev), false));
    }
}

function updateDetailPanel(ac) {
    document.getElementById('detail-callsign').textContent = ac.callsign;
    document.getElementById('detail-country').textContent = ac.origin_country;

    const badge = document.getElementById('detail-status-badge');
    badge.textContent = ac.on_ground ? 'Am Boden' : 'In der Luft';

    if (ac.baro_altitude !== null && !ac.on_ground) {
        const altM = Math.round(ac.baro_altitude);
        const altFt = Math.round(ac.baro_altitude * 3.28084);
        document.getElementById('detail-alt-m').textContent = `${altM.toLocaleString('de-CH')} m`;
        document.getElementById('detail-alt-ft').textContent = `${altFt.toLocaleString('de-CH')} ft`;
    } else {
        document.getElementById('detail-alt-m').textContent = '0 m';
        document.getElementById('detail-alt-ft').textContent = 'Bodenlevel';
    }

    if (ac.velocity !== null) {
        const kmh = Math.round(ac.velocity * 3.6);
        const kts = Math.round(ac.velocity * 1.94384);
        document.getElementById('detail-speed-kmh').textContent = `${kmh.toLocaleString('de-CH')} km/h`;
        document.getElementById('detail-speed-kts').textContent = `${kts.toLocaleString('de-CH')} kts`;
    } else {
        document.getElementById('detail-speed-kmh').textContent = '— km/h';
        document.getElementById('detail-speed-kts').textContent = '— kts';
    }

    document.getElementById('detail-track').textContent = `${Math.round(ac.true_track || 0)}°`;

    const vrateEl = document.getElementById('detail-vrate');
    if (ac.vertical_rate !== null && ac.vertical_rate !== undefined) {
        vrateEl.textContent = `${ac.vertical_rate > 0 ? '+' : ''}${ac.vertical_rate.toFixed(1)} m/s`;
    } else {
        vrateEl.textContent = '—';
    }

    document.getElementById('detail-icao').textContent = ac.icao24;
    document.getElementById('detail-coords').textContent = `${ac.latitude.toFixed(3)}° N, ${ac.longitude.toFixed(3)}° E`;
}

// Simulation (Fallback)
function enableSimulationMode() {
    state.isSimulationMode = true;
    document.getElementById('error-banner').classList.add('hidden');
    document.getElementById('zoom-warning').classList.add('hidden');
    document.getElementById('mode-btn-text').textContent = 'Modus: Simulation';
    updateStatusIndicator('sim', 'Demo-Simulation aktiv');

    const airlines = ['SWR', 'DLH', 'AFR', 'BAW', 'AUA', 'EZY', 'KLM', 'UAE'];
    const countries = ['Switzerland', 'Germany', 'France', 'United Kingdom', 'Austria', 'Netherlands'];
    const center = state.map.getCenter();

    state.simAircraft = Array.from({ length: 50 }, (_, i) => {
        const prefix = airlines[i % airlines.length];
        const num = 100 + ((i * 37) % 899);
        const alt = i % 10 === 0 ? 450 : (2000 + ((i * 750) % 10000));
        return {
            icao24: (0x4b0000 + i).toString(16),
            callsign: `${prefix}${num}`,
            origin_country: countries[i % countries.length],
            latitude: center.lat + (Math.random() - 0.5) * 3.5,
            longitude: center.lng + (Math.random() - 0.5) * 5.0,
            baro_altitude: alt,
            velocity: 140 + (i % 6) * 25,
            true_track: Math.floor(Math.random() * 360),
            vertical_rate: Number(((Math.random() - 0.5) * 8).toFixed(1)),
            on_ground: false
        };
    });

    stepSimulation();
    clearInterval(state.simTimer);
    state.simTimer = setInterval(stepSimulation, 2000);
}

function disableSimulationMode() {
    state.isSimulationMode = false;
    clearInterval(state.simTimer);
    document.getElementById('mode-btn-text').textContent = 'Modus: Live-API';
    fetchFlightData();
}

function stepSimulation() {
    state.aircraftData.clear();
    state.simAircraft.forEach(ac => {
        const rad = (ac.true_track * Math.PI) / 180;
        const distDeg = (ac.velocity * 2) / 111320;
        ac.latitude += Math.cos(rad) * distDeg;
        ac.longitude += (Math.sin(rad) * distDeg) / Math.cos((ac.latitude * Math.PI) / 180);
        state.aircraftData.set(ac.icao24, { ...ac });
    });
    updateLastUpdateTime();
    renderAircraftOnMap();
}

function updateStatusIndicator(type, text) {
    const dot = document.getElementById('status-dot');
    const label = document.getElementById('status-text');
    label.textContent = text;
    dot.className = 'w-2 h-2 rounded-full pulse-dot ' + (type === 'live' ? 'bg-emerald-400' : type === 'sim' ? 'bg-sky-400' : 'bg-amber-400');
}

function updateLastUpdateTime() {
    document.getElementById('last-update-time').textContent = new Date().toLocaleTimeString('de-CH');
}

function startAutoRefresh() {
    clearInterval(state.refreshTimer);
    if (state.autoRefresh) {
        state.refreshTimer = setInterval(() => {
            if (!state.isSimulationMode) fetchFlightData();
        }, CONFIG.refreshIntervalMs);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initMap();
    fetchFlightData();
    startAutoRefresh();

    const searchInput = document.getElementById('search-input');
    const clearBtn = document.getElementById('clear-search');
    searchInput.addEventListener('input', (e) => {
        state.searchQuery = e.target.value;
        clearBtn.classList.toggle('hidden', !state.searchQuery);
        renderAircraftOnMap();
    });
    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        state.searchQuery = '';
        clearBtn.classList.add('hidden');
        renderAircraftOnMap();
    });

    document.getElementById('btn-manual-refresh').addEventListener('click', () => {
        state.isSimulationMode ? stepSimulation() : fetchFlightData();
    });

    document.getElementById('btn-auto-refresh').addEventListener('click', () => {
        state.autoRefresh = !state.autoRefresh;
        document.getElementById('auto-refresh-indicator').className = state.autoRefresh ? 'w-2 h-2 rounded-full bg-emerald-400' : 'w-2 h-2 rounded-full bg-slate-500';
        startAutoRefresh();
    });

    document.getElementById('btn-toggle-mode').addEventListener('click', () => {
        state.isSimulationMode ? disableSimulationMode() : enableSimulationMode();
    });

    document.getElementById('btn-enable-sim').addEventListener('click', enableSimulationMode);
    document.getElementById('btn-retry-live').addEventListener('click', () => {
        document.getElementById('error-banner').classList.add('hidden');
        fetchFlightData();
    });

    document.getElementById('btn-reset-zoom').addEventListener('click', () => {
        state.map.setView(CONFIG.initialCenter, CONFIG.initialZoom);
    });

    document.getElementById('btn-close-detail').addEventListener('click', closeDetailPanel);
    document.getElementById('btn-center-aircraft').addEventListener('click', () => {
        if (state.selectedIcao && state.aircraftData.has(state.selectedIcao)) {
            state.followSelected = true;
            const ac = state.aircraftData.get(state.selectedIcao);
            state.map.setView([ac.latitude, ac.longitude], Math.max(state.map.getZoom(), 9));
        }
    });
});