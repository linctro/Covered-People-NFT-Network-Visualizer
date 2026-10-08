const { onRequest } = require("firebase-functions/v2/https");
const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const admin = require("firebase-admin");
const { defineSecret } = require("firebase-functions/params");
const { Alchemy, Network } = require("alchemy-sdk");
const fs = require("fs");
const path = require("path");
const { PubSub } = require('@google-cloud/pubsub');

admin.initializeApp();
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
const pubsub = new PubSub();

// Define the secret
const ALCHEMY_API_KEY = defineSecret("ALCHEMY_API_KEY");

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
 * Helper: Get Alchemy API key with emulator fallback
 */
function getAlchemyKey() {
  try {
    const val = ALCHEMY_API_KEY.value();
    if (val) return val;
  } catch (e) { /* emulator mode */ }
  return process.env.ALCHEMY_API_KEY || null;
}

/**
 * Helper: Create Alchemy clients for ETH and Polygon
 */
function createAlchemyClients(apiKey) {
  return {
    eth: new Alchemy({ apiKey, network: Network.ETH_MAINNET }),
    polygon: new Alchemy({ apiKey, network: Network.MATIC_MAINNET })
  };
}

/**
 * Helper: Sleep to respect rate limits
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * HTTP Function: Return cached NFTs from Firestore (Serving Layer)
 * This reads from the pre-aggregated serving document.
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
 * HTTP Function: Proxy requests to fetch NFT metadata/images
 * Powered by Alchemy SDK (maintains URL compatibility with /api/proxy)
 */
exports.moralisProxy = onRequest(
  {
    cors: true,
    secrets: [ALCHEMY_API_KEY],
    maxInstances: 10,
  },
  async (req, res) => {
    try {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'POST only' });
      }

      const apiKey = getAlchemyKey();
      if (!apiKey) {
        return res.status(500).json({ error: 'ALCHEMY_API_KEY not set' });
      }

      const { endpoint, params } = req.body;
      if (!endpoint) {
        return res.status(400).json({ error: 'Missing endpoint in request body' });
      }

      // Endpoint format expected: /nft/:contractAddress/:tokenId
      const match = endpoint.match(/\/nft\/([^/]+)\/([^/]+)/);
      if (!match) {
        return res.status(400).json({ error: 'Unsupported endpoint format' });
      }

      const [, contractAddress, tokenId] = match;
      const chain = (params && params.chain && params.chain.toLowerCase() === 'polygon') ? 'polygon' : 'eth';
      const clients = createAlchemyClients(apiKey);
      const client = chain === 'polygon' ? clients.polygon : clients.eth;

      const meta = await client.nft.getNftMetadata(contractAddress, tokenId);
      const imageUrl = meta.image?.cachedUrl || meta.image?.originalUrl || meta.raw?.metadata?.image || null;

      res.set('Cache-Control', 'public, max-age=86400');
      return res.status(200).json({
        normalized_metadata: {
          name: meta.name || '',
          image: imageUrl
        },
        metadata: meta.raw?.metadata || {}
      });
    } catch (error) {
      console.error('Proxy error:', error.message);
      const status = error.status || 500;
      return res.status(status).json({ error: error.message });
    }
  }
);

/**
 * Manual Update Function (HTTP) - Directly executes the update logic via Alchemy
 */
exports.manualUpdateCache = onRequest(
  {
    cors: true,
    secrets: [ALCHEMY_API_KEY],
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (req, res) => {
    console.log("manualUpdateCache: Starting direct update via Alchemy...");
    try {
      const alchemyKey = getAlchemyKey();
      if (!alchemyKey) {
        return res.status(500).json({ error: "ALCHEMY_API_KEY is not set." });
      }

      const clients = createAlchemyClients(alchemyKey);
      console.log("✓ Alchemy API Key loaded and clients initialized successfully");
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

      // 2. Fetch New Data via Alchemy
      const newNodes = await fetchNewDataFromAlchemy(clients, syncDates, genesisSync);
      console.log(`manualUpdateCache: Fetched ${newNodes.length} items from Alchemy.`);

      // 3. Save New Data to Master Collection (History)
      if (newNodes.length > 0) {
        await saveToMasterCollection(newNodes);
        console.log(`manualUpdateCache: Saved ${newNodes.length} items to master collection.`);
      }

      // 4. Generate Serving Data (Aggregation)
      await generateServingData();

      // 5. Update Per-Collection Sync Dates
      const now = new Date().toISOString();
      collections.forEach(c => {
        syncDates[c.type] = now;
      });
      await db.doc(META_DOC).set({
        sync_dates: syncDates,
        genesis_sync_date: now,
        last_sync_date: now
      }, { merge: true });

      // Per-collection breakdown
      const breakdown = {};
      newNodes.forEach(n => {
        const t = n._custom_type || 'Unknown';
        breakdown[t] = (breakdown[t] || 0) + 1;
      });

      return res.status(200).json({
        status: "success",
        provider: "Alchemy",
        new_items: newNodes.length,
        breakdown,
        sync_dates: syncDates,
        timestamp: now
      });
    } catch (error) {
      console.error("manualUpdateCache error:", error);
      return res.status(500).json({ error: error.message, stack: error.stack });
    }
  }
);

/**
 * Pub/Sub Function: Background Worker for Incremental Updates
 */
exports.onUpdateCacheSchedule = onMessagePublished(
  {
    topic: "update-nft-cache",
    secrets: [ALCHEMY_API_KEY],
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (event) => {
    console.log("Starting Incremental Cache Update via Alchemy...");
    const alchemyKey = getAlchemyKey();
    if (!alchemyKey) throw new Error("ALCHEMY_API_KEY not set");

    const clients = createAlchemyClients(alchemyKey);
    console.log("✓ Alchemy API Key loaded and clients initialized successfully");

    try {
      const metaDoc = await db.doc(META_DOC).get();
      const syncDates = (metaDoc.exists && metaDoc.data().sync_dates) || {};
      const genesisSync = (metaDoc.exists && metaDoc.data().genesis_sync_date) || "2022-01-01T00:00:00.000Z";

      const newNodes = await fetchNewDataFromAlchemy(clients, syncDates, genesisSync);
      console.log(`Incremental update: Fetched ${newNodes.length} items from Alchemy.`);

      if (newNodes.length > 0) {
        await saveToMasterCollection(newNodes);
        console.log(`Incremental update: Saved ${newNodes.length} items to master collection.`);
      }

      await generateServingData();

      const now = new Date().toISOString();
      collections.forEach(c => {
        syncDates[c.type] = now;
      });
      await db.doc(META_DOC).set({
        sync_dates: syncDates,
        genesis_sync_date: now,
        last_sync_date: now
      }, { merge: true });

      console.log("Incremental update completed successfully.");
    } catch (error) {
      console.error("Incremental update failed:", error);
      throw error;
    }
  }
);

/**
 * Fetch New Data using Alchemy SDK
 */
async function fetchNewDataFromAlchemy(clients, syncDates, genesisSync) {
  let allNodes = [];

  // 1. Genesis NFTs (Load target list and resolve latest owner)
  const genesisPath = path.join(__dirname, "genesis_nfts.json");
  if (fs.existsSync(genesisPath)) {
    const genesisTargets = JSON.parse(fs.readFileSync(genesisPath, "utf-8"));
    console.log(`Processing ${genesisTargets.length} Genesis NFTs...`);

    for (const target of genesisTargets) {
      const isPolygon = target.token_address.toLowerCase() === OpenseaPoly;
      const client = isPolygon ? clients.polygon : clients.eth;

      let owner = NULL_ADDRESS;
      try {
        const ownerRes = await client.nft.getOwnersForNft(target.token_address, target.token_id);
        if (ownerRes.owners && ownerRes.owners.length > 0) {
          owner = ownerRes.owners[0].toLowerCase();
        }
      } catch (err) {
        // Fallback to null address if owner lookup fails
      }

      allNodes.push(sanitize({
        token_id: target.token_id,
        transaction_hash: `genesis_${target.token_id}`,
        block_timestamp: null,
        from_address: NULL_ADDRESS,
        to_address: owner,
        custom_name: target.name,
        custom_image: target.image_url || (target.metadata && target.metadata.image) || null,
        is_genesis_target: true,
        _custom_type: "Genesis",
        _collection_address: target.token_address.toLowerCase()
      }));

      await sleep(40);
    }
  }

  // 2. Collection-based Transfers
  for (const collection of collections) {
    const client = collection.chain.toLowerCase() === 'eth' ? clients.eth : clients.polygon;
    console.log(`Fetching transfers for ${collection.name} (${collection.chain}) via Alchemy...`);

    let pageKey = undefined;
    let pageCount = 0;
    const MAX_PAGES = 10; // 1000 transfers limit per run for safety

    do {
      try {
        const res = await client.nft.getTransfersForContract(collection.address, {
          pageKey,
          limit: 100
        });

        if (res.nfts && res.nfts.length > 0) {
          res.nfts.forEach(tx => {
            allNodes.push(sanitize({
              token_id: tx.tokenId,
              transaction_hash: tx.transactionHash,
              block_timestamp: null,
              from_address: tx.from ? tx.from.toLowerCase() : NULL_ADDRESS,
              to_address: tx.to ? tx.to.toLowerCase() : NULL_ADDRESS,
              _custom_type: collection.type,
              _collection_address: collection.address.toLowerCase()
            }));
          });
        }
        pageKey = res.pageKey;
        pageCount++;
        if (pageCount >= MAX_PAGES) break;
        await sleep(100);
      } catch (err) {
        console.error(`${collection.name} transfer fetch error:`, err.message);
        break;
      }
    } while (pageKey);

    console.log(`${collection.name}: fetched ${allNodes.filter(n => n._custom_type === collection.type).length} transfers.`);
  }

  // 3. Metadata Discovery for Collections
  for (const collection of collections) {
    if (!collection.fetchMetadata) continue;
    const client = collection.chain.toLowerCase() === 'eth' ? clients.eth : clients.polygon;

    const targetIds = [...new Set(
      allNodes
        .filter(n => n._custom_type === collection.type && !n.is_metadata)
        .map(n => n.token_id)
    )];

    if (targetIds.length === 0) continue;
    console.log(`Fetching metadata for ${targetIds.length} ${collection.name} tokens via Alchemy batch...`);

    const BATCH_SIZE = 100;
    for (let i = 0; i < targetIds.length; i += BATCH_SIZE) {
      const chunk = targetIds.slice(i, i + BATCH_SIZE);
      const tokenRequests = chunk.map(id => ({
        contractAddress: collection.address,
        tokenId: id,
        tokenType: 'ERC721'
      }));

      try {
        const batchRes = await client.nft.getNftMetadataBatch(tokenRequests);
        if (batchRes && batchRes.nfts) {
          batchRes.nfts.forEach(nft => {
            let imgUrl = nft.image?.cachedUrl || nft.image?.originalUrl || nft.raw?.metadata?.image || null;
            if (imgUrl && typeof imgUrl === 'string') {
              if (imgUrl.startsWith('ipfs://')) {
                imgUrl = imgUrl.replace(/^ipfs:\/\/(ipfs\/)?/, 'https://cloudflare-ipfs.com/ipfs/');
              }
              const arMatch = imgUrl.match(/^https?:\/\/[a-z0-9]+\.arweave\.net\/(.+)$/i);
              if (arMatch) {
                imgUrl = 'https://ar-io.dev/' + arMatch[1];
              }
            }

            allNodes.push(sanitize({
              token_id: nft.tokenId,
              transaction_hash: `meta-${collection.type}-${nft.tokenId}`,
              block_timestamp: null,
              from_address: NULL_ADDRESS,
              to_address: NULL_ADDRESS,
              custom_name: nft.name || `${collection.name} #${nft.tokenId}`,
              custom_image: imgUrl,
              _custom_type: collection.type,
              _collection_address: collection.address.toLowerCase(),
              is_metadata: true
            }));
          });
        }
        await sleep(150);
      } catch (err) {
        console.error(`Metadata batch fetch error for ${collection.name}:`, err.message);
      }
    }
  }

  return allNodes;
}

/**
 * Save nodes to Firestore Master Collection in batches
 */
async function saveToMasterCollection(nodes) {
  const batchSize = 400;
  for (let i = 0; i < nodes.length; i += batchSize) {
    const batch = db.batch();
    const chunk = nodes.slice(i, i + batchSize);

    chunk.forEach(node => {
      const docId = `${node.token_id}_${node.transaction_hash}`;
      const ref = db.collection(MASTER_COLLECTION).doc(docId);
      batch.set(ref, node, { merge: true });
    });

    await batch.commit();
    console.log(`Saved batch ${i / batchSize + 1}`);
  }
}

/**
 * Helper to ensure undefined values are converted to null for Firestore
 */
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

/**
 * Generate Serving Data (Aggregation Layer)
 */
async function generateServingData() {
  console.log("Generating serving data...");

  // Read ALL docs from Master Collection (History)
  const snapshot = await db.collection(MASTER_COLLECTION).get();

  // Mint wallet address for filterFromMint collections
  const MINT_WALLET = "0x115658e7f1d9bd343276453b826518028d40e2c6";

  // Build lookup for filterFromMint collections
  const filterFromMintTypes = new Set(
    collections.filter(c => c.filterFromMint).map(c => c.type)
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
      node.custom_image = metadataMap[key].image || node.custom_image;
      if (!node.custom_name) node.custom_name = metadataMap[key].name;
    }
  });

  // Filter: only include tokens transferred FROM the mint wallet for filterFromMint collections
  let nodes;
  if (filterFromMintTypes.size > 0) {
    const tokenTransfers = {};
    allTransfers.forEach(node => {
      if (filterFromMintTypes.has(node._custom_type)) {
        const key = `${node._custom_type}_${node.token_id}`;
        if (!tokenTransfers[key]) tokenTransfers[key] = [];
        tokenTransfers[key].push(node);
      }
    });

    const distributedTokens = new Set();
    Object.entries(tokenTransfers).forEach(([key, transfers]) => {
      const hasLeftMintWallet = transfers.some(
        t => t.from_address && t.from_address.toLowerCase() === MINT_WALLET
      );
      if (hasLeftMintWallet) distributedTokens.add(key);
    });

    nodes = allTransfers.filter(node => {
      if (!filterFromMintTypes.has(node._custom_type)) return true;
      const key = `${node._custom_type}_${node.token_id}`;
      return distributedTokens.has(key);
    });

    console.log(`FilterFromMint: ${allTransfers.length} total → ${nodes.length} after filtering (mint wallet: ${MINT_WALLET})`);
  } else {
    nodes = allTransfers;
  }

  const jsonString = JSON.stringify({ nodes });
  const sizeBytes = Buffer.byteLength(jsonString);
  console.log(`Total serving data size: ${(sizeBytes / 1024 / 1024).toFixed(2)} MB`);

  const MAX_SIZE = 900000; // ~900KB

  if (sizeBytes < MAX_SIZE) {
    await db.collection("cache").doc("serving_data").set({
      nodes,
      chunks: 1,
      last_updated: new Date().toISOString()
    });
  } else {
    const chunkCount = Math.ceil(sizeBytes / MAX_SIZE);
    const itemsPerChunk = Math.ceil(nodes.length / chunkCount);

    const allOps = [];
    for (let c = 0; c < chunkCount; c++) {
      const start = c * itemsPerChunk;
      const end = start + itemsPerChunk;
      const chunkNodes = nodes.slice(start, end);
      allOps.push({ ref: db.collection("cache").doc(`serving_data_chunk_${c}`), data: { nodes: chunkNodes, index: c } });
    }
    allOps.push({ ref: db.collection("cache").doc("serving_data"), data: { chunks: chunkCount, last_updated: new Date().toISOString() } });

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
