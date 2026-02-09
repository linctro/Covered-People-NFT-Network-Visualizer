const { onRequest } = require("firebase-functions/v2/https");
const axios = require("axios");
const cors = require("cors")({ origin: true });
const { defineSecret } = require("firebase-functions/params");

// Define the secret
const MORALIS_API_KEY = defineSecret("MORALIS_API_KEY");

exports.apiProxy = onRequest(
  {
    secrets: [MORALIS_API_KEY],
    cors: true, // v2 has built-in CORS support
    maxInstances: 10,
  },
  async (req, res) => {
    // 1. Validate Request Method
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    // 2. Get API Key from Parameter
    const apiKey = MORALIS_API_KEY.value();
    if (!apiKey) {
      console.error("MORALIS_API_KEY not set.");
      res.status(500).send("Server Configuration Error");
      return;
    }

    // 3. Parse Request Body
    const { endpoint, params } = req.body;
    if (!endpoint) {
      res.status(400).send("Missing endpoint");
      return;
    }

    // 4. Caching Strategy
    res.set("Cache-Control", "public, max-age=3600, s-maxage=86400");

    try {
      // 5. Build Target URL
      const baseURL = "https://deep-index.moralis.io/api/v2";
      const safeEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;

      // 6. Make Request to Moralis
      const response = await axios.get(baseURL + safeEndpoint, {
        params: params,
        headers: {
          "X-API-Key": apiKey,
          "accept": "application/json",
        },
      });

      // 7. Return Response
      res.status(response.status).json(response.data);

    } catch (error) {
      console.error("Moralis API Error:", error.message);
      if (error.response) {
        res.status(error.response.status).send(error.response.data);
      } else {
        res.status(500).send("Internal Server Error");
      }
    }
  }
);
