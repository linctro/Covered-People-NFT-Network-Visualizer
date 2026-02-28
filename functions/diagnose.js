/**
 * 診断スクリプト: 新コレクションのMoralis API応答をテスト
 * 
 * 使い方 (Cloud Shell):
 *   cd functions
 *   MORALIS_API_KEY="YOUR_KEY" node diagnose.js
 */

const axios = require("axios");
const fs = require("fs");
const path = require("path");

const API_KEY = process.env.MORALIS_API_KEY;

if (!API_KEY) {
  console.error("❌ MORALIS_API_KEY 環境変数が設定されていません。");
  console.error('   実行方法: MORALIS_API_KEY="あなたのキー" node diagnose.js');
  process.exit(1);
}

const collections = JSON.parse(
  fs.readFileSync(path.join(__dirname, "collections.json"), "utf-8")
);

async function diagnose() {
  console.log("=== NFT Collection 診断ツール ===\n");
  console.log(`collections.json に ${collections.length} コレクションが定義されています:\n`);

  for (const col of collections) {
    console.log(`--- ${col.name} ---`);
    console.log(`  アドレス: ${col.address}`);
    console.log(`  チェーン: ${col.chain}`);
    console.log(`  タイプ:   ${col.type}`);

    try {
      // 1. コレクション情報の取得テスト
      const infoRes = await axios.get(
        `https://deep-index.moralis.io/api/v2/nft/${col.address}`,
        {
          params: { chain: col.chain, format: "decimal", limit: 1 },
          headers: { "X-API-Key": API_KEY },
        }
      );
      const total = infoRes.data.total || infoRes.data.result?.length || 0;
      console.log(`  ✅ NFT一覧取得: ${total} 件（total）、result: ${infoRes.data.result?.length || 0} 件`);

      // 2. トランスファー取得テスト（2022年1月1日以降）
      const transferRes = await axios.get(
        `https://deep-index.moralis.io/api/v2/nft/${col.address}/transfers`,
        {
          params: {
            chain: col.chain,
            format: "decimal",
            limit: 5,
            from_date: "2022-01-01T00:00:00.000Z",
          },
          headers: { "X-API-Key": API_KEY },
        }
      );
      const transferCount = transferRes.data.total || transferRes.data.result?.length || 0;
      console.log(`  ✅ トランスファー取得: total ${transferCount} 件、この取得で ${transferRes.data.result?.length || 0} 件`);

      if (transferRes.data.result && transferRes.data.result.length > 0) {
        const sample = transferRes.data.result[0];
        console.log(`  📋 サンプル: token_id=${sample.token_id}, from=${sample.from_address?.substring(0, 10)}..., to=${sample.to_address?.substring(0, 10)}...`);
      } else {
        console.log(`  ⚠️  トランスファーが0件です。アドレスが正しいか確認してください。`);
      }

    } catch (err) {
      console.log(`  ❌ エラー: ${err.response?.status || err.code} - ${err.response?.data?.message || err.message}`);
      if (err.response?.status === 400) {
        console.log(`  💡 アドレスが無効か、このチェーンに存在しない可能性があります。`);
      } else if (err.response?.status === 401) {
        console.log(`  💡 APIキーが無効です。`);
      }
    }
    console.log("");
  }

  // 3. デプロイ確認: manualUpdateCache のバージョンチェック
  console.log("--- デプロイ状態チェック ---");
  try {
    const res = await axios.get(
      "https://us-central1-covered-people-nft-vi.cloudfunctions.net/manualUpdateCache",
      { timeout: 300000 } // 5分タイムアウト
    );
    console.log(`  レスポンス: ${JSON.stringify(res.data, null, 2)}`);
    if (res.data.version === "multi-collection-v2") {
      console.log("  ✅ 最新のCloud Functionsがデプロイされています。");
    } else {
      console.log("  ❌ Cloud Functions が古いバージョンです！ firebase deploy を実行してください。");
    }
  } catch (err) {
    console.log(`  ⚠️  Cloud Function 呼び出しエラー: ${err.message}`);
    console.log("  （5分以上かかる場合はタイムアウトします。Cloud Functions ログを確認してください。）");
  }

  console.log("\n=== 診断完了 ===");
}

diagnose();
