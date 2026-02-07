package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
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

	// Create cache directory
	cacheDir := "api_cache"
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		log.Printf("Warning: Failed to create cache directory: %v", err)
	}

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

		// --- Caching Logic Start ---
		// 1. Generate Cache Key (SHA256 of JSON body)
		// Go's json.Marshal sorts map keys, so it's deterministic enough for this.
		reqBytes, _ := json.Marshal(reqBody)
		hash := sha256.Sum256(reqBytes)
		cacheKey := hex.EncodeToString(hash[:])
		cachePath := filepath.Join(cacheDir, cacheKey+".json")

		// 2. Check for Valid Cache
		if info, err := os.Stat(cachePath); err == nil {
			// Cache exists, check age
			if time.Since(info.ModTime()) < 24*time.Hour {
				// Cache is valid (< 24h)
				log.Printf("Serving from cache: %s", reqBody.Endpoint)
				data, err := os.ReadFile(cachePath)
				if err == nil {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusOK)
					w.Write(data)
					return
				}
				// If read fails, fall through to fetch
			}
		}
		// --- Caching Logic End ---

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

		// Read response body for caching
		bodyBytes, err := io.ReadAll(resp.Body)
		if err != nil {
			log.Printf("Error reading response body: %v", err)
			http.Error(w, "Error reading response", http.StatusInternalServerError)
			return
		}

		// Save to Cache
		if err := os.WriteFile(cachePath, bodyBytes, 0644); err != nil {
			log.Printf("Warning: Failed to write cache: %v", err)
		} else {
			log.Printf("Cached response for: %s", reqBody.Endpoint)
		}

		// Copy success response back to frontend
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		w.Write(bodyBytes)
	})

	log.Printf("Listening on port %s", port)
	log.Printf("Open http://localhost:%s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal(err)
	}
}
