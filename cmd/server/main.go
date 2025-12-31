package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
)

func main() {
	// Determine port
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// 1. Get API Key securely from Environment Variable
	apiKey := os.Getenv("MORALIS_API_KEY")
	if apiKey == "" {
		log.Println("Warning: MORALIS_API_KEY is not set. API calls will fail.")
	} else {
		log.Println("Moralis API Key loaded successfully.")
	}

	// Serve static files
	staticDir := "static"
	if _, err := os.Stat(staticDir); os.IsNotExist(err) {
		log.Printf("Warning: 'static' directory not found.")
	}
	fs := http.FileServer(http.Dir(staticDir))
	http.Handle("/", fs)

	// 2. API Proxy Endpoint
	http.HandleFunc("/api/proxy", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Read request body from frontend
		// Expected JSON: { "endpoint": "/nft/...", "params": { ... } }
		var reqBody struct {
			Endpoint string            `json:"endpoint"`
			Params   map[string]string `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
			http.Error(w, "Invalid JSON", http.StatusBadRequest)
			return
		}

		// Construct Moralis API URL
		baseURL := "https://deep-index.moralis.io/api/v2"
		// Note: Moralis V2 API url structure. Adjust if using a different version.
		// e.g., https://deep-index.moralis.io/api/v2/0x.../nft

		targetURL := baseURL + reqBody.Endpoint

		// Add query parameters
		if len(reqBody.Params) > 0 {
			targetURL += "?"
			for k, v := range reqBody.Params {
				targetURL += k + "=" + v + "&"
			}
		}

		// Create request to Moralis
		proxyReq, err := http.NewRequest("GET", targetURL, nil)
		if err != nil {
			http.Error(w, "Failed to create request", http.StatusInternalServerError)
			return
		}

		// Add Secure Headers
		proxyReq.Header.Set("X-API-Key", apiKey)
		proxyReq.Header.Set("Content-Type", "application/json")
		proxyReq.Header.Set("accept", "application/json")

		// Execute request
		client := &http.Client{}
		resp, err := client.Do(proxyReq)
		if err != nil {
			http.Error(w, "Failed to reach Moralis API", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		// Copy response back to frontend
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
	})

	log.Printf("Listening on port %s", port)
	log.Printf("Open http://localhost:%s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal(err)
	}
}
