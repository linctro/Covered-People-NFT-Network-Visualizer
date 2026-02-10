package function

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"cloud.google.com/go/firestore"
	"github.com/GoogleCloudPlatform/functions-framework-go/functions"
	"github.com/cloudevents/sdk-go/v2/event"
)

//go:embed genesis_nfts.json
var genesisNFTsJSON []byte

func init() {
	functions.HTTP("GetNFTs", GetNFTs)
	functions.CloudEvent("UpdateCache", UpdateCache)
}

// Structs for internal processing
type GenesisTarget struct {
	TokenAddress string          `json:"token_address"`
	TokenID      string          `json:"token_id"`
	Name         string          `json:"name"`
	ImageURL     string          `json:"image_url"`
	Metadata     json.RawMessage `json:"metadata"`
}

type CacheData struct {
	Nodes      []interface{} `json:"nodes" firestore:"nodes"`
	LastUpdate time.Time     `json:"last_update" firestore:"last_update"`
}

// Moralis Response Wrappers
type MoralisResponse struct {
	Result []interface{} `json:"result"`
	Cursor string        `json:"cursor"`
}

type MoralisOwner struct {
	OwnerOf string `json:"owner_of"`
}

// GetNFTs is the HTTP handler for clients
func GetNFTs(w http.ResponseWriter, r *http.Request) {
	// CORS Headers
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "GET")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Max-Age", "3600")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx := context.Background()
	projectID := os.Getenv("GOOGLE_CLOUD_PROJECT")
	if projectID == "" {
		// Fallback for local testing if env not set, though Firestore client usually needs it
		projectID = os.Getenv("GCLOUD_PROJECT")
	}

	client, err := firestore.NewClient(ctx, projectID)
	if err != nil {
		log.Printf("Firestore init error: %v", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	defer client.Close()

	doc, err := client.Collection("cache").Doc("aoi_nfts").Get(ctx)
	if err != nil {
		log.Printf("Firestore read error: %v", err)
		http.Error(w, "Cache not found", http.StatusNotFound)
		return
	}

	var data CacheData
	if err := doc.DataTo(&data); err != nil {
		log.Printf("Data parse error: %v", err)
		http.Error(w, "Data parse error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	json.NewEncoder(w).Encode(data)
}

// UpdateCache is the Background Function
func UpdateCache(ctx context.Context, e event.Event) error {
	log.Println("Starting Cache Update...")

	apiKey := os.Getenv("MORALIS_API_KEY")
	if apiKey == "" {
		return fmt.Errorf("MORALIS_API_KEY is not set")
	}

	allNodes, err := fetchAllFromMoralis(apiKey)
	if err != nil {
		log.Printf("Fetch error: %v", err)
		return err
	}

	projectID := os.Getenv("GOOGLE_CLOUD_PROJECT")
	client, err := firestore.NewClient(ctx, projectID)
	if err != nil {
		return fmt.Errorf("firestore client error: %v", err)
	}
	defer client.Close()

	cacheData := CacheData{
		Nodes:      allNodes,
		LastUpdate: time.Now(),
	}

	// Firestore document size limit is 1MB.
	// If Nodes are too many (e.g. 5000+ items x 0.5KB = 2.5MB), this will fail.
	// We might need to split or compress.
	// Logic from script.js implies ~3533 items.
	// If 1 item is ~300 bytes, 3500 * 300 = 1,050,000 bytes. Very close to limit.
	// We should strip unnecessary fields from Moralis response to save space if possible.
	// Or, safer: Store in a subcollection or multiple docs.
	// But `GetNFTs` needs to be fast.
	// Let's try to store as one doc first. If it fails, we need a Plan B (Compression or Split).
	// Plan B: Gzip the JSON and store as Blob? (Firestore supports bytes).
	// Frontend would need to decompress. That adds complexity.
	// Alternative: Store just essential fields.

	// Let's try to strip fields in `fetchAllFromMoralis` by mapping to a smaller struct or map.

	_, err = client.Collection("cache").Doc("aoi_nfts").Set(ctx, cacheData)
	if err != nil {
		log.Printf("Error saving to Firestore: %v", err)
		return err
	}

	log.Printf("Cache updated successfully. Total items: %d", len(allNodes))
	return nil
}

// --- Fetch Logic ---

const (
	ContractIssuer     = "0x91f5914a70c1f5d9fae0408ae16f1c19758337eb"
	ContractGenerative = "0x0e6a70cb485ed3735fa2136e0d4adc4bf5456f93"
	// Opensea contracts used in Genesis check
	OpenseaEth  = "0x495f947276749ce646f68ac8c248420045cb7b5e"
	OpenseaPoly = "0x2953399124f0cbb46d2cbacd8a89cf0599974963"
)

func fetchAllFromMoralis(apiKey string) ([]interface{}, error) {
	var allNodes []interface{}

	// 1. Genesis NFTs
	var genesisTargets []GenesisTarget
	if err := json.Unmarshal(genesisNFTsJSON, &genesisTargets); err != nil {
		return nil, fmt.Errorf("failed to parse embedded genesis json: %v", err)
	}

	log.Printf("Processing %d Genesis items...", len(genesisTargets))

	client := &http.Client{Timeout: 30 * time.Second}

	for _, target := range genesisTargets {
		// Determine chain
		chain := "eth"
		if target.TokenAddress == OpenseaPoly {
			chain = "polygon"
		}

		success := false

		// 1.1 Try Transfers
		// "endpoint": `/nft/${target.token_address}/${target.token_id}/transfers`,
		url := fmt.Sprintf("https://deep-index.moralis.io/api/v2/nft/%s/%s/transfers?chain=%s&format=decimal&limit=100",
			target.TokenAddress, target.TokenID, chain)

		transfers, err := fetchMoralisList(client, apiKey, url)
		if err == nil && len(transfers) > 0 {
			for _, t := range transfers {
				tMap := t.(map[string]interface{})
				tMap["custom_image"] = target.ImageURL
				tMap["custom_name"] = target.Name
				tMap["is_genesis_target"] = true
				tMap["_custom_type"] = "Genesis" // Helper for frontend
				allNodes = append(allNodes, tMap)
			}
			success = true
		}

		// 1.2 Fallback: Try Owners
		if !success {
			// "endpoint": `/nft/${target.token_address}/${target.token_id}/owners`,
			urlOwner := fmt.Sprintf("https://deep-index.moralis.io/api/v2/nft/%s/%s/owners?chain=%s&format=decimal",
				target.TokenAddress, target.TokenID, chain)

			owners, err := fetchMoralisList(client, apiKey, urlOwner)
			if err == nil && len(owners) > 0 {
				ownerData := owners[0].(map[string]interface{})
				pseudoTx := map[string]interface{}{
					"token_id":          target.TokenID,
					"transaction_hash":  fmt.Sprintf("genesis-fallback-%s", target.TokenID),
					"block_timestamp":   "2022-01-01T00:00:00.000Z",
					"from_address":      "0x0000000000000000000000000000000000000000",
					"to_address":        ownerData["owner_of"],
					"value":             "0",
					"custom_image":      target.ImageURL,
					"custom_name":       target.Name,
					"is_genesis_target": true,
					"_custom_type":      "Genesis",
				}
				allNodes = append(allNodes, pseudoTx)
				success = true
			}
		}

		if !success {
			log.Printf("Failed to fetch Genesis item: %s", target.Name)
		}

		// Rate limit sleep (approx 25 CU/s limit? 5 req/s?)
		// fetchMoralisList handles one request.
		// We should sleep a bit.
		time.Sleep(200 * time.Millisecond)
	}

	// 2. Generative NFTs
	log.Println("Fetching Generative Transfers...")
	// We need to fetch ALL pages.
	genURL := fmt.Sprintf("https://deep-index.moralis.io/api/v2/nft/%s/transfers?chain=eth&format=decimal&limit=100", ContractGenerative)

	// Loop for pagination
	cursor := ""
	for {
		pagedURL := genURL
		if cursor != "" {
			pagedURL += "&cursor=" + cursor
		}

		res, nextCursor, err := fetchMoralisPage(client, apiKey, pagedURL)
		if err != nil {
			log.Printf("Error fetching generative page: %v", err)
			break // or return err
		}

		for _, t := range res {
			tMap := t.(map[string]interface{})
			tMap["_custom_type"] = "Generative"
			allNodes = append(allNodes, tMap)
		}

		if nextCursor == "" {
			break
		}
		cursor = nextCursor
		time.Sleep(250 * time.Millisecond)
	}

	// 3. Generative Discovery (Owners of alltokens)
	// script.js does a "Scan" of the contract to find owners of items that have no transfer history?
	// Or just to get metadata?
	// script.js `fetchGenerativeDiscovery` calls `/nft/{address}` (getContractNFTs).
	// This returns all NFTs and their owners.
	// This helps populate nodes that might have been minted but maybe transfer history API missed them (unlikely)
	// OR simply to get the current state and metadata.
	// script.js logic: "Only add if not already captured by history".
	// We can replicate this.
	// Since we are rebuilding the cache, we can just fetch ALL NFTs from the contract,
	// and if we find one that we haven't seen in transfers(?), add it.
	// Actually, `getContractNFTs` returns Owner + Metadata.
	// If we just use this list + the transfer list, we have everything.
	// Let's do it.

	log.Println("Fetching Generative Contract NFTs (Discovery)...")
	discURL := fmt.Sprintf("https://deep-index.moralis.io/api/v2/nft/%s?chain=eth&format=decimal&limit=100", ContractGenerative)
	cursor = ""

	// Track existing TokenIDs to avoid duplicates or to match logic
	// In Go, it's expensive to map 3500 items every time? No, it's fast.
	existingIDs := make(map[string]bool)
	for _, n := range allNodes {
		m := n.(map[string]interface{})
		if tid, ok := m["token_id"].(string); ok {
			existingIDs[tid] = true
		}
	}

	for {
		pagedURL := discURL
		if cursor != "" {
			pagedURL += "&cursor=" + cursor
		}

		res, nextCursor, err := fetchMoralisPage(client, apiKey, pagedURL)
		if err != nil {
			log.Printf("Error fetching discovery page: %v", err)
			break
		}

		for _, item := range res {
			itemMap := item.(map[string]interface{})
			tid, _ := itemMap["token_id"].(string)

			if !existingIDs[tid] {
				// Create pseudo transaction like script.js
				pseudoTx := map[string]interface{}{
					"token_id":         tid,
					"transaction_hash": fmt.Sprintf("discovery-%s", tid),
					"block_timestamp":  "2022-11-22T00:00:00.000Z",
					"from_address":     "0x0000000000000000000000000000000000000000",
					"to_address":       itemMap["owner_of"],
					"value":            "0",
					"custom_name":      fmt.Sprintf("CloneX #%s", tid),
					"_custom_type":     "Generative",
				}

				// Metadata parsing
				if metaStr, ok := itemMap["metadata"].(string); ok && metaStr != "" {
					var metaObj map[string]interface{}
					if err := json.Unmarshal([]byte(metaStr), &metaObj); err == nil {
						pseudoTx["custom_image"] = metaObj["image"]
					}
				}

				allNodes = append(allNodes, pseudoTx)
				existingIDs[tid] = true
			}
		}

		if nextCursor == "" {
			break
		}
		cursor = nextCursor
		time.Sleep(250 * time.Millisecond)
	}

	return allNodes, nil
}

// Helpers

func fetchMoralisPage(client *http.Client, apiKey, url string) ([]interface{}, string, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Add("X-API-Key", apiKey)
	req.Header.Add("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, "", fmt.Errorf("moralis api error: %d", resp.StatusCode)
	}

	var res MoralisResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, "", err
	}
	return res.Result, res.Cursor, nil
}

func fetchMoralisList(client *http.Client, apiKey, url string) ([]interface{}, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Add("X-API-Key", apiKey)
	req.Header.Add("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}

	var res MoralisResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, err
	}
	return res.Result, nil
}
