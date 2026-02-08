# Firebase デプロイガイド (Deployment Guide)

Cloud RunからFirebase Hosting + Cloud Functionsへの移行手順です。

## 1. Cloud Shell でのデプロイ手順 (Recommended)

Google Cloud Shell を使うと、環境構築の手間なくデプロイできます。

### ステップ 1: Cloud Shell を開く
1. [Google Cloud Console](https://console.cloud.google.com/) にアクセスします。
2. 右上のターミナルアイコン [< >_] をクリックして Cloud Shell を起動します。
3. エディタモードを開くには「エディタを開く」ボタンをクリックします。

### ステップ 2: ログイン (Headless Mode)
Cloud Shell から Firebase にログインします。
```bash
firebase login --no-localhost
```
1. 表示されたURLをブラウザで開きます。
2. Googleアカウントでログインし、許可します。
3. 表示されたコードをコピーし、Cloud Shell に貼り付けます。

### ステップ 3: プロジェクトの選択
```bash
firebase use --add
```
- デプロイ先のプロジェクトIDを選択し、エイリアス（例: `default`）を入力します。

### ステップ 4: シークレットの設定
Moralis APIキーを Cloud Secret Manager に保存します。
```bash
# YOUR_MORALIS_API_KEY を実際のキーに置き換えて実行
printf "YOUR_MORALIS_API_KEY" | firebase functions:secrets:set MORALIS_API_KEY
```

### ステップ 5: 依存関係のインストール
`functions` フォルダのライブラリをインストールします。
```bash
cd functions
npm install
cd ..
```

### ステップ 6: デプロイ
```bash
firebase deploy
```

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
