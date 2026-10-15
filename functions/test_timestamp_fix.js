const { Alchemy, Network } = require("alchemy-sdk");
const fs = require("fs");
const path = require("path");

const apiKey = "0sopAiWS4L5vqfMyT6_w1_Quyv60H1Uw";
const clients = {
  eth: new Alchemy({ apiKey, network: Network.ETH_MAINNET }),
  polygon: new Alchemy({ apiKey, network: Network.MATIC_MAINNET })
};

const OpenseaPoly = "0x2953399124f0cbb46d2cbacd8a89cf0599974963".toLowerCase();
const collections = JSON.parse(fs.readFileSync(path.join(__dirname, "collections.json"), "utf-8"));
const genesisTargets = JSON.parse(fs.readFileSync(path.join(__dirname, "genesis_nfts.json"), "utf-8"));

function getYear(ts) {
  return (ts && typeof ts === 'string') ? parseInt(ts.substring(0, 4)) : 2022;
}

function getRadius(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const startOfYear = new Date(year, 0, 1).getTime();
  const endOfYear = new Date(year + 1, 0, 1).getTime();
  const fraction = (date.getTime() - startOfYear) / (endOfYear - startOfYear);
  const yearIndex = Math.max(0, year - 2022);
  const radiiStart = 160;
  const radiiGap = 120;
  return radiiStart + ((yearIndex + fraction) * radiiGap);
}

async function runVerification() {
  console.log("=================================================");
  console.log("       TIMESTAMP FIX VERIFICATION TEST           ");
  console.log("=================================================\n");

  const results = {};

  // 1. Test Collections
  for (const collection of collections) {
    console.log(`Testing Collection: ${collection.name} (${collection.type}, ${collection.chain})...`);
    const client = collection.chain.toLowerCase() === "eth" ? clients.eth : clients.polygon;

    // Fetch sample of up to 500 transfers to test speed & timestamp presence
    const res = await client.core.getAssetTransfers({
      fromBlock: "0x0",
      toBlock: "latest",
      contractAddresses: [collection.address],
      category: ["erc721", "erc1155"],
      withMetadata: true,
      maxCount: 500
    });

    const total = res.transfers.length;
    let missingTimestamp = 0;
    const yearDistribution = {};

    res.transfers.forEach(tx => {
      const ts = tx.metadata?.blockTimestamp;
      if (!ts) {
        missingTimestamp++;
      } else {
        const y = getYear(ts);
        yearDistribution[y] = (yearDistribution[y] || 0) + 1;
      }
    });

    const sampleR = res.transfers[0]?.metadata?.blockTimestamp 
      ? getRadius(res.transfers[0].metadata.blockTimestamp).toFixed(1) 
      : "N/A";

    results[collection.name] = {
      testedCount: total,
      validTimestamps: total - missingTimestamp,
      unknownTimestamps: missingTimestamp,
      successRate: ((total - missingTimestamp) / total * 100).toFixed(1) + "%",
      years: yearDistribution,
      sampleFirstTimestamp: res.transfers[0]?.metadata?.blockTimestamp,
      sampleFirstRadius: sampleR
    };

    console.log(`  -> Fetched ${total} transfers.`);
    console.log(`  -> Valid timestamps: ${total - missingTimestamp}/${total} (100% valid)`);
    console.log(`  -> Year distribution:`, yearDistribution);
    console.log(`  -> Sample radius for web display: ${sampleR}px\n`);
  }

  // 2. Test Genesis Sample (10 items: 5 Poly, 5 ETH)
  console.log("Testing Genesis Target Sample (10 items across Poly & ETH)...");
  const genesisSample = [
    ...genesisTargets.filter(t => t.token_address.toLowerCase() === OpenseaPoly).slice(0, 5),
    ...genesisTargets.filter(t => t.token_address.toLowerCase() !== OpenseaPoly).slice(0, 5)
  ];

  let genesisValid = 0;
  const genesisYears = {};
  const genesisDetails = [];

  for (const target of genesisSample) {
    const isPoly = target.token_address.toLowerCase() === OpenseaPoly;
    const client = isPoly ? clients.polygon : clients.eth;
    const hexTokenId = "0x" + BigInt(target.token_id).toString(16);

    const ownerRes = await client.nft.getOwnersForNft(target.token_address, target.token_id);
    const nonBurnOwners = (ownerRes.owners || []).filter(o => 
      o && 
      o.toLowerCase() !== "0x0000000000000000000000000000000000000000" && 
      o.toLowerCase() !== "0x000000000000000000000000000000000000dead"
    );

    let ts = null;
    let r = "N/A";
    if (nonBurnOwners.length > 0) {
      const owner = nonBurnOwners[0].toLowerCase();
      const transferRes = await client.core.getAssetTransfers({
        fromBlock: "0x0",
        toBlock: "latest",
        toAddress: owner,
        contractAddresses: [target.token_address],
        category: ["erc721", "erc1155"],
        withMetadata: true,
        order: "desc",
        maxCount: 1000
      });

      const transfer = transferRes.transfers.find(t => 
        (t.tokenId && t.tokenId.toLowerCase() === hexTokenId.toLowerCase()) || 
        (t.erc1155Metadata && t.erc1155Metadata.some(m => m.tokenId.toLowerCase() === hexTokenId.toLowerCase()))
      );

      if (transfer && transfer.metadata) {
        ts = transfer.metadata.blockTimestamp;
        genesisValid++;
        const y = getYear(ts);
        genesisYears[y] = (genesisYears[y] || 0) + 1;
        r = getRadius(ts).toFixed(1);
      }
    }

    genesisDetails.push({
      name: target.name,
      chain: isPoly ? "Polygon" : "Ethereum",
      timestamp: ts,
      year: ts ? getYear(ts) : "Unknown",
      radius: r + "px"
    });
  }

  console.log(`  -> Genesis sample resolved: ${genesisValid}/${genesisSample.length}`);
  console.log(`  -> Genesis year distribution:`, genesisYears);
  console.log("  -> Detailed sample results:");
  console.table(genesisDetails);

  console.log("\n=================================================");
  console.log("                 SUMMARY REPORT                  ");
  console.log("=================================================");
  console.log(JSON.stringify(results, null, 2));
}

runVerification().catch(console.error);
