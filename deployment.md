# Google Cloud デプロイメントガイド (初心者向け)

Google Cloud が初めての方でも簡単にプロジェクトを公開できるよう、**Cloud Shell**（ブラウザ上で使えるターミナル）を使った手順をまとめました。これなら面倒なツールのインストールは不要です。

## 前提条件

1.  **Google Cloud アカウント**を持っていること。
2.  **プロジェクト**が作成されていること（まだの場合は [コンソール](https://console.cloud.google.com/) から「プロジェクトの作成」を行ってください）。
3.  **Moralis API Key** が手元にあること。

---

## 手順 1: Cloud Shell を開く

1.  [Google Cloud Console](https://console.cloud.google.com/) にアクセスします。
2.  画面右上の **ターミナルアイコン**（[>_] のようなボタン）をクリックして「Cloud Shell」を起動します。
3.  画面下部に黒い画面（ターミナル）が表示されます。

## 手順 2: コードをアップロードする

Cloud Shell のエディタを使ってコードを作成するか、既存の Git リポジトリからクローンします。
今回は、このプロジェクトのコードが既にある前提で進めます（Gitリポジトリ経由が一番簡単です）。

```bash
# Gitリポジトリからクローンする場合（例）
git clone <あなたのリポジトリURL>
cd Covered-People-NFT-Network-Visualizer
```

※ もしローカルにあるファイルをアップロードしたい場合は、Cloud Shell ターミナルの右上にある「︙」メニューから「アップロード」を選んで、ファイル一式をアップロードしてください。

## 手順 3: デプロイ準備（APIの有効化）

Cloud Run と Secret Manager を使うための設定を有効にします。以下のコマンドを Cloud Shell でコピー＆ペーストして実行してください。

```bash
# プロジェクトIDを設定（your-project-id は実際のIDに置き換えてください）
gcloud config set project your-project-id

# 必要なサービスを有効化
gcloud services enable run.googleapis.com \
    secretmanager.googleapis.com \
    cloudbuild.googleapis.com
```

## 手順 4: APIキーを安全に保存 (Secret Manager)

APIキーをコードに直接書くのは危険なので、「Secret Manager」という金庫のような場所に保存します。

1.  以下のコマンドを実行します。
    ```bash
    printf "あなたのMORALIS_API_KEYをここに貼り付け" | gcloud secrets create moralis-api-key --data-file=-
    ```
    ※ `あなたのMORALIS_API_KEY...` の部分を本物のキーに書き換えてから実行してください。

2.  確認メッセージが出たら成功です。これでキーが `moralis-api-key` という名前でクラウド上に安全に保存されました。

## 手順 5: Cloud Run へデプロイ

いよいよアプリを公開します。1つのコマンドで完了します。

```bash
gcloud run deploy covered-people-visualizer \
  --source . \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --set-secrets="MORALIS_API_KEY=moralis-api-key:latest"
```

### コマンドの解説
- `--source .`: 現在のフォルダのコードを使ってビルド・デプロイします。
- `--region asia-northeast1`: 東京リージョンを使います。
- `--allow-unauthenticated`: 誰でもアクセスできるようにします（Web公開用）。
- `--set-secrets`: 手順4で保存した `moralis-api-key` を読み込み、アプリ内で `MORALIS_API_KEY` という環境変数として使えるようにします。

## 手順 6: 確認

コマンドが完了すると、最後に URL が表示されます。

```text
Service [covered-people-visualizer] has been deployed and is serving 100 percent of traffic.
Service URL: https://covered-people-visualizer-xxxxx-an.a.run.app
```

この URL をクリックして、アプリが正常に動作し、データが表示されることを確認してください。

---

## 更新したいときは？

コードを修正して再デプロイしたい場合は、**手順 5 のコマンドをもう一度実行するだけ**です。

```bash
gcloud run deploy covered-people-visualizer --source . --region asia-northeast1
```
※ APIキーの設定などは引き継がれるので、オプションは省略できます。
