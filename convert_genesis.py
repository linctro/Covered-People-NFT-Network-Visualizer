
import csv
import json
import os

# Define file paths
parts = [
    'static/data/genesis_part1.csv',
    'static/data/genesis_part2.csv',
    'static/data/genesis_part3.csv',
    'static/data/genesis_part4.csv'
]
output_file = 'static/data/genesis_nfts.json'

all_rows = []

# Read parts
for i, part in enumerate(parts):
    with open(part, 'r', encoding='utf-8') as f:
        # Part 1 has header, others do not.
        if i == 0:
            reader = csv.DictReader(f)
            fieldnames = reader.fieldnames
            for row in reader:
                all_rows.append(row)
        else:
            # Use fieldnames from part 1
            reader = csv.DictReader(f, fieldnames=fieldnames)
            for row in reader:
                all_rows.append(row)

# Processing
nfts = []
for row in all_rows:
    # CSV Columns: No,Token ID,Name,Image URL,Contract Address
    # We ignore 'No'
    # We want to format for our app. 
    # Based on existing script logic, the app expects data that looks somewhat like Moralis API response?
    # Or we can adapt script.js to read this specific format.
    # Let's create a clean format and adapt script.js.
    
    # Contract Address might have uppercase, normalize to lowercase
    contract = row.get("Contract Address", "").lower()
    token_id = row.get("Token ID", "")
    
    # Check if this token belongs to known contracts in config? 
    # Actually, the user provided list contains items from different contracts (OpenSea shared etc).
    # We should keep valid ones.
    
    nft = {
        "token_address": contract,
        "token_id": token_id,
        "name": row.get("Name", ""),
        "image_url": row.get("Image URL", ""),
        # Add metadata object to mimic API structure if easier, or just flat
        "metadata": {
            "name": row.get("Name", ""),
            "image": row.get("Image URL", "")
        }
    }
    nfts.append(nft)

# Write JSON
with open(output_file, 'w', encoding='utf-8') as f:
    json.dump(nfts, f, indent=2, ensure_ascii=False)

print(f"Successfully created {output_file} with {len(nfts)} items.")
