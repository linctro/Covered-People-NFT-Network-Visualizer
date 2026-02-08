const functions = require("firebase-functions");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors")({ origin: true });

// Define the Cloud Function
// We use runWith to set secrets and memory if needed
// Assuming the secret name in Google Cloud Secret Manager is 'MORALIS_API_KEY'
// Note: You must grant the App Engine default service account access to this secret.
exports.apiProxy = functions
  .runWith({
    secrets: ["MORALIS_API_KEY"],
    // Keep 1 instance warm to reduce cold starts if budget allows, otherwise remove minInstances
    // minInstances: 1, 
  })
  .https.onRequest((req, res) => {
    // 1. Enable CORS
    cors(req, res, async () => {
      // 2. Validate Request Method
      if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return;
      }

      // 3. Get API Key from Secret Manager
      // In Cloud Functions gen 1/2 with secret integration, it's available in process.env
      const apiKey = process.env.MORALIS_API_KEY;
      if (!apiKey) {
        console.error("MORALIS_API_KEY not set.");
        res.status(500).send("Server Configuration Error");
        return;
      }

      // 4. Parse Request Body
      const { endpoint, params } = req.body;
      if (!endpoint) {
        res.status(400).send("Missing endpoint");
        return;
      }

      // 5. Caching Strategy
      // Since this is a public visualization, we can cache aggressive at the edge (CDN).
      // 'public' = cacheable by CDNs
      // 's-maxage' = how long CDN keeps it (86400s = 24h)
      // 'max-age' = how long browser keeps it
      // Note: This replaces the local file system cache from the Go server.
      res.set("Cache-Control", "public, max-age=3600, s-maxage=86400");

      try {
        // 6. Build Target URL
        const baseURL = "https://deep-index.moralis.io/api/v2";
        // Ensure endpoint starts with / and doesn't traverse up
        const safeEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;

        // 7. Make Request to Moralis
        const response = await axios.get(baseURL + safeEndpoint, {
          params: params,
          headers: {
            "X-API-Key": apiKey,
            "accept": "application/json",
          },
        });

        // 8. Return Response
        res.status(response.status).json(response.data);

      } catch (error) {
        console.error("Moralis API Error:", error.message);
        if (error.response) {
          // Forward upstream error
          res.status(error.response.status).send(error.response.data);
        } else {
          res.status(500).send("Internal Server Error");
        }
      }
    });
  });
