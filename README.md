# English Word Trainer

日本語から英文・英単語を入力して覚える、バックエンドなしの学習用PWAです。

## 使い方

`index.html` をブラウザで開くと動きます。スマホで安定して使う場合は、GitHub Pagesなどの静的ホスティングに配置してください。

## モード

- 例文モード: 日本語例文を見て英文を入力します。
- 英単語モード: 日本語の意味を見て英単語を入力します。ヒントは1文字ずつ表示されます。
- 今日の英単語: 学習状況から選ばれた英単語を、紙に手書きするテスト形式で練習できます。
- 写真答え合わせ: 今日の英単語の解答ページで、番号付きの手書き答案写真をCloudflare Worker経由で読み取れます。

写真答え合わせはOpenAI APIを使うため、Cloudflare Workerの設定とAPIキー登録が必要です。答案は `1 apple`、`2 reserve` のように番号付きで縦に書くと照合しやすくなります。

## Cloudflare Worker

`worker/` に手書き認識用のCloudflare Workerがあります。

```powershell
cd worker
npm install
npx wrangler deploy
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ACCESS_TOKEN
```

Worker URLの末尾に `/recognize-handwriting` を付けたURLと、`ACCESS_TOKEN` の値をアプリ内の「写真で答え合わせ」設定欄に保存してください。APIキーや `.dev.vars` はGitHubに入れないでください。

## CSV/TSV形式

共通の必須列は `ja` と `en` です。取り込み画面で、例文として入れるか英単語として入れるかを選びます。

```csv
ja,en,section,tags
りんご,apple,食べ物,基礎
私は毎朝英語を音読します。,I read English aloud every morning.,例文,習慣
```

## 保存と履歴

データはブラウザの端末内ストレージに保存されます。バックアップはJSONで書き出し・読み込みできます。

進捗画面では日付ごとの学習履歴を一覧表示し、CSVとして出力できます。
