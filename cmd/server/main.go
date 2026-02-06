package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
)

func main() {
	// Determine port
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// 1. Get API Key securely from Environment Variable
	// TrimSpace removes any accidental newlines or spaces from the secret
	rawKey := os.Getenv("MORALIS_API_KEY")
	apiKey := strings.TrimSpace(rawKey)

	if apiKey == "" {
		log.Println("Warning: MORALIS_API_KEY is not set (empty). API calls will fail.")
	} else {
		// Log length only for security
		log.Printf("Moralis API Key loaded successfully. Length: %d characters", len(apiKey))
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
			log.Printf("Proxy Error: Failed to reach Moralis API: %v", err)
			http.Error(w, "Failed to reach Moralis API", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		// Check for upstream errors and log them
		if resp.StatusCode != http.StatusOK {
			bodyBytes, _ := io.ReadAll(resp.Body)
			log.Printf("Moralis API Error: Status %d, Body: %s", resp.StatusCode, string(bodyBytes))
			
			// Forward the error status and body to frontend for debugging
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(resp.StatusCode)
			w.Write(bodyBytes)
			return
		}

		// Copy success response back to frontend
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
