/**
 * Covered People NFT Network Visualizer
 * Phase 2.5: Transfer History Based Visualization
 */

// --- Constants & Config ---
const CONFIG = {
    colors: {
        bgDark: '#0a0a0f',
        genesis: 'rgba(255, 215, 0, 0.7)',     // Transparency added
        generative: 'rgba(0, 255, 127, 0.5)',  // Transparency added
        ring: 'rgba(255, 255, 255, 0.05)',
        edge: 'rgba(100, 200, 255, 0.1)',      // More transparent edges
        text: '#ffffff'
    },
    counts: {
        genesis: 198,
        generative: 3333,
        total: 3531
    },
    years: {
        start: 2022,
        end: 2032
    },
    radii: {
        start: 100,
        gap: 80,
        node: 3,         // Default radius
        genesis: 6,      // Larger radius for Genesis
        issuer: 6
    },
    contracts: {
        issuer: "0x91f5914A70C1F5d9fae0408aE16f1c19758337Eb".toLowerCase(),
        openseaEth: "0x495f947276749ce646f68ac8c248420045cb7b5e".toLowerCase(),
        openseaPoly: "0x2953399124f0cbb46d2cbacd8a89cf0599974963".toLowerCase(),
        generative: "0x0e6a70cb485ed3735fa2136e0d4adc4bf5456f93".toLowerCase()
    }
};

// --- State Management ---
const state = {
    canvas: null,
    ctx: null,
    width: 0,
    height: 0,
    transform: { x: 0, y: 0, scale: 1 }, // Pan & Zoom
    isDragging: false,
    lastMouse: { x: 0, y: 0 },
    nodes: [],
    edges: [],
    hoveredNode: null,
    selectedNode: null,
    visibility: {
        Genesis: true,
        Generative: true
    },
    // Progressive Loading State
    loading: {
        totalSteps: 200 + 500, // Adjusted estimate for 50 pages
        currentSteps: 0,
        completed: false,
        allDataLoaded: false,
        titleStartTime: Date.now() // Track when the title started showing
    }
};

class RateLimiter {
    constructor(maxPerSecond) {
        this.queue = [];
        this.maxPerSecond = maxPerSecond;
        this.currentSecond = Math.floor(Date.now() / 1000);
        this.countThisSecond = 0;
        this.processing = false;
    }

    add(fn) {
        this.queue.push(fn);
        this.process();
    }

    async process() {
        if (this.processing) return;
        this.processing = true;

        while (this.queue.length > 0) {
            const nowSecond = Math.floor(Date.now() / 1000);

            if (nowSecond > this.currentSecond) {
                this.currentSecond = nowSecond;
                this.countThisSecond = 0;
            }

            if (this.countThisSecond < this.maxPerSecond) {
                const fn = this.queue.shift();
                this.countThisSecond++;
                fn().catch(console.error); // Execute without awaiting to keep queue moving
            } else {
                // Wait for next second
                await new Promise(r => setTimeout(r, 1000 - (Date.now() % 1000) + 10));
            }
        }
        this.processing = false;
    }
}

const apiLimiter = new RateLimiter(2); // Reduced to ~10 CU/s for maximum safety with batch fetching

async function fetchWithRetry(url, options, retries = 3, backoff = 1000) {
    try {
        const response = await fetch(url, options);
        // Retry on 429 (Too Many Requests) or 401 (Unauthorized - sometimes transient) or 5xx server errors
        if (!response.ok && (response.status === 429 || response.status === 401 || response.status >= 500)) {
            if (retries > 0) {
                // console.warn(`Retrying ${url} due to ${response.status}. Retries left: ${retries}`);
                await new Promise(r => setTimeout(r, backoff));
                return fetchWithRetry(url, options, retries - 1, backoff * 2);
            }
        }
        return response;
    } catch (err) {
        if (retries > 0) {
            await new Promise(r => setTimeout(r, backoff));
            return fetchWithRetry(url, options, retries - 1, backoff * 2);
        }
        throw err;
    }
}

function updateProgress(step = 1, statusText) {
    state.loading.currentSteps += step;
    const progress = Math.min(100, (state.loading.currentSteps / state.loading.totalSteps) * 100);
    const bar = document.getElementById('progress-bar');
    const status = document.getElementById('loading-status');
    if (bar) bar.style.width = `${progress}%`;
    if (status && statusText) status.textContent = statusText;

    // Fade out loading screen logic moved to fetchRealData with fixed 10s timer
}

function startIconAnimation() {
    const overlay = document.getElementById('icon-overlay');
    const icon = document.getElementById('contracting-icon');
    if (!overlay || !icon) return;

    overlay.classList.remove('hidden');
    icon.classList.add('animate-contract');

    // Remove overlay after animation finishes (1.5s)
    setTimeout(() => {
        overlay.classList.add('fade-out');
        setTimeout(() => {
            overlay.classList.add('hidden');
        }, 1000);
    }, 1500);
}


// --- Data Generation (Server-Side Cache & Client-Side IndexedDB) ---

const CACHE_DB_NAME = 'NftNetworkCacheDB';
const CACHE_STORE_NAME = 'nftData';
const CACHE_META_KEY = 'nft_cache_meta';
const CACHE_MAX_AGE = 3600000; // 1 hour in milliseconds

// Helper to open IndexedDB
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(CACHE_DB_NAME, 1);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
                db.createObjectStore(CACHE_STORE_NAME, { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Save data to IndexedDB
async function saveToIndexedDB(nodes, lastUpdated) {
    try {
        const db = await openDB();
        const transaction = db.transaction(CACHE_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(CACHE_STORE_NAME);

        // Clear old data and save new
        store.clear();
        store.put({ id: 'cache', nodes: nodes });

        // Save metadata to localStorage for quick access
        localStorage.setItem(CACHE_META_KEY, JSON.stringify({
            lastUpdated: lastUpdated,
            savedAt: Date.now()
        }));
    } catch (e) {
        console.warn('Failed to save to IndexedDB:', e);
    }
}

// Load data from IndexedDB
async function loadFromIndexedDB() {
    try {
        const metaStr = localStorage.getItem(CACHE_META_KEY);
        if (!metaStr) return null;

        const meta = JSON.parse(metaStr);
        const age = Date.now() - meta.savedAt;

        // If cache is older than Max Age, consider it invalid
        if (age > CACHE_MAX_AGE) return null;

        const db = await openDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(CACHE_STORE_NAME, 'readonly');
            const store = transaction.objectStore(CACHE_STORE_NAME);
            const request = store.get('cache');
            request.onsuccess = () => resolve(request.result ? { nodes: request.result.nodes, meta } : null);
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.warn('Failed to load from IndexedDB:', e);
        return null;
    }
}

async function fetchRealData() {
    try {
        // Initialize Issuer Node immediately
        const issuerNode = {
            id: 'issuer',
            type: 'issuer',
            x: 0, y: 0,
            color: '#ffffff',
            radius: CONFIG.radii.issuer,
            year: 2022,
            nftType: 'Issuer',
            transfers: 'N/A',
            opacity: 0,
            appearanceTime: Date.now()
        };
        state.nodes.push(issuerNode);

        let nodes = [];
        let timeLabel = '';

        // 1. Try to load from Local Cache (IndexedDB)
        console.log("Checking local IndexedDB cache...");
        updateProgress(5, "Checking local cache...");
        const cachedData = await loadFromIndexedDB();

        if (cachedData && cachedData.nodes && cachedData.nodes.length > 0) {
            console.log("Using cached data from IndexedDB.");
            nodes = cachedData.nodes;
            timeLabel = "Using Local Cache";
            updateProgress(20, "Rendering from Local Cache...");
        } else {
            // 2. Fetch from Server API if no valid local cache
            console.log("Fetching fresh data from server API...");
            updateProgress(10, "Loading Data from Server...");

            const response = await fetch('/api/nfts');
            if (!response.ok) {
                const errorText = await response.text();
                console.error("API Error Details:", errorText);
                throw new Error(`Server error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            nodes = data.nodes || [];

            if (nodes.length > 0) {
                // Save fetched data to Local Cache
                await saveToIndexedDB(nodes, data.last_updated);
            }
        }

        if (nodes.length === 0) {
            console.warn("Server and Local cache are empty.");
            updateProgress(100, "No data available. Please wait for cache update.");
        } else {
            // Process all nodes in chunks to avoid UI freeze
            let count = 0;
            const total = nodes.length;

            const processChunk = () => {
                const chunkSize = 100;
                const end = Math.min(count + chunkSize, total);

                for (let i = count; i < end; i++) {
                    const item = nodes[i];
                    const typeLabel = item._custom_type || 'Generative'; // Default to Generative if missing
                    const color = typeLabel === 'Genesis' ? CONFIG.colors.genesis : CONFIG.colors.generative;

                    // Add to visualization
                    addNodeIncrementally(item, color, typeLabel);
                }

                count = end;
                updateProgress(10 + (count / total) * 90, `Processing ${count}/${total} events... ${timeLabel}`);

                if (count < total) {
                    requestAnimationFrame(processChunk);
                } else {
                    finishLoading();
                }
            };

            requestAnimationFrame(processChunk);
        }

    } catch (e) {
        console.error("Fatal Fetch Error:", e);
        // Fall back to mock for demo purposes if it completely fails
        generateMockData();
        finishLoading();
    }
}

function finishLoading() {
    state.loading.completed = true;
    state.loading.allDataLoaded = true;
    updateStats();

    // Handle title duration (10 seconds minimum)
    const minDuration = 10000;
    const elapsed = Date.now() - state.loading.titleStartTime;
    const remaining = Math.max(0, minDuration - elapsed);

    setTimeout(() => {
        const screen = document.getElementById('loading-screen');
        if (screen) {
            screen.classList.add('fade-out');
            startIconAnimation();
        }
    }, remaining);
}

function updateStats() {
    // Count unique token_ids (excluding 'issuer')
    const uniqueTokens = new Set(
        state.nodes
            .filter(n => n.id !== 'issuer')
            .map(n => n.token_id)
    );

    // Count total transfer events (nodes - 1 for issuer)
    const totalEvents = Math.max(0, state.nodes.length - 1);

    const elTotalNFTs = document.getElementById('stat-total-nfts');
    const elTotalTransfers = document.getElementById('stat-total-transfers');

    if (elTotalNFTs) elTotalNFTs.textContent = uniqueTokens.size.toLocaleString();
    if (elTotalTransfers) elTotalTransfers.textContent = totalEvents.toLocaleString();
}

// Global lookup to manage path sorting per token incrementally
const tokenHistories = {};

function addNodeIncrementally(tx, typeColor, typeLabel) {
    const tokenId = tx.token_id;
    if (!tokenHistories[tokenId]) tokenHistories[tokenId] = [];
    tokenHistories[tokenId].push(tx);

    // Sort history by time
    tokenHistories[tokenId].sort((a, b) => new Date(a.block_timestamp) - new Date(b.block_timestamp));

    // Re-generate nodes and edges for THIS TOKEN ONLY
    state.nodes = state.nodes.filter(n => n.token_id !== tokenId || n.type === 'issuer');
    state.edges = state.edges.filter(e =>
        (e.source.token_id !== tokenId && e.target.token_id !== tokenId) ||
        (e.source.id === 'issuer' && e.target.token_id !== tokenId)
    );

    let previousNode = null;
    let idHash = 0;
    const idStr = tokenId.toString();
    for (let i = 0; i < idStr.length; i++) {
        idHash = ((idHash << 5) - idHash) + idStr.charCodeAt(i);
        idHash |= 0;
    }
    const baseAngle = Math.abs(idHash % 360) * (Math.PI / 180);

    const getYear = (ts) => ts ? parseInt(ts.substring(0, 4)) : 2022;
    const getRadius = (timestamp) => {
        const date = new Date(timestamp);
        const year = date.getFullYear();
        const startOfYear = new Date(year, 0, 1).getTime();
        const endOfYear = new Date(year + 1, 0, 1).getTime();
        const fraction = (date.getTime() - startOfYear) / (endOfYear - startOfYear);
        const yearIndex = Math.max(0, year - 2022);
        return CONFIG.radii.start + ((yearIndex + fraction) * CONFIG.radii.gap);
    };

    tokenHistories[tokenId].forEach((event, idx) => {
        const year = getYear(event.block_timestamp);
        const angleJitter = (Math.random() - 0.5) * 0.1;
        const finalAngle = baseAngle + angleJitter;
        const r = getRadius(event.block_timestamp);
        const nodeRadius = typeLabel === 'Genesis' ? CONFIG.radii.genesis : CONFIG.radii.node;

        const node = {
            id: `${typeLabel}-${tokenId}-${event.transaction_hash}-${idx}`,
            token_id: tokenId,
            x: Math.cos(finalAngle) * r,
            y: Math.sin(finalAngle) * r,
            color: typeColor,
            radius: nodeRadius,
            year: year,
            nftType: typeLabel,
            timestamp: event.block_timestamp,
            tx_hash: event.transaction_hash,
            from: event.from_address,
            to: event.to_address,
            image: event.custom_image,
            name: event.custom_name,
            opacity: 0,
            appearanceTime: Date.now()
        };

        state.nodes.push(node);

        if (previousNode) {
            state.edges.push({ source: previousNode, target: node, type: 'path' });
        } else if (idx === 0) {
            const issuer = state.nodes.find(n => n.id === 'issuer');
            state.edges.push({ source: issuer, target: node, type: 'mint' });
        }
        previousNode = node;
    });

    updateStats();
}


// Keep mock for fallback
function generateMockData() {
    const nodes = [];

    nodes.push({
        id: 'issuer',
        type: 'issuer',
        x: 0,
        y: 0,
        color: '#ffffff',
        radius: CONFIG.radii.issuer,
        year: 2022,
        nftType: 'Issuer',
        transfers: 'N/A'
    });

    const totalMock = 500;
    for (let i = 0; i < totalMock; i++) {
        const year = 2022 + Math.floor(Math.random() * 4);
        const yearIndex = year - 2022;
        const r = CONFIG.radii.start + (yearIndex * CONFIG.radii.gap) + (Math.random() - 0.5) * 40;
        const angle = Math.random() * Math.PI * 2;

        nodes.push({
            id: `MOCK-${i}`,
            type: 'holder',
            x: Math.cos(angle) * r,
            y: Math.sin(angle) * r,
            color: Math.random() > 0.1 ? CONFIG.colors.generative : CONFIG.colors.genesis,
            radius: CONFIG.radii.node,
            year: year,
            nftType: 'Mock Transfer'
        });
    }

    state.nodes = nodes;
    state.edges = [];
}


// --- Visualization Engine ---

function initCanvas() {
    state.canvas = document.getElementById('networkCanvas');
    state.ctx = state.canvas.getContext('2d');

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    state.transform.x = state.width / 2;
    state.transform.y = state.height / 2;
    state.transform.scale = 0.8;

    setupInteraction();
    requestAnimationFrame(render);
}

function resizeCanvas() {
    state.width = window.innerWidth;
    state.height = window.innerHeight;
    state.canvas.width = state.width;
    state.canvas.height = state.height;
}

function render() {
    const ctx = state.ctx;
    ctx.fillStyle = CONFIG.colors.bgDark;
    ctx.fillRect(0, 0, state.width, state.height);

    ctx.save();
    ctx.translate(state.transform.x, state.transform.y);
    ctx.scale(state.transform.scale, state.transform.scale);

    drawRings(ctx);

    ctx.lineWidth = 0.5;
    // Modified Edge Rendering for Paths
    for (const edge of state.edges) {
        // Check visibility of both source and target nodes based on their type
        // Note: node.nftType is 'Genesis' or 'Generative'
        if (!state.visibility[edge.source.nftType] || !state.visibility[edge.target.nftType]) {
            continue;
        }

        ctx.strokeStyle = edge.type === 'path' ? 'rgba(255, 255, 255, 0.4)' : CONFIG.colors.edge;
        ctx.beginPath();
        ctx.moveTo(edge.source.x, edge.source.y);

        if (edge.type === 'path') {
            ctx.lineTo(edge.target.x, edge.target.y); // Straight line for sequence
        } else {
            ctx.bezierCurveTo(
                edge.source.x * 0.5, edge.source.y * 0.5,
                edge.target.x * 0.5, edge.target.y * 0.5,
                edge.target.x, edge.target.y
            );
        }
        ctx.stroke();
    }

    for (const node of state.nodes) {
        // Check visibility
        if (node.id !== 'issuer' && !state.visibility[node.nftType]) {
            continue;
        }

        const isHovered = state.hoveredNode === node;
        const isSelected = state.selectedNode === node;

        // Entrance Animation
        const now = Date.now();
        const elapsed = now - (node.appearanceTime || now);
        const opacity = Math.min(1, elapsed / 500);

        // Scale
        const animScale = 0.5 + (0.5 * opacity);
        let effectiveRadius = (node.radius / state.transform.scale) * (isHovered ? 1.5 : 1) * animScale;

        ctx.globalAlpha = opacity;

        // Special rendering for Issuer Node (Center Icon)
        if (node.id === 'issuer') {
            // Lazy load issuer image if not loaded
            if (!node.imgElement) {
                const img = new Image();
                img.src = 'resources/images/coverd-icon.png';
                node.imgElement = img; // attach to node to cache
            }

            if (node.imgElement.complete && node.imgElement.naturalWidth !== 0) {
                // Draw Image centered
                const size = effectiveRadius * 4; // Make it bigger than a dot
                ctx.save();
                ctx.beginPath();
                ctx.arc(node.x, node.y, size / 2, 0, Math.PI * 2);
                ctx.clip(); // Clip to circle
                ctx.drawImage(node.imgElement, node.x - size / 2, node.y - size / 2, size, size);
                ctx.restore();
            } else {
                // Fallback to white dot while loading
                ctx.beginPath();
                ctx.arc(node.x, node.y, effectiveRadius, 0, Math.PI * 2);
                ctx.fillStyle = node.color;
                ctx.fill();
            }
        } else {
            // Standard Node Rendering
            ctx.beginPath();
            ctx.arc(node.x, node.y, effectiveRadius, 0, Math.PI * 2);
            ctx.fillStyle = (isHovered || isSelected) ? '#ffffff' : node.color;

            if (isSelected || isHovered) {
                ctx.shadowBlur = 15;
                ctx.shadowColor = node.color;
            } else {
                ctx.shadowBlur = 0;
            }

            ctx.fill();
            ctx.shadowBlur = 0;
        }

        ctx.globalAlpha = 1.0; // Reset

        if (isSelected) {
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#fff';
            ctx.stroke();
        }
    }


    ctx.restore();
    requestAnimationFrame(render);
}

function drawRings(ctx) {
    ctx.strokeStyle = CONFIG.colors.ring;
    ctx.lineWidth = 1;

    for (let year = CONFIG.years.start; year <= CONFIG.years.end; year++) {
        const yearIndex = year - CONFIG.years.start;
        const radius = CONFIG.radii.start + (yearIndex * CONFIG.radii.gap);

        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '12px Inter';
        ctx.fillText(year.toString(), 0, -radius + 15);
    }
}

// --- Interaction ---

function setupInteraction() {
    const canvas = state.canvas;

    canvas.addEventListener('mousedown', e => {
        state.isDragging = true;
        state.lastMouse = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mouseup', () => {
        state.isDragging = false;
    });

    canvas.addEventListener('mousemove', e => {
        if (state.isDragging) {
            const dx = e.clientX - state.lastMouse.x;
            const dy = e.clientY - state.lastMouse.y;
            state.transform.x += dx;
            state.transform.y += dy;
            state.lastMouse = { x: e.clientX, y: e.clientY };
        }

        const rect = canvas.getBoundingClientRect();
        const mx = (e.clientX - rect.left - state.transform.x) / state.transform.scale;
        const my = (e.clientY - rect.top - state.transform.y) / state.transform.scale;

        let found = null;
        for (let i = state.nodes.length - 1; i >= 0; i--) {
            const node = state.nodes[i];

            // Check visibility - Ignore hidden nodes for interaction
            if (node.id !== 'issuer' && !state.visibility[node.nftType]) {
                continue;
            }

            const dist = Math.hypot(node.x - mx, node.y - my);

            // Hit test radius should also respect the "Fixed Visual Size" logic?
            // VISUAL radius on screen = node.radius.
            // LOGICAL radius in world space = node.radius / scale.
            // Wait, "dist" is in WORLD space (mx, my are world coords).
            // So we check against logical radius: node.radius / state.transform.scale.
            // Effectively, we want to know if the mouse is within N pixels of the node center ON SCREEN.

            // Calculate screen distance
            const rect = canvas.getBoundingClientRect();
            const screenX = (node.x * state.transform.scale) + state.transform.x;
            const screenY = (node.y * state.transform.scale) + state.transform.y;
            const screenMx = e.clientX - rect.left;
            const screenMy = e.clientY - rect.top;
            const screenDist = Math.hypot(screenX - screenMx, screenY - screenMy);

            // Check against base radius (visual size) + margin
            if (screenDist < node.radius + 3) {
                found = node;
                break;
            }
        }

        state.hoveredNode = found;
        canvas.style.cursor = found ? 'pointer' : (state.isDragging ? 'grabbing' : 'grab');
    });

    canvas.addEventListener('wheel', e => {
        e.preventDefault();
        const zoomIntensity = 0.1;
        const delta = e.deltaY < 0 ? 1 + zoomIntensity : 1 - zoomIntensity;

        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const worldX = (mouseX - state.transform.x) / state.transform.scale;
        const worldY = (mouseY - state.transform.y) / state.transform.scale;

        state.transform.scale *= delta;
        state.transform.scale = Math.max(0.1, Math.min(5, state.transform.scale));

        state.transform.x = mouseX - worldX * state.transform.scale;
        state.transform.y = mouseY - worldY * state.transform.scale;
    }, { passive: false });

    canvas.addEventListener('click', e => {
        if (!state.isDragging && state.hoveredNode) {
            selectNode(state.hoveredNode);
        } else if (!state.isDragging && !state.hoveredNode) {
            state.selectedNode = null;
            document.getElementById('detail-panel').classList.add('hidden');
        }
    });

    document.getElementById('btn-zoom-in').onclick = () => applyZoom(1.2);
    document.getElementById('btn-zoom-out').onclick = () => applyZoom(0.8);
    document.getElementById('btn-reset').onclick = resetView;
    document.getElementById('btn-close-detail').onclick = () => {
        state.selectedNode = null;
        document.getElementById('detail-panel').classList.add('hidden');
    };

    // Toggle Filters
    const cbGenesis = document.getElementById('cb-genesis');
    const cbGenerative = document.getElementById('cb-generative');

    cbGenesis.onchange = (e) => {
        state.visibility.Genesis = e.target.checked;
        // Don't need explicit re-render call because requestAnimationFrame loop handles it
    };

    cbGenerative.onchange = (e) => {
        state.visibility.Generative = e.target.checked;
    };

    // Mobile Header Toggle
    const btnMobileToggle = document.getElementById('btn-mobile-toggle');
    const sidebar = document.getElementById('sidebar');

    if (btnMobileToggle && sidebar) {
        btnMobileToggle.onclick = () => {
            const isOpen = sidebar.classList.contains('sidebar-open');
            if (isOpen) {
                sidebar.classList.remove('sidebar-open');
                btnMobileToggle.innerText = '▼';
                // Remove rotated class if desired or just swap text
            } else {
                sidebar.classList.add('sidebar-open');
                btnMobileToggle.innerText = '▲';
            }
        };
    }

    // --- Touch Support (Pinch Zoom & Pan) ---
    let initialPinchDistance = null;
    let lastTouchX = 0;
    let lastTouchY = 0;

    canvas.addEventListener('touchstart', e => {
        if (e.touches.length === 1) {
            // Single touch - Pan
            state.isDragging = true;
            lastTouchX = e.touches[0].clientX;
            lastTouchY = e.touches[0].clientY;
        } else if (e.touches.length === 2) {
            // Two finger touch - Pinch Zoom
            state.isDragging = false; // Disable drag during zoom
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            initialPinchDistance = Math.hypot(dx, dy);
        }
    }, { passive: false });

    canvas.addEventListener('touchmove', e => {
        e.preventDefault(); // Prevent scrolling

        if (e.touches.length === 1 && state.isDragging) {
            // Pan
            const dx = e.touches[0].clientX - lastTouchX;
            const dy = e.touches[0].clientY - lastTouchY;
            state.transform.x += dx;
            state.transform.y += dy;
            lastTouchX = e.touches[0].clientX;
            lastTouchY = e.touches[0].clientY;

        } else if (e.touches.length === 2 && initialPinchDistance) {
            // Pinch Zoom
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const currentDistance = Math.hypot(dx, dy);

            if (currentDistance > 0 && initialPinchDistance > 0) {
                const zoomFactor = currentDistance / initialPinchDistance;

                // Center point between fingers
                const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

                // Zoom towards center
                // 1. Translate to origin relative to center
                // 2. Scale
                // 3. Translate back
                // Simplified: adjust scale and compensate position

                // For simplicity in standard loop, we just apply scale relative to center of screen 
                // or just modify scale directly. 
                // A better approach for pinch is similar to wheel:

                const newScale = state.transform.scale * zoomFactor;

                // Limit zoom speed/jump
                const limitedScale = Math.max(0.1, Math.min(5, newScale));

                // Reset distance for next move event (incremental zoom)
                // Actually for smooth pinch, we usually compare to initial, but resetting allows constant factor updates
                // Let's stick to incremental to match the wheel logic structure
                // But touchmove fires rapidly, so we need small deltas.
                // easier: update scale, reset initial distance.

                state.transform.scale = limitedScale;
                initialPinchDistance = currentDistance;
            }
        }
    }, { passive: false });

    canvas.addEventListener('touchend', e => {
        state.isDragging = false;
        if (e.touches.length < 2) {
            initialPinchDistance = null;
        }
    });

    // Handle Tap on Nodes (Simulate Click)
    // We can reuse the click handler if we ensure touch doesn't trigger ghost clicks or 
    // explicitly handle it. The 'click' event often fires after tap on mobile.
    // However, if we preventDefault in touchmove, it might cancel click.
    // Let's check if we moved.

    // Actually, since we preventDefault on touchmove, 'click' might not fire.
    // We should implement a simple tap detector.
    let touchStartTime = 0;
    canvas.addEventListener('touchstart', () => { touchStartTime = Date.now(); });
    canvas.addEventListener('touchend', e => {
        const duration = Date.now() - touchStartTime;
        if (duration < 300 && !initialPinchDistance && !state.isDragging) {
            // It was a tap. Manually trigger selection logic.
            // But we need coordinates. ChangedTouches helps.
            const touch = e.changedTouches[0];
            const rect = canvas.getBoundingClientRect();

            // Re-run hit test logic from mousemove
            const mx = (touch.clientX - rect.left - state.transform.x) / state.transform.scale;
            const my = (touch.clientY - rect.top - state.transform.y) / state.transform.scale;

            let found = null;
            // Iterate nodes... (copy logic or refactor hit test)
            // Refactoring hit test would be cleaner but let's just copy loop for safety in this edit
            for (let i = state.nodes.length - 1; i >= 0; i--) {
                const node = state.nodes[i];
                if (node.id !== 'issuer' && !state.visibility[node.nftType]) continue;

                // Simple distance check in world space
                const dist = Math.hypot(node.x - mx, node.y - my);
                // Visual radius check
                // We need screen coords match
                const screenX = (node.x * state.transform.scale) + state.transform.x;
                const screenY = (node.y * state.transform.scale) + state.transform.y;
                const screenDist = Math.hypot(screenX - (touch.clientX - rect.left), screenY - (touch.clientY - rect.top));

                if (screenDist < node.radius + 10) { // Larger hit area for touch
                    found = node;
                    break;
                }
            }

            if (found) {
                selectNode(found);
            } else {
                state.selectedNode = null;
                document.getElementById('detail-panel').classList.add('hidden');
            }
        }
    });
}

function selectNode(node) {
    state.selectedNode = node;

    const panel = document.getElementById('detail-panel');
    const idEl = document.getElementById('detail-id');
    const imgEl = document.getElementById('detail-image');
    const imgPlaceholder = document.getElementById('detail-image-placeholder');
    const tokenIdEl = document.getElementById('detail-token-id');
    const typeEl = document.getElementById('detail-type');
    const yearEl = document.getElementById('detail-year');
    const dateEl = document.getElementById('detail-date');
    const fromEl = document.getElementById('detail-from');
    const toEl = document.getElementById('detail-to');
    const scanEl = document.getElementById('detail-etherscan');

    // Reset Image State
    imgEl.src = '';
    imgEl.classList.add('hidden');
    imgPlaceholder.classList.remove('hidden');
    imgPlaceholder.textContent = 'Loading Image...';

    if (node.id === 'issuer') {
        idEl.textContent = 'Issuer Node';
        imgPlaceholder.textContent = 'Issuer';
        tokenIdEl.textContent = 'N/A';
        dateEl.textContent = 'N/A';
        fromEl.textContent = 'N/A';
        toEl.textContent = 'N/A';
        scanEl.classList.add('hidden');
    } else {
        idEl.textContent = `Event #${node.id.split('-').pop()}`;

        if (node.image) {
            // Use pre-loaded image from JSON
            imgEl.src = node.image;
            imgEl.classList.remove('hidden');
            imgPlaceholder.classList.add('hidden');
        } else {
            // Fetch Image independently (Lazy Load)
            fetchNftImage(node).then(imageUrl => {
                if (state.selectedNode === node && imageUrl) {
                    imgEl.src = imageUrl;
                    imgEl.onload = () => {
                        imgEl.classList.remove('hidden');
                        imgPlaceholder.classList.add('hidden');
                    };
                } else if (state.selectedNode === node) {
                    imgPlaceholder.textContent = 'No Image';
                }
            });
        }

        tokenIdEl.textContent = node.token_id || '?';

        // Use custom name if available, otherwise just event ID
        if (node.name) {
            idEl.textContent = node.name;
        }
        dateEl.textContent = node.timestamp ? node.timestamp.split('T')[0] : 'Unknown';
        fromEl.textContent = node.from ? `${node.from.substring(0, 6)}...${node.from.substring(38)}` : '-';
        toEl.textContent = node.to ? `${node.to.substring(0, 6)}...${node.to.substring(38)}` : '-';

        if (node.tx_hash) {
            scanEl.href = `https://etherscan.io/tx/${node.tx_hash}`;
            scanEl.classList.remove('hidden');
        } else {
            scanEl.classList.add('hidden');
        }
    }

    typeEl.textContent = node.nftType;
    yearEl.textContent = node.year;

    panel.classList.remove('hidden');
}

// Helper: Resolve IPFS to Gateway
// Using Cloudflare IPFS gateway for better performance and reliability than public ipfs.io
function resolveIpfs(url) {
    if (!url) return null;
    if (url.startsWith('ipfs://')) {
        return url.replace('ipfs://', 'https://cloudflare-ipfs.com/ipfs/');
    }
    return url;
}

// Async Fetch Image
async function fetchNftImage(node) {
    try {
        // Determine contract
        let chain = 'eth';
        let contract = CONFIG.contracts.openseaEth;

        if (node.nftType === 'Generative') {
            contract = CONFIG.contracts.generative;
        } else if (node.nftType === 'Genesis') {
            // Try Eth first
        }

        // Helper to try fetching metadata
        const tryFetch = async (c, addr) => {
            try {
                const body = {
                    endpoint: `/nft/${addr}/${node.token_id}`,
                    params: { chain: c, format: 'decimal' }
                };
                const res = await fetch('/api/proxy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const data = await res.json();

                // Moralis often returns a 'normalized_metadata' object or 'metadata' string.
                // We prioritize 'normalized_metadata.image' if available as it is often pre-processed.
                if (data.normalized_metadata && data.normalized_metadata.image) {
                    return resolveIpfs(data.normalized_metadata.image);
                }

                if (data && data.metadata) {
                    const meta = JSON.parse(data.metadata);
                    return resolveIpfs(meta.image || meta.image_url || meta.animation_url);
                }
                return null;
            } catch (e) { return null; }
        };

        let url = await tryFetch('eth', contract);

        // If failed and it's Genesis, try Polygon
        if (!url && node.nftType === 'Genesis') {
            url = await tryFetch('polygon', CONFIG.contracts.openseaPoly);
        }

        return url;
    } catch (e) {
        console.error("Image Fetch Error:", e);
        return null;
    }
}

function applyZoom(factor) {
    state.transform.scale *= factor;
    const cx = state.width / 2;
    const cy = state.height / 2;
    state.transform.x = cx + (state.transform.x - cx) * factor;
    state.transform.y = cy + (state.transform.y - cy) * factor;
}

function resetView() {
    state.transform.x = state.width / 2;
    state.transform.y = state.height / 2;
    state.transform.scale = 0.8;
}

// --- Init ---
fetchRealData();
initCanvas();
