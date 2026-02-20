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
const ContractGenerative = "0x0e6a70cb485ed3735fa2136e0d4adc4bf5456f93".toLowerCase();
const OpenseaPoly = "0x2953399124f0cbb46d2cbacd8a89cf0599974963".toLowerCase();
const MASTER_COLLECTION = "cache/master_data/history";
const META_DOC = "cache/master_data";
const SERVING_DOC = "cache/serving_data";

/**
 * Helper: Sleep to respect rate limits
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

      res.set("Cache-Control", "public, max-age=3600");
      return res.status(200).json({ nodes, last_updated: data.last_updated });
    } catch (error) {
      console.error("Firestore read error:", error);
      return res.status(500).send("Internal Server Error");
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
        return res.status(500).json({ error: "MORALIS_API_KEY is not set. Please run: printf 'YOUR_KEY' | firebase functions:secrets:set MORALIS_API_KEY" });
      }
      console.log("manualUpdateCache: API key loaded successfully.");

      // 1. Get Last Sync Date
      const metaDoc = await db.doc(META_DOC).get();
      let lastSync = "2022-01-01T00:00:00.000Z";

      if (metaDoc.exists && metaDoc.data().last_sync_date) {
        lastSync = metaDoc.data().last_sync_date;
      }
      console.log(`manualUpdateCache: Last sync date: ${lastSync}`);

      // 2. Fetch New Data (Incremental)
      const newNodes = await fetchNewDataFromMoralis(apiKey, lastSync);
      console.log(`manualUpdateCache: Fetched ${newNodes.length} new items.`);

      // 3. Save New Data to Master Collection (History)
      if (newNodes.length > 0) {
        await saveToMasterCollection(newNodes);
        console.log(`manualUpdateCache: Saved ${newNodes.length} items to master collection.`);
      }

      // 4. Generate Serving Data (Aggregation)
      await generateServingData();

      // 5. Update Last Sync Date
      const now = new Date().toISOString();
      await db.doc(META_DOC).set({ last_sync_date: now }, { merge: true });

      console.log("manualUpdateCache: Incremental update complete.");
      res.json({
        success: true,
        message: "Update completed successfully!",
        new_items: newNodes.length,
        last_sync: lastSync,
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
      // 1. Get Last Sync Date
      const metaDoc = await db.doc(META_DOC).get();
      let lastSync = "2022-01-01T00:00:00.000Z";

      if (metaDoc.exists && metaDoc.data().last_sync_date) {
        lastSync = metaDoc.data().last_sync_date;
      }
      console.log(`Last sync date: ${lastSync}`);

      // 2. Fetch New Data (Incremental)
      const newNodes = await fetchNewDataFromMoralis(apiKey, lastSync);
      console.log(`Fetched ${newNodes.length} new items.`);

      // 3. Save New Data to Master Collection (History)
      if (newNodes.length > 0) {
        await saveToMasterCollection(newNodes);
      }

      // 4. Generate Serving Data (Aggregation)
      await generateServingData();

      // 5. Update Last Sync Date
      const now = new Date().toISOString();
      await db.doc(META_DOC).set({ last_sync_date: now }, { merge: true });

      console.log("Incremental update complete.");

    } catch (error) {
      console.error("Cache update failed:", error);
      throw error;
    }
  }
);

async function fetchNewDataFromMoralis(apiKey, fromDate) {
  let allNodes = [];

  // 1. Genesis NFTs (Incremental)
  const genesisPath = path.join(__dirname, "genesis_nfts.json");
  const genesisTargets = JSON.parse(fs.readFileSync(genesisPath, "utf-8"));

  for (const target of genesisTargets) {
    const chain = target.token_address.toLowerCase() === OpenseaPoly ? "polygon" : "eth";
    try {
      const res = await axios.get(`https://deep-index.moralis.io/api/v2/nft/${target.token_address}/${target.token_id}/transfers`, {
        params: { chain, format: "decimal", limit: 100, from_date: fromDate },
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

  // 2. Generative Transfers (Incremental)
  let cursor = null;
  do {
    try {
      const res = await axios.get(`https://deep-index.moralis.io/api/v2/nft/${ContractGenerative}/transfers`, {
        params: { chain: "eth", format: "decimal", limit: 100, cursor, from_date: fromDate },
        headers: { "X-API-Key": apiKey }
      });

      if (res.data.result) {
        res.data.result.forEach(tx => {
          allNodes.push(sanitize({ ...tx, _custom_type: "Generative" }));
        });
      }
      cursor = res.data.cursor;
      await sleep(250);
    } catch (err) {
      console.error("Generative Transfer fetch error:", err.message);
      break;
    }
  } while (cursor);

  // 3. Metadata Discovery for new items
  const newGenerativeIds = new Set(allNodes.filter(n => n._custom_type === 'Generative').map(n => n.token_id));
  if (newGenerativeIds.size > 0) {
    console.log(`Fetching metadata for ${newGenerativeIds.size} new tokens...`);
    for (const tokenId of newGenerativeIds) {
      try {
        const res = await axios.get(`https://deep-index.moralis.io/api/v2/nft/${ContractGenerative}/${tokenId}`, {
          params: { chain: "eth", format: "decimal" },
          headers: { "X-API-Key": apiKey }
        });
        const nft = res.data;
        const meta = nft.metadata ? JSON.parse(nft.metadata) : {};

        allNodes.push(sanitize({
          token_id: nft.token_id,
          transaction_hash: `meta-${nft.token_id}`,
          block_timestamp: null,
          from_address: "0x0000000000000000000000000000000000000000",
          to_address: nft.owner_of,
          custom_name: nft.name || `CloneX #${nft.token_id}`,
          custom_image: meta.image || null,
          _custom_type: "Generative",
          is_metadata: true
        }));
        await sleep(200);
      } catch (e) {
        console.error(`Metadata fetch failed for ${tokenId}:`, e.message);
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

  // Aggregate metadata
  const metadataMap = {};
  const nodes = [];

  snapshot.forEach(doc => {
    const data = doc.data();
    if (data.is_metadata) {
      metadataMap[data.token_id] = { image: data.custom_image, name: data.custom_name };
    } else {
      nodes.push(data);
    }
  });

  // Merge metadata back into transfer nodes
  nodes.forEach(node => {
    if (metadataMap[node.token_id]) {
      if (!node.custom_image) node.custom_image = metadataMap[node.token_id].image;
      if (!node.custom_name) node.custom_name = metadataMap[node.token_id].name;
    }
  });

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
