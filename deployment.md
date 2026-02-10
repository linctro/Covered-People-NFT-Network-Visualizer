# Firebase デプロイガイド (Deployment Guide)

Firebase Hosting + Cloud Functions を使って、このプロジェクトを公開する手順です。

## 1. Cloud Shell でのデプロイ手順 (Recommended)

Google Cloud Shell を使うと、環境構築の手間なくデプロイできます。

### ステップ 1: Cloud Shell を開いて最新化する
1. [Google Cloud Console](https://console.cloud.google.com/) にアクセスします。
2. 右上のターミナルアイコン [< >_] をクリックして Cloud Shell を起動します。
3. **重要：CLIを最新版に更新します**（エラー回避のため）:
   ```bash
   npm install -g firebase-tools
   ```
4. もし「Billing API...」というエラーが出る場合は、以下のコマンドでAPIを強制的に有効化します:
   ```bash
   gcloud services enable cloudbilling.googleapis.com
   ```
5. エディタモードを開くには「エディタを開く」ボタンをクリックします。

### ステップ 2: ログイン (Headless Mode)
Cloud Shell から Firebase にログインします。
```bash
firebase login --no-localhost
```
1. 「Enable Gemini...」や「Allow Firebase to collect...」など、いくつか **(Y/n)** の質問が出ることがありますが、すべて **`y` または `n` を入力して Enter** で進めて大丈夫です。
2. 最後に表示される「Visit this URL...」の下の長いURLをコピーし、ブラウザで開きます。
3. Googleアカウントでログインし、許可します。
4. ブラウザに表示されたコードをコピーし、Cloud Shell に貼り付けて Enter を押します。

### ステップ 3: プロジェクトの選択
```bash
firebase use --add
```
- デプロイ先のプロジェクトIDを選択し、エイリアス（例: `default`）を入力します。
- **※ `Failed to get Firebase project` と出る場合**、以下の2点を確認してください：
  1. [Firebase Console](https://console.firebase.google.com/) にアクセスし、プロジェクト `covered-people-nft-vi` が表示されているか。表示されていない場合は「プロジェクトを追加」から既存の GCP プロジェクトを選択して Firebase を有効にしてください。
  2. `firebase login:list` を実行し、今使っているアカウントがプロジェクトの所有者であることを確認してください。
- **※ もし `Error: Failed to list Firebase projects` と出る場合**、直接設定します：
  ```bash
  firebase use covered-people-nft-vi --alias default
  ```

### ステップ 4: シークレットの設定
Moralis APIキーを Cloud Secret Manager に保存します。
```bash
# YOUR_MORALIS_API_KEY を実際のキーに置き換えて実行
printf "YOUR_MORALIS_API_KEY" | firebase functions:secrets:set MORALIS_API_KEY
```

### ステップ 5: 依存関係のインストール (Go)
`functions` フォルダで Go モジュールの依存関係を確認します。
```bash
cd functions
go mod tidy
cd ..
```

### ステップ 6: デプロイ
```bash
firebase deploy
```

### ステップ 7: キャッシュ更新ジョブの設定 (Cloud Scheduler)
24時間に1回 `UpdateCache` 関数を実行するジョブを作成します。
※ デプロイ後、GCPコンソールまたは以下のコマンドで設定します。

```bash
# Pub/Subトピックを作成 (まだなければ)
gcloud pubsub topics create update-nft-cache

# スケジューラを作成 (毎日午前9時 JST = UTC 0:00)
gcloud scheduler jobs create pubsub update-nft-cache-job \
  --schedule "0 0 * * *" \
  --topic update-nft-cache \
  --message-body "start" \
  --time-zone "Asia/Tokyo"
  
# Cloud Functionのトリガー設定 (Eventarc/PubSub) はデプロイ時に反映されますが、
# もし `UpdateCache` が Pub/Sub トリガーとして認識されていない場合は、
# firebase.json または gcloud コマンドで明示的にデプロイする必要がある場合があります。
```

- **※ 「How many days do you want to keep container images...」と聞かれた場合**:
  そのまま **Enter (または 1 を入力して Enter)** を押してください。これは古いビルドデータを自動で削除してストレージ料金を節約するための設定です。

---

## ローカル環境でのデプロイ (Local Deployment)

ローカルPCからデプロイする場合の手順です。

### 1. 前提条件 (Prerequisites)
- Node.js と Firebase CLI がインストールされていること。
  ```bash
  npm install -g firebase-tools
  firebase login
  ```

### 2. 環境変数の設定
Cloud Shell の手順と同様に、シークレットを設定します。
```bash
printf "YOUR_MORALIS_API_KEY" | firebase functions:secrets:set MORALIS_API_KEY
```

### 3. デプロイ
```bash
cd functions && npm install && cd ..
firebase deploy
```

---

## 動作確認 (Verification)

1. デプロイ完了後に表示される `Hosting URL` をクリックします。
2. サイトが正常に読み込まれるか確認します。
3. 開発者ツール (F12) の Network タブで、`/api/proxy` へのリクエストが成功 (Status 200) していることを確認します。

## トラブルシューティング

- **Error: project not found**: `firebase use --add` で正しいプロジェクトを選択しているか確認してください。
- **HTTP Error: 401/403**: `firebase login --reauth` で再ログインを試してください。
- **500 Internal Server Error**: APIキーが正しく設定されていない可能性があります。Cloud Console の Cloud Functions ログを確認してください。
