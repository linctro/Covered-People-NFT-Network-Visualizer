const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const admin = require("firebase-admin");
const axios = require("axios");
const { defineSecret } = require("firebase-functions/params");
const fs = require("fs");
const path = require("path");

admin.initializeApp();
const db = admin.firestore();

// Define the secret
const MORALIS_API_KEY = defineSecret("MORALIS_API_KEY");

// Constants
const ContractIssuer = "0x91f5914A70C1F5d9fae0408aE16f1c19758337Eb".toLowerCase();
const ContractGenerative = "0x0e6a70cb485ed3735fa2136e0d4adc4bf5456f93".toLowerCase();
const OpenseaEth = "0x495f947276749ce646f68ac8c248420045cb7b5e".toLowerCase();
const OpenseaPoly = "0x2953399124f0cbb46d2cbacd8a89cf0599974963".toLowerCase();

/**
 * Helper: Sleep to respect rate limits
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * HTTP Function: Return cached NFTs from Firestore
 */
exports.getNFTs = onRequest(
  {
    cors: true,
    maxInstances: 10,
  },
  async (req, res) => {
    try {
      const doc = await db.collection("cache").doc("aoi_nfts").get();
      if (!doc.exists) {
        return res.status(404).send("Cache not initialized. Please wait for the first update.");
      }

      res.set("Cache-Control", "public, max-age=3600");
      return res.status(200).json(doc.data());
    } catch (error) {
      console.error("Firestore read error:", error);
      return res.status(500).send("Internal Server Error");
    }
  }
);

/**
 * Pub/Sub Function: Triggered by Cloud Scheduler to update cache
 */
exports.onUpdateCacheSchedule = onMessagePublished(
  {
    topic: "update-nft-cache",
    secrets: [MORALIS_API_KEY],
    timeoutSeconds: 540, // 9 minutes (max is usually around here for v2)
    memory: "512MiB",
  },
  async (event) => {
    console.log("Starting Cache Update...");
    const apiKey = MORALIS_API_KEY.value();
    if (!apiKey) throw new Error("MORALIS_API_KEY not set");

    try {
      const allNodes = await fetchAllFromMoralis(apiKey);
      console.log(`Fetched ${allNodes.length} items. Saving to Firestore...`);

      // Firestore limit is 1MB. 
      // 3500 items might exceed this if we save full objects.
      // We should strip unnecessary fields to be safe.
      const condensedNodes = allNodes.map(n => ({
        token_id: n.token_id,
        transaction_hash: n.transaction_hash,
        block_timestamp: n.block_timestamp,
        from_address: n.from_address,
        to_address: n.to_address,
        custom_image: n.custom_image,
        custom_name: n.custom_name,
        is_genesis_target: n.is_genesis_target,
        _custom_type: n._custom_type
      }));

      await db.collection("cache").doc("aoi_nfts").set({
        nodes: condensedNodes,
        last_update: admin.firestore.FieldValue.serverTimestamp()
      });

      console.log("Cache update complete.");
    } catch (error) {
      console.error("Cache update failed:", error);
      throw error;
    }
  }
);

/**
 * Main Fetcher Logic
 */
async function fetchAllFromMoralis(apiKey) {
  let allNodes = [];

  // 1. Genesis NFTs
  const genesisPath = path.join(__dirname, "genesis_nfts.json");
  const genesisTargets = JSON.parse(fs.readFileSync(genesisPath, "utf-8"));

  console.log(`Processing ${genesisTargets.length} Genesis items...`);
  for (const target of genesisTargets) {
    const chain = target.token_address.toLowerCase() === OpenseaPoly ? "polygon" : "eth";
    let success = false;

    try {
      // Try Transfers
      const transRes = await axios.get(`https://deep-index.moralis.io/api/v2/nft/${target.token_address}/${target.token_id}/transfers`, {
        params: { chain, format: "decimal", limit: 100 },
        headers: { "X-API-Key": apiKey }
      });

      if (transRes.data.result && transRes.data.result.length > 0) {
        transRes.data.result.forEach(tx => {
          allNodes.push({
            ...tx,
            custom_image: target.image_url,
            custom_name: target.name,
            is_genesis_target: true,
            _custom_type: "Genesis"
          });
        });
        success = true;
      }

      // Fallback: Owners
      if (!success) {
        const ownerRes = await axios.get(`https://deep-index.moralis.io/api/v2/nft/${target.token_address}/${target.token_id}/owners`, {
          params: { chain, format: "decimal" },
          headers: { "X-API-Key": apiKey }
        });

        if (ownerRes.data.result && ownerRes.data.result.length > 0) {
          const owner = ownerRes.data.result[0];
          allNodes.push({
            token_id: target.token_id,
            transaction_hash: `genesis-fallback-${target.token_id}`,
            block_timestamp: "2022-01-01T00:00:00.000Z",
            from_address: "0x0000000000000000000000000000000000000000",
            to_address: owner.owner_of,
            custom_image: target.image_url,
            custom_name: target.name,
            is_genesis_target: true,
            _custom_type: "Genesis"
          });
          success = true;
        }
      }
    } catch (err) {
      console.warn(`Failed Genesis item ${target.name}:`, err.message);
    }
    await sleep(200); // Rate limit safety
  }

  // 2. Generative Transfers
  console.log("Fetching Generative Transfers...");
  let cursor = null;
  do {
    try {
      const res = await axios.get(`https://deep-index.moralis.io/api/v2/nft/${ContractGenerative}/transfers`, {
        params: { chain: "eth", format: "decimal", limit: 100, cursor },
        headers: { "X-API-Key": apiKey }
      });

      if (res.data.result) {
        res.data.result.forEach(tx => {
          allNodes.push({ ...tx, _custom_type: "Generative" });
        });
      }
      cursor = res.data.cursor;
      await sleep(250);
    } catch (err) {
      console.error("Generative Transfer fetch error:", err.message);
      break;
    }
  } while (cursor);

  // 3. Generative Discovery (Full Contract Scan for missing owners)
  console.log("Fetching Generative Discovery...");
  const existingIds = new Set(allNodes.map(n => n.token_id));
  cursor = null;
  do {
    try {
      const res = await axios.get(`https://deep-index.moralis.io/api/v2/nft/${ContractGenerative}`, {
        params: { chain: "eth", format: "decimal", limit: 100, cursor },
        headers: { "X-API-Key": apiKey }
      });

      if (res.data.result) {
        res.data.result.forEach(nft => {
          if (!existingIds.has(nft.token_id)) {
            const meta = nft.metadata ? JSON.parse(nft.metadata) : {};
            allNodes.push({
              token_id: nft.token_id,
              transaction_hash: `discovery-${nft.token_id}`,
              block_timestamp: "2022-11-22T00:00:00.000Z",
              from_address: "0x0000000000000000000000000000000000000000",
              to_address: nft.owner_of,
              custom_name: nft.name || `CloneX #${nft.token_id}`,
              custom_image: meta.image,
              _custom_type: "Generative"
            });
            existingIds.add(nft.token_id);
          }
        });
      }
      cursor = res.data.cursor;
      await sleep(250);
    } catch (err) {
      console.error("Discovery fetch error:", err.message);
      break;
    }
  } while (cursor);

  return allNodes;
}
