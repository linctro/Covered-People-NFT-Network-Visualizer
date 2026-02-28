const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const admin = require("firebase-admin");
const axios = require("axios");
const { defineSecret } = require("firebase-functions/params");
const fs = require("fs");
const path = require("path");
const { PubSub } = require('@google-cloud/pubsub');

admin.initializeApp();
const db = admin.firestore();
const pubsub = new PubSub();

// Define the secret
const MORALIS_API_KEY = defineSecret("MORALIS_API_KEY");

// Constants
const OpenseaPoly = "0x2953399124f0cbb46d2cbacd8a89cf0599974963".toLowerCase();
const MASTER_COLLECTION = "cache/master_data/history";
const META_DOC = "cache/master_data";
const SERVING_DOC = "cache/serving_data";
const NULL_ADDRESS = "0x0000000000000000000000000000000000000000";

// Load collection configs
const collections = JSON.parse(
  fs.readFileSync(path.join(__dirname, "collections.json"), "utf-8")
);

/**
 * Helper: Get API key with emulator fallback
 */
function getApiKey() {
  try {
    const val = MORALIS_API_KEY.value();
    if (val) return val;
  } catch (e) { /* emulator mode */ }
  return process.env.MORALIS_API_KEY || null;
}

/**
 * Helper: Sleep to respect rate limits
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Helper: Axios request with retry and exponential backoff
 */
async function axiosWithRetry(config, retries = 3, backoff = 1000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios(config);
      return res;
    } catch (err) {
      const status = err.response ? err.response.status : 0;
      if (attempt < retries && (status === 429 || status >= 500 || status === 0)) {
        console.warn(`Retry ${attempt + 1}/${retries} for ${config.url} (status: ${status})`);
        await sleep(backoff * Math.pow(2, attempt));
      } else {
        throw err;
      }
    }
  }
}

/**
 * HTTP Function: Return cached NFTs from Firestore (Serving Layer)
 * This now reads from the pre-aggregated serving document.
 */
exports.getNFTs = onRequest(
  {
    cors: true,
    maxInstances: 10,
  },
  async (req, res) => {
    try {
      const doc = await db.collection("cache").doc("serving_data").get();
      if (!doc.exists) {
        return res.status(404).send("Cache not initialized. Please wait for the first update.");
      }

      const data = doc.data();
      let nodes = [];

      if (data.chunks && data.chunks > 1) {
        // Load all chunks
        const promises = [];
        for (let i = 0; i < data.chunks; i++) {
          promises.push(db.collection("cache").doc(`serving_data_chunk_${i}`).get());
        }
        const snapshots = await Promise.all(promises);
        snapshots.forEach(snap => {
          if (snap.exists && snap.data().nodes) {
            nodes = nodes.concat(snap.data().nodes);
          }
        });
      } else {
        nodes = data.nodes || [];
      }

      res.set("Cache-Control", "public, max-age=3600, s-maxage=86400");
      return res.status(200).json({ nodes, last_updated: data.last_updated });
    } catch (error) {
      console.error("Firestore read error:", error);
      return res.status(500).send("Internal Server Error");
    }
  }
);

/**
 * HTTP Function: Proxy requests to Moralis API
 * Used by frontend to fetch NFT metadata/images on demand.
 */
exports.moralisProxy = onRequest(
  {
    cors: true,
    secrets: [MORALIS_API_KEY],
    maxInstances: 10,
  },
  async (req, res) => {
    try {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'POST only' });
      }

      const apiKey = MORALIS_API_KEY.value();
      if (!apiKey) {
        return res.status(500).json({ error: 'MORALIS_API_KEY not set' });
      }

      const { endpoint, params } = req.body;
      if (!endpoint) {
        return res.status(400).json({ error: 'Missing endpoint in request body' });
      }

      // Only allow /nft/ endpoints for security
      if (!endpoint.startsWith('/nft/')) {
        return res.status(403).json({ error: 'Only /nft/ endpoints are allowed' });
      }

      const response = await axios.get(`https://deep-index.moralis.io/api/v2${endpoint}`, {
        params: params || {},
        headers: { 'X-API-Key': apiKey }
      });

      res.set('Cache-Control', 'public, max-age=86400'); // Cache for 24h
      return res.status(200).json(response.data);
    } catch (error) {
      console.error('Proxy error:', error.message);
      const status = error.response ? error.response.status : 500;
      return res.status(status).json({ error: error.message });
    }
  }
);

/**
 * Manual Update Function (HTTP) - Directly executes the update logic
 * This bypasses PubSub for reliability and easier debugging.
 */
exports.manualUpdateCache = onRequest(
  {
    cors: true,
    secrets: [MORALIS_API_KEY],
    timeoutSeconds: 540, // 9 minutes
    memory: "512MiB",
  },
  async (req, res) => {
    console.log("manualUpdateCache: Starting direct update...");
    try {
      const apiKey = MORALIS_API_KEY.value();
      if (!apiKey) {
        return res.status(500).json({ error: "MORALIS_API_KEY is not set." });
      }
      console.log(`manualUpdateCache: Loaded ${collections.length} collections: ${collections.map(c => c.name).join(', ')}`);

      // 1. Get Per-Collection Sync Dates
      const metaDoc = await db.doc(META_DOC).get();
      const syncDates = (metaDoc.exists && metaDoc.data().sync_dates) || {};
      const genesisSync = (metaDoc.exists && metaDoc.data().genesis_sync_date) || "2022-01-01T00:00:00.000Z";

      // Allow reset for a specific collection: ?reset=RitoBeer or ?reset=all
      const resetTarget = req.query.reset || null;
      if (resetTarget === "all") {
        Object.keys(syncDates).forEach(k => delete syncDates[k]);
        console.log("manualUpdateCache: Full reset requested.");
      } else if (resetTarget && resetTarget !== "false") {
        delete syncDates[resetTarget];
        console.log(`manualUpdateCache: Reset requested for ${resetTarget}.`);
      }

      // Log per-collection sync info
      const syncInfo = {};
      collections.forEach(c => {
        syncInfo[c.type] = syncDates[c.type] || "NEW (2022-01-01)";
      });
      console.log("manualUpdateCache: Sync dates:", JSON.stringify(syncInfo));

      // 2. Fetch New Data (Per-Collection Incremental)
      const newNodes = await fetchNewDataFromMoralis(apiKey, syncDates, genesisSync);
      console.log(`manualUpdateCache: Fetched ${newNodes.length} new items.`);

      // 3. Save New Data to Master Collection (History)
      if (newNodes.length > 0) {
        await saveToMasterCollection(newNodes);
        console.log(`manualUpdateCache: Saved ${newNodes.length} items to master collection.`);
      }

      // 4. Generate Serving Data (Aggregation)
      await generateServingData();

      // 5. Update Per-Collection Sync Dates (only for collections that were fetched)
      const now = new Date().toISOString();
      const fetchedTypes = new Set(newNodes.map(n => n._custom_type).filter(Boolean));
      // Update sync date for collections that returned data, or that were attempted
      collections.forEach(c => {
        // Always update sync date so we don't re-fetch empty collections
        syncDates[c.type] = now;
      });
      await db.doc(META_DOC).set({
        sync_dates: syncDates,
        genesis_sync_date: now,
        last_sync_date: now // backward compat
      }, { merge: true });

      // Per-collection breakdown
      const breakdown = {};
      newNodes.forEach(n => {
        const t = n._custom_type || 'Unknown';
        breakdown[t] = (breakdown[t] || 0) + 1;
      });

      res.json({
        success: true,
        version: "multi-collection-v3",
        message: "Update completed successfully!",
        collections_loaded: collections.map(c => c.name),
        new_items: newNodes.length,
        breakdown,
        sync_dates_used: syncInfo,
        updated_at: now
      });

    } catch (error) {
      console.error("manualUpdateCache: FAILED:", error);
      res.status(500).json({
        error: error.message,
        stack: error.stack,
        detail: "Check Cloud Functions logs for more information."
      });
    }
  }
);

/**
 * Pub/Sub Function: Background Worker for Incremental Updates
 */
exports.onUpdateCacheSchedule = onMessagePublished(
  {
    topic: "update-nft-cache",
    secrets: [MORALIS_API_KEY],
    timeoutSeconds: 540, // 9 minutes
    memory: "512MiB",
  },
  async (event) => {
    console.log("Starting Incremental Cache Update...");
    const apiKey = MORALIS_API_KEY.value();
    if (!apiKey) throw new Error("MORALIS_API_KEY not set");

    try {
      // 1. Get Per-Collection Sync Dates
      const metaDoc = await db.doc(META_DOC).get();
      const syncDates = (metaDoc.exists && metaDoc.data().sync_dates) || {};
      const genesisSync = (metaDoc.exists && metaDoc.data().genesis_sync_date) || "2022-01-01T00:00:00.000Z";

      // 2. Fetch New Data (Per-Collection Incremental)
      const newNodes = await fetchNewDataFromMoralis(apiKey, syncDates, genesisSync);
      console.log(`Fetched ${newNodes.length} new items.`);

      // 3. Save New Data
      if (newNodes.length > 0) {
        await saveToMasterCollection(newNodes);
      }

      // 4. Generate Serving Data
      await generateServingData();

      // 5. Update Per-Collection Sync Dates
      const now = new Date().toISOString();
      collections.forEach(c => { syncDates[c.type] = now; });
      await db.doc(META_DOC).set({
        sync_dates: syncDates,
        genesis_sync_date: now,
        last_sync_date: now
      }, { merge: true });

      console.log("Incremental update complete.");
    } catch (error) {
      console.error("Cache update failed:", error);
      throw error;
    }
  }
);

async function fetchNewDataFromMoralis(apiKey, syncDates, genesisSync) {
  const DEFAULT_FROM = "2022-01-01T00:00:00.000Z";
  let allNodes = [];

  // 1. Genesis NFTs (Incremental) - individual token transfers
  const genesisFromDate = genesisSync || DEFAULT_FROM;
  console.log(`Genesis: fetching from ${genesisFromDate}`);
  const genesisPath = path.join(__dirname, "genesis_nfts.json");
  const genesisTargets = JSON.parse(fs.readFileSync(genesisPath, "utf-8"));

  for (const target of genesisTargets) {
    const chain = target.token_address.toLowerCase() === OpenseaPoly ? "polygon" : "eth";
    try {
      const res = await axios.get(`https://deep-index.moralis.io/api/v2/nft/${target.token_address}/${target.token_id}/transfers`, {
        params: { chain, format: "decimal", limit: 100, from_date: genesisFromDate },
        headers: { "X-API-Key": apiKey }
      });

      if (res.data.result) {
        res.data.result.forEach(tx => {
          allNodes.push(sanitize({
            ...tx,
            custom_image: target.image_url || null,
            custom_name: target.name,
            is_genesis_target: true,
            _custom_type: "Genesis"
          }));
        });
      }
      await sleep(200);
    } catch (err) {
      console.warn(`Genesis fetch error for ${target.name}:`, err.message);
    }
  }

  // 2. Collection-based Transfers - sorted: new collections first (no sync date)
  const sortedCollections = [...collections].sort((a, b) => {
    const aHasSync = syncDates[a.type] ? 1 : 0;
    const bHasSync = syncDates[b.type] ? 1 : 0;
    return aHasSync - bHasSync; // NEW (no sync) first
  });

  for (const collection of sortedCollections) {
    const collectionFromDate = syncDates[collection.type] || DEFAULT_FROM;
    console.log(`Fetching transfers for ${collection.name} (${collection.chain}) from ${collectionFromDate}...`);
    let cursor = null;
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;

    do {
      try {
        const res = await axiosWithRetry({
          method: 'get',
          url: `https://deep-index.moralis.io/api/v2/nft/${collection.address}/transfers`,
          params: { chain: collection.chain, format: "decimal", limit: 100, cursor, from_date: collectionFromDate },
          headers: { "X-API-Key": apiKey }
        });

        if (res.data.result) {
          res.data.result.forEach(tx => {
            allNodes.push(sanitize({
              ...tx,
              _custom_type: collection.type,
              _collection_address: collection.address.toLowerCase()
            }));
          });
        }
        cursor = res.data.cursor;
        consecutiveErrors = 0;
        await sleep(250);
      } catch (err) {
        consecutiveErrors++;
        console.error(`${collection.name} fetch error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, err.message);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.error(`Too many errors, stopping ${collection.name} fetch.`);
          break;
        }
        await sleep(2000);
      }
    } while (cursor);

    console.log(`${collection.name}: fetched ${allNodes.filter(n => n._custom_type === collection.type).length} transfers.`);
  }

  // 3. Metadata Discovery for new items (all collections)
  for (const collection of collections) {
    if (!collection.fetchMetadata) continue;

    const newIds = new Set(
      allNodes
        .filter(n => n._custom_type === collection.type && !n.is_metadata)
        .map(n => n.token_id)
    );

    if (newIds.size === 0) continue;
    console.log(`Fetching metadata for ${newIds.size} new ${collection.name} tokens...`);

    for (const tokenId of newIds) {
      try {
        const res = await axios.get(
          `https://deep-index.moralis.io/api/v2/nft/${collection.address}/${tokenId}`,
          {
            params: { chain: collection.chain, format: "decimal" },
            headers: { "X-API-Key": apiKey }
          }
        );
        const nft = res.data;
        let meta = {};
        try { meta = nft.metadata ? JSON.parse(nft.metadata) : {}; } catch (e) { /* invalid JSON */ }

        allNodes.push(sanitize({
          token_id: nft.token_id,
          transaction_hash: `meta-${collection.type}-${nft.token_id}`,
          block_timestamp: null,
          from_address: NULL_ADDRESS,
          to_address: nft.owner_of,
          custom_name: nft.name || `${collection.name} #${nft.token_id}`,
          custom_image: meta.image || null,
          _custom_type: collection.type,
          _collection_address: collection.address.toLowerCase(),
          is_metadata: true
        }));
        await sleep(200);
      } catch (e) {
        console.error(`Metadata fetch failed for ${collection.name} #${tokenId}:`, e.message);
      }
    }
  }

  return allNodes;
}

async function saveToMasterCollection(nodes) {
  const batchSize = 400;
  for (let i = 0; i < nodes.length; i += batchSize) {
    const batch = db.batch();
    const chunk = nodes.slice(i, i + batchSize);

    chunk.forEach(node => {
      const docId = `${node.token_id}_${node.transaction_hash}`;
      const ref = db.collection(MASTER_COLLECTION).doc(docId); // cache/master_data/history/docId
      batch.set(ref, node, { merge: true });
    });

    await batch.commit();
    console.log(`Saved batch ${i / batchSize + 1}`);
  }
}

function sanitize(obj) {
  const clean = {};
  Object.keys(obj).forEach(key => {
    if (obj[key] === undefined) {
      clean[key] = null;
    } else {
      clean[key] = obj[key];
    }
  });
  return clean;
}

async function generateServingData() {
  console.log("Generating serving data...");

  // Read ALL docs from Master Collection (History)
  const snapshot = await db.collection(MASTER_COLLECTION).get();

  // Build lookup for filterUnsold collections
  const filterUnsoldTypes = new Set(
    collections.filter(c => c.filterUnsold).map(c => c.type)
  );

  // Aggregate metadata and transfers
  const metadataMap = {};
  const allTransfers = [];

  snapshot.forEach(doc => {
    const data = doc.data();
    if (data.is_metadata) {
      const key = `${data._custom_type || 'Generative'}_${data.token_id}`;
      metadataMap[key] = { image: data.custom_image, name: data.custom_name };
    } else {
      allTransfers.push(data);
    }
  });

  // Merge metadata back into transfer nodes
  allTransfers.forEach(node => {
    const key = `${node._custom_type || 'Generative'}_${node.token_id}`;
    if (metadataMap[key]) {
      if (!node.custom_image) node.custom_image = metadataMap[key].image;
      if (!node.custom_name) node.custom_name = metadataMap[key].name;
    }
  });

  // Filter unsold NFTs: only include tokens that have at least one non-mint transfer
  let nodes;
  if (filterUnsoldTypes.size > 0) {
    // Group transfers by (type + token_id) for filterUnsold collections
    const tokenTransfers = {};
    allTransfers.forEach(node => {
      if (filterUnsoldTypes.has(node._custom_type)) {
        const key = `${node._custom_type}_${node.token_id}`;
        if (!tokenTransfers[key]) tokenTransfers[key] = [];
        tokenTransfers[key].push(node);
      }
    });

    // Find tokens that have been purchased (have non-mint transfers)
    const soldTokens = new Set();
    Object.entries(tokenTransfers).forEach(([key, transfers]) => {
      const hasNonMintTransfer = transfers.some(
        t => t.from_address && t.from_address.toLowerCase() !== NULL_ADDRESS
      );
      if (hasNonMintTransfer) soldTokens.add(key);
    });

    // Filter: keep all non-filterUnsold nodes + only sold filterUnsold nodes
    nodes = allTransfers.filter(node => {
      if (!filterUnsoldTypes.has(node._custom_type)) return true;
      const key = `${node._custom_type}_${node.token_id}`;
      return soldTokens.has(key);
    });

    console.log(`FilterUnsold: ${allTransfers.length} total → ${nodes.length} after filtering`);
  } else {
    nodes = allTransfers;
  }

  const jsonString = JSON.stringify({ nodes }); // simplistic size check
  const sizeBytes = Buffer.byteLength(jsonString);
  console.log(`Total serving data size: ${(sizeBytes / 1024 / 1024).toFixed(2)} MB`);

  const MAX_SIZE = 900000; // ~900KB

  // If small enough, single doc
  if (sizeBytes < MAX_SIZE) {
    await db.collection("cache").doc("serving_data").set({
      nodes,
      chunks: 1,
      last_updated: new Date().toISOString()
    });
  } else {
    // Chunk it
    const chunkCount = Math.ceil(sizeBytes / MAX_SIZE);
    const itemsPerChunk = Math.ceil(nodes.length / chunkCount);

    // Firestore batch has a 500 operation limit, so we may need multiple batches
    const allOps = [];
    for (let c = 0; c < chunkCount; c++) {
      const start = c * itemsPerChunk;
      const end = start + itemsPerChunk;
      const chunkNodes = nodes.slice(start, end);
      allOps.push({ ref: db.collection("cache").doc(`serving_data_chunk_${c}`), data: { nodes: chunkNodes, index: c } });
    }
    // Main doc points to chunks
    allOps.push({ ref: db.collection("cache").doc("serving_data"), data: { chunks: chunkCount, last_updated: new Date().toISOString() } });

    // Write in batches of 450 (safely under 500 limit)
    const BATCH_LIMIT = 450;
    for (let i = 0; i < allOps.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      const slice = allOps.slice(i, i + BATCH_LIMIT);
      slice.forEach(op => batch.set(op.ref, op.data));
      await batch.commit();
    }
    console.log(`Saved ${chunkCount} chunks.`);
  }
}
