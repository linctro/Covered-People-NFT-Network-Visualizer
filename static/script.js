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
        genesis: 200,
        generative: 3333,
        total: 3533
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
    }
};

// --- Data Generation ---

async function fetchRealData() {
    // Configuration moved to CONFIG.contracts

    // Helper for Rate Limiting
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Helper: Check if token_id matches the issuer (OpenSea Shared Storefront logic)
    const isIssuerToken = (tokenId) => {
        try {
            // OpenSea ID: [Address (160 bits)] | [Index (96 bits)]
            const idBigInt = BigInt(tokenId);
            const addressPart = (idBigInt >> 96n).toString(16).padStart(40, '0');
            return addressPart.toLowerCase() === CONFIG.contracts.issuer.replace('0x', '');
        } catch (e) {
            console.error("Token ID Check Error:", e);
            return false;
        }
    };

    // 1. Fetch Genesis Data (From Issuer's Wallet History)
    // Supports both Ethereum and Polygon
    const fetchGenesisHistory = async () => {
        // Sub-function to fetch for a specific chain
        const fetchChain = async (chain, targetContract) => {
            let chainResults = [];
            let cursor = null;
            let page = 1;

            console.log(`Fetching Genesis History (${chain.toUpperCase()} - Issuer Wallet)...`);

            do {
                const body = {
                    endpoint: `/${CONFIG.contracts.issuer}/nft/transfers`,
                    params: {
                        chain: chain,
                        format: 'decimal',
                        limit: '100'
                    }
                };
                if (cursor) body.params.cursor = cursor;

                try {
                    const response = await fetch('/api/proxy', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });

                    if (!response.ok) throw new Error(`API Error: ${response.status}`);
                    const data = await response.json();

                    if (data.result) {
                        // Filter for OpenSea Shared Contract (Specific to Chain) AND Issuer's Token ID Pattern
                        const filtered = data.result.filter(tx =>
                            tx.token_address.toLowerCase() === targetContract &&
                            isIssuerToken(tx.token_id)
                        );

                        chainResults = chainResults.concat(filtered);
                        console.log(`Genesis (${chain}) Page ${page}: Found ${filtered.length} relevant transfers`);
                    }
                    cursor = data.cursor;
                    page++;
                    await sleep(300); // Rate limit

                } catch (err) {
                    console.error(`Genesis Fetch Error (${chain}):`, err);
                    break;
                }
            } while (cursor && page <= 10); // Check enough pages on both chains

            return chainResults;
        };

        // Run both fetches
        const [ethData, polyData] = await Promise.all([
            fetchChain('eth', CONFIG.contracts.openseaEth),
            fetchChain('polygon', CONFIG.contracts.openseaPoly)
        ]);

        const allResults = ethData.concat(polyData);
        console.log(`Finished Genesis: ${allResults.length} validated transfers (Eth: ${ethData.length}, Poly: ${polyData.length}).`);
        return allResults;
    };

    // 2. Fetch Generative Data (Contract Transfers)
    // Only on Ethereum separate contract
    const fetchGenerativeHistory = async () => {
        let allResults = [];
        let cursor = null;
        let page = 1;

        console.log("Fetching Generative History (Contract)...");

        do {
            const body = {
                endpoint: `/nft/${CONFIG.contracts.generative}/transfers`,
                params: { chain: 'eth', format: 'decimal', limit: '100' }
            };
            if (cursor) body.params.cursor = cursor;

            try {
                const response = await fetch('/api/proxy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const data = await response.json();
                if (data.result) {
                    allResults = allResults.concat(data.result);
                    console.log(`Generative Page ${page}: ${data.result.length} items`);
                }
                cursor = data.cursor;
                page++;
                await sleep(300);
            } catch (e) {
                break;
            }
        } while (cursor && page <= 100);

        return allResults;
    };

    try {
        const [genesisData, generativeData] = await Promise.all([
            fetchGenesisHistory(),
            fetchGenerativeHistory()
        ]);

        processApiData({ genesis: genesisData, generative: generativeData });

    } catch (e) {
        console.error("Fatal Fetch Error:", e);
        generateMockData();
    }
}

function processApiData(data) {
    const nodes = [];
    const edges = [];

    // 0. Issuer Node
    const issuerNode = {
        id: 'issuer',
        type: 'issuer',
        x: 0, y: 0,
        color: '#ffffff',
        radius: CONFIG.radii.issuer,
        year: 2022,
        nftType: 'Issuer',
        transfers: 'N/A'
    };
    nodes.push(issuerNode);

    // Helper: Year from Timestamp
    const getYear = (ts) => ts ? parseInt(ts.substring(0, 4)) : 2022;

    // Helper: Random Angle & Radius
    const randomAngle = () => Math.random() * Math.PI * 2;
    const getRadius = (timestamp) => {
        const date = new Date(timestamp);
        const year = date.getFullYear();
        const startOfYear = new Date(year, 0, 1).getTime();
        const endOfYear = new Date(year + 1, 0, 1).getTime();
        const fraction = (date.getTime() - startOfYear) / (endOfYear - startOfYear);

        // Radius = Start + (YearIndex + Fraction) * Gap
        // This spreads points strictly by time: Jan 1 is inner, Dec 31 is outer edge of the ring.
        const yearIndex = Math.max(0, year - 2022);
        return CONFIG.radii.start + ((yearIndex + fraction) * CONFIG.radii.gap);
    };

    // Processor mainly for Path Linking
    const processSet = (dataset, typeColor, typeLabel) => {
        if (!dataset) return;

        // Group by Token ID to sort by time
        const tokens = {};
        dataset.forEach(tx => {
            if (!tokens[tx.token_id]) tokens[tx.token_id] = [];
            tokens[tx.token_id].push(tx);
        });

        // Create Nodes & Sequential Edges
        Object.keys(tokens).forEach(tokenId => {
            // Sort by block number/timestamp ascending
            const history = tokens[tokenId].sort((a, b) =>
                new Date(a.block_timestamp) - new Date(b.block_timestamp)
            );

            let previousNode = null;

            // Generate a persistent base angle for this token based on ID
            // Simple hash that ensures distribution across 360 degrees
            let idHash = 0;
            const idStr = tokenId.toString();
            for (let i = 0; i < idStr.length; i++) {
                idHash = ((idHash << 5) - idHash) + idStr.charCodeAt(i);
                idHash |= 0; // Convert to 32bit integer
            }
            const baseAngle = Math.abs(idHash % 360) * (Math.PI / 180);

            history.forEach((tx, idx) => {
                const year = getYear(tx.block_timestamp);

                // Keep the base angle but add a TINY jitter so multiple points for same year spread slightly.
                const angleJitter = (Math.random() - 0.5) * 0.1;
                const finalAngle = baseAngle + angleJitter;

                const r = getRadius(tx.block_timestamp);
                const nodeRadius = typeLabel === 'Genesis' ? CONFIG.radii.genesis : CONFIG.radii.node;

                const node = {
                    id: `${typeLabel}-${tokenId}-${tx.transaction_hash}-${idx}`,
                    token_id: tokenId,
                    x: Math.cos(finalAngle) * r,
                    y: Math.sin(finalAngle) * r,
                    color: typeColor,
                    radius: nodeRadius,
                    year: year,
                    nftType: typeLabel,
                    timestamp: tx.block_timestamp,
                    tx_hash: tx.transaction_hash,
                    from: tx.from_address,
                    to: tx.to_address
                };

                nodes.push(node);

                // Create Path Edge (Sequential)
                if (previousNode) {
                    edges.push({ source: previousNode, target: node, type: 'path' });
                } else if (idx === 0) {
                    // Link first event to Issuer (simulating mint origin)
                    edges.push({ source: issuerNode, target: node, type: 'mint' });
                }

                previousNode = node;
            });
        });
    };

    processSet(data.genesis, CONFIG.colors.genesis, 'Genesis');
    processSet(data.generative, CONFIG.colors.generative, 'Generative');

    state.nodes = nodes;
    state.edges = edges;

    // Update Stats
    const totalEvents = (nodes.length - 1);
    if (document.getElementById('stat-total-transfers')) {
        document.getElementById('stat-total-transfers').textContent = totalEvents.toLocaleString();
    }

    // Calculate Unique NFTs
    const uniqueIDs = new Set();
    nodes.forEach(n => {
        if (n.token_id) uniqueIDs.add(n.token_id);
    });

    if (document.getElementById('stat-unique-nfts')) {
        document.getElementById('stat-unique-nfts').textContent = uniqueIDs.size.toLocaleString();
    }
    document.getElementById('stat-total-nfts').textContent = CONFIG.counts.total.toLocaleString() + " (Target)";

    console.log(`Visualization Updated: ${nodes.length} nodes (transfers), ${edges.length} edges. Unique NFTs: ${uniqueIDs.size}`);
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

        // FIXED PIXEL SIZE logic:
        // We want the node to be X pixels on screen, regardless of zoom.
        // Current Scale = state.transform.scale.
        // Effective Radius in World Space = BaseRadius / Scale.
        const effectiveRadius = (node.radius / state.transform.scale) * (isHovered ? 1.5 : 1);

        ctx.beginPath();
        ctx.arc(node.x, node.y, effectiveRadius, 0, Math.PI * 2);
        ctx.fillStyle = (isHovered || isSelected) ? '#ffffff' : node.color;

        // Highlight logic
        if (isSelected || isHovered) {
            ctx.shadowBlur = 10;
            ctx.shadowColor = node.color;
        } else {
            ctx.shadowBlur = 0;
        }

        ctx.fill();
        ctx.shadowBlur = 0; // Reset

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

        tokenIdEl.textContent = node.token_id || '?';
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
