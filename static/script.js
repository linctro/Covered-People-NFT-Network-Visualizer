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


// --- Data Generation ---

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

        // Run fetchers in parallel but they will update state incrementally
        fetchGenesisHistory();
        fetchGenerativeHistory();

        // Handle title duration (10 seconds)
        const minDuration = 10000; // 10 seconds
        const elapsed = Date.now() - state.loading.titleStartTime;
        const remaining = Math.max(0, minDuration - elapsed);

        setTimeout(() => {
            const screen = document.getElementById('loading-screen');
            if (screen) {
                screen.classList.add('fade-out');
                state.loading.completed = true;

                // Trigger icon animation immediately after loading screen fades
                startIconAnimation();
            }
        }, remaining);

    } catch (e) {
        console.error("Fatal Fetch Error:", e);
        generateMockData();
    }
}

// Global lookup to manage path sorting per token incrementally
const tokenHistories = {};

function addNodeIncrementally(tx, typeColor, typeLabel) {
    const tokenId = tx.token_id;
    if (!tokenHistories[tokenId]) tokenHistories[tokenId] = [];
    tokenHistories[tokenId].push(tx);

    // Sort history by time every time a new event for this token arrives
    tokenHistories[tokenId].sort((a, b) => new Date(a.block_timestamp) - new Date(b.block_timestamp));

    // Re-generate nodes and edges for THIS TOKEN ONLY to keep it simple and efficient
    // 1. Remove old nodes/edges for this token
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
            // Animation state
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

    // Update Stats
    updateStats();
}

function updateStats() {
    const totalEvents = state.nodes.length - 1;
    const totalEl = document.getElementById('stat-total-transfers');
    if (totalEl) totalEl.textContent = totalEvents.toLocaleString();

    // Unique NFT count calculation removed per user request

    const statusText = state.loading.allDataLoaded ? " (Complete)" :
        state.loading.fetchingMissing ? ` (Filling Gap: ${state.loading.missingLoaded}/${state.loading.missingTotal})` :
            " (Loading History...)";
    document.getElementById('stat-total-nfts').textContent = CONFIG.counts.total.toLocaleString() + statusText;
}

// 1. Fetch Genesis Data (Incremental)
async function fetchGenesisHistory() {
    try {
        const response = await fetch('data/genesis_nfts.json');
        if (!response.ok) throw new Error("Failed to load local JSON");
        const targetList = await response.json();

        const failedGenesisItems = [];
        let processedCount = 0;
        state.loading.failedGenesisItems = []; // Initialize for global state tracking

        for (let i = 0; i < targetList.length; i++) {
            const target = targetList[i];
            const isPoly = target.token_address.toLowerCase().startsWith('0x2953');
            const reqChain = isPoly ? 'polygon' : 'eth';

            updateProgress(1, `Processing Genesis: ${target.name || target.token_id}`);

            apiLimiter.add(async () => {
                let success = false;
                try {
                    // 1. Try Transfers
                    const body = {
                        endpoint: `/nft/${target.token_address}/${target.token_id}/transfers`,
                        params: { chain: reqChain, format: 'decimal', limit: '100' }
                    };

                    const apiRes = await fetchWithRetry('/api/proxy', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });

                    if (apiRes.ok) {
                        const data = await apiRes.json();
                        if (data.result && data.result.length > 0) {
                            data.result.forEach(tx => {
                                const enriched = {
                                    ...tx,
                                    custom_image: target.image_url,
                                    custom_name: target.name,
                                    is_genesis_target: true
                                };
                                addNodeIncrementally(enriched, CONFIG.colors.genesis, 'Genesis');
                            });
                            success = true;
                        }
                    }

                    // 2. Fallback: Try Owners
                    if (!success) {
                        const ownerBody = {
                            endpoint: `/nft/${target.token_address}/${target.token_id}/owners`,
                            params: { chain: reqChain, format: 'decimal' }
                        };
                        const ownerRes = await fetchWithRetry('/api/proxy', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(ownerBody)
                        });

                        if (ownerRes.ok) {
                            const ownerData = await ownerRes.json();
                            if (ownerData.result && ownerData.result.length > 0) {
                                const ownerInfo = ownerData.result[0];
                                const pseudoTx = {
                                    token_id: target.token_id,
                                    transaction_hash: `genesis-fallback-${target.token_id}`,
                                    block_timestamp: new Date('2022-01-01').toISOString(),
                                    from_address: '0x0000000000000000000000000000000000000000',
                                    to_address: ownerInfo.owner_of,
                                    value: '0',
                                    custom_image: target.image_url,
                                    custom_name: target.name,
                                    is_genesis_target: true
                                };
                                addNodeIncrementally(pseudoTx, CONFIG.colors.genesis, 'Genesis');
                                success = true;
                                console.log(`[Genesis] Recovered ${target.name} using Owner data.`);
                            }
                        }
                    }

                    if (!success) {
                        console.warn(`[Genesis] Failed to fetch data for ${target.name || target.token_id}`);
                        failedGenesisItems.push(target);
                        state.loading.failedGenesisItems.push(target); // Update global state
                    }

                } catch (err) {
                    console.error(`Error for ${target.name}:`, err);
                    failedGenesisItems.push(target);
                    state.loading.failedGenesisItems.push(target); // Update global state
                } finally {
                    processedCount++;
                    // If this is the last item, print the summary
                    if (processedCount === targetList.length) {
                        if (failedGenesisItems.length > 0) {
                            console.error("=== FAILED GENESIS LIST ===");
                            console.table(failedGenesisItems.map(item => ({
                                name: item.name,
                                id: item.token_id,
                                address: item.token_address
                            })));
                            console.error(`Total Failed Genesis: ${failedGenesisItems.length}`);
                        } else {
                            console.log("[Genesis] All items successfully loaded.");
                        }
                    }
                }
            });
        }
    } catch (e) {
        console.error("Genesis Fetch Error:", e);
    }
}

// 2. Fetch Generative Data (Incremental)
async function fetchGenerativeHistory() {
    let cursor = null;
    let page = 1;

    do {
        const body = {
            endpoint: `/nft/${CONFIG.contracts.generative}/transfers`,
            params: { chain: 'eth', format: 'decimal', limit: '100' }
        };
        if (cursor) body.params.cursor = cursor;

        try {
            updateProgress(10, `Loading Generative History (Page ${page})...`);
            const response = await fetch('/api/proxy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await response.json();
            if (data.result) {
                data.result.forEach(tx => {
                    addNodeIncrementally(tx, CONFIG.colors.generative, 'Generative');
                });
            }
            cursor = data.cursor;
            page++;
            await new Promise(r => setTimeout(r, 200));
        } catch (e) {
            break;
        }
    } while (cursor && page <= 50); // Limit to 50 pages of history

    // Discovery Phase: Fetch ALL tokens in contract
    fetchGenerativeDiscovery();
}

// 3. New Discovery Phase: Fetch ALL NFTs in the contract
async function fetchGenerativeDiscovery() {
    state.loading.fetchingMissing = true;
    updateStats();

    console.log("[Discovery] Starting full contract scan...");

    let cursor = null;
    let page = 1;
    let totalFound = 0;

    // Existing IDs from History Phase
    const existingIds = new Set();
    state.nodes.forEach(n => {
        if (n.nftType === 'Generative' && n.token_id) {
            existingIds.add(n.token_id);
        }
    });

    do {
        const body = {
            endpoint: `/nft/${CONFIG.contracts.generative}`,
            params: { chain: 'eth', format: 'decimal', limit: '100' }
        };
        if (cursor) body.params.cursor = cursor;

        apiLimiter.add(async () => {
            try {
                updateProgress(0, `Scanning Contract (Page ${page})...`);
                const response = await fetchWithRetry('/api/proxy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });

                if (response.ok) {
                    const data = await response.json();
                    if (data.result) {
                        data.result.forEach(nft => {
                            totalFound++;
                            // Only add if not already captured by history
                            if (!existingIds.has(nft.token_id)) {
                                // Create pseudo-transaction for visualization
                                const pseudoTx = {
                                    token_id: nft.token_id,
                                    transaction_hash: `discovery-${nft.token_id}`,
                                    block_timestamp: new Date('2022-11-22').toISOString(), // Fixed date: 2022-11-22
                                    from_address: '0x0000000000000000000000000000000000000000',
                                    to_address: nft.owner_of,
                                    value: '0',
                                    custom_name: nft.name || `CloneX #${nft.token_id}`,
                                    custom_image: nft.metadata ? JSON.parse(nft.metadata).image : null
                                };
                                addNodeIncrementally(pseudoTx, CONFIG.colors.generative, 'Generative');
                                existingIds.add(nft.token_id); // Mark as added
                            }
                        });
                    }
                    cursor = data.cursor; // Update cursor for outer loop? 
                    // Note: Ideally cursor logic should be handled linearly or recursively inside the limiter task 
                    // provided we don't spawn all page requests at once. 
                    // BUT since we use a RateLimiter queue, we need to handle the cursor carefully.
                    // The standard loop `do...while` here runs synchronously and submits jobs.
                    // However, we rely on the `cursor` from the PREVIOUS fetch to form the NEXT request body.
                    // Thus, we CANNOT use a simple `do..while` loop to queue jobs because we don't know the next cursor yet!
                    // WE MUST RECURSE.
                }
            } catch (e) {
                console.error("Discovery Error:", e);
            }
        });

        // Wait for the specific job to complete? No, RateLimiter.add is fire-and-forget logic usually.
        // We need a linear fetcher for pagination.

        // Let's break the loop and use a recursive function instead
        break;

    } while (false);

    // Actual Recursive Fetcher
    const fetchPage = async (currentCursor) => {
        const body = {
            endpoint: `/nft/${CONFIG.contracts.generative}`,
            params: { chain: 'eth', format: 'decimal', limit: '100' }
        };
        if (currentCursor) body.params.cursor = currentCursor;

        try {
            updateProgress(0, `Scanning (Page ${page}). Total Found: ${totalFound}`);

            const response = await fetchWithRetry('/api/proxy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (response.ok) {
                const data = await response.json();
                if (data.result) {
                    data.result.forEach(nft => {
                        totalFound++;
                        if (!existingIds.has(nft.token_id)) {
                            const pseudoTx = {
                                token_id: nft.token_id,
                                transaction_hash: `discovery-${nft.token_id}`,
                                block_timestamp: new Date('2022-11-22').toISOString(), // Fixed date: 2022-11-22
                                from_address: '0x0000000000000000000000000000000000000000',
                                to_address: nft.owner_of,
                                value: '0',
                                // Metadata handling if available directly
                                // metadata field is a string json
                            };
                            if (nft.metadata) {
                                try {
                                    const meta = JSON.parse(nft.metadata);
                                    pseudoTx.custom_image = meta.image;
                                } catch (e) { }
                            }
                            addNodeIncrementally(pseudoTx, CONFIG.colors.generative, 'Generative');
                            existingIds.add(nft.token_id);
                        }
                    });
                }

                if (data.cursor) {
                    page++;
                    // Schedule next page with RateLimiter
                    apiLimiter.add(() => fetchPage(data.cursor));
                } else {
                    console.log(`[Discovery] Complete. Total Unique Found: ${existingIds.size}`);

                    // Final Gap Check for logging purposes
                    const missing = [];
                    for (let i = 1; i <= CONFIG.counts.generative; i++) {
                        if (!existingIds.has(i.toString())) missing.push(i);
                    }
                    if (missing.length > 0) {
                        console.warn(`[GapAnalysis] Expected ${CONFIG.counts.generative} items, but ${missing.length} are still missing.`, missing);
                    } else {
                        console.log("[GapAnalysis] All expected items accounted for.");
                    }

                    state.loading.allDataLoaded = true;
                    state.loading.fetchingMissing = false;
                    updateStats();
                }
            }
        } catch (e) {
            console.error("Discovery Page Error:", e);
        }
    };

    // Kickoff
    apiLimiter.add(() => fetchPage(null));
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
