# エンジニアリングコンテキスト（自動注入 — /restart で更新反映）

---

## オーナー

ippanshimin99。非技術者出身の個人開発者。判断が速くフィードバックが的確。
- 「ラリーを少なく」「イメージを超える実装」を求める
- 作業中は日本語で補足すること
- 質問は1問・選択肢付きで。文脈から分かることは聞かない
- 完了報告と同時に残課題を自ら列挙する

---

## 開発ワークフロー厳格ルール

**Rule 0 — メモリ自動学習**
区切りごとに /Users/oniku/.claude/projects/-Users-oniku/memory/ を更新する。
新知見・バグ・ユーザー反応を発見したら指示なく即書く。context.md も同時更新。

**Rule 1** — コード変更前に必ず git commit（未コミット変更があれば先に処理）

**Rule 2 — TDD First**
新規ロジック: テスト作成（Red）→ 実装（Green）→ テスト成功確認の順を守る

**Regression Prevention** — 変更前に 既存機能/API/UI/認証/課金 への影響を必ずシミュレート

**Rule 3** — テスト失敗時は 原因分析→修正→再実行 を全GREENまで繰り返す。止まらない

**Rule 4 — Full Verification（コミット前必須）**
npm run test（全GREEN）/ npm run lint（エラー0）/ npm run build（成功）

**Rule 5** — Test/Lint/Build 全成功後のみコミット可能

**完了宣言禁止条件**: Build/Lint/Test/UI/モバイル/API/認証/課金/Git Commit/メモリ更新 のいずれか未完了

---

## セキュリティ基準

- 秘密情報比較は crypto.timingSafeEqual 必須（事前にSHA-256で長さ統一）
- ユーザー入力による直接認証禁止。OAuth/短命トークン/ワンタイムコードのみ
- Supabase: 全テーブルRLS必須。サーバー操作は supabaseAdmin（service_role）のみ

---

## プロジェクト一覧

### 01_DailyPulse_LINE（最重要・本番稼働中）
- 役割: LINEにAI要約ニュースを毎日配信するSaaS。Free / Pro ¥680/月
- 本番: https://news.daily-pulse.app
- ローカル: /Users/oniku/Claude-Project/01_DailyPulse_LINE/
- GitHub: https://github.com/ippanshimin99/dailypulse-line
- スタック: Next.js 15 App Router / Supabase Tokyo / Stripe本番 / LINE Messaging API / Claude haiku
- Cron: 15分ごと配信 / 毎日2:00 UTC DBクリーンアップ
- DBテーブル: user_settings / delivered_stories / line_connect_codes / login_tokens（全RLS有効）

**クリティカルパス:**
Cron(15分) → JST時刻で対象ユーザー抽出 → fetchAllNews(RSS) → enrichNews(haiku) →
filterNewStories(SHA-256重複排除) → createLoginToken → buildNewsCarousel(Flex Message) →
sendFlexMessage(LINE API) → markDelivered

**アーキテクチャ判断の根拠:**
- App Router: Server Componentで認証をサーバー側に集約、クライアントに秘密漏えいなし
- supabaseAdmin: RLSをバイパスしてサーバー側の全操作を一元管理
- haiku: コスト最適化（月数円/ユーザー）
- 15分Cron: 配信時刻を15分刻みで選べる設計のため

**全APIルート:**
| パス | 認証 |
|------|------|
| /api/cron/daily-digest | CRON_SECRET Bearer |
| /api/cron/cleanup | CRON_SECRET Bearer |
| /api/line/webhook | LINE HMAC-SHA256署名 |
| /api/line/connect | Supabase Auth session |
| /api/auth/line-direct | login_tokenクエリパラメータ（24h TTL） |
| /api/stripe/webhook | Stripe constructEvent署名 |
| /api/stripe/checkout | 認証なし |
| /api/stripe/portal | Supabase Auth session |
| /api/user/settings | Supabase Auth session |
| /api/user/delete | Supabase Auth session |

**本番環境変数（Vercel設定済み）:**
NEXT_PUBLIC_APP_URL=https://news.daily-pulse.app
STRIPE_SECRET_KEY=sk_live_...（本番）
STRIPE_PRICE_ID=price_1TbhshEGAT92uqNBf7Gbdc9w（¥680）
LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET / CRON_SECRET 等すべて設定済み

**既知の技術的負債:**
- APIコスト: ユーザー増加でClaude haiku費用が線形増加 → Anthropicダッシュボードで上限設定必須
- エラー監視なし: Vercel Logsを手動確認（Sentry未導入）
- maxDuration=60: Vercel Proプラン必須

---

### 005_daily-pulse（本番稼働中・Slack版）
- 本番: https://daily-pulse-rust.vercel.app
- ローカル: /Users/oniku/Claude-Project/005_daily-pulse/
- Stripe本番キー設定済み / Cron毎時0分
- 落とし穴: hourly CronはVercel Pro必須。NEXT_PUBLIC_APP_URL間違えるとStripe/Slack OAuthが壊れる

---

### 004_kakeibo（開発中・OCR家計簿）
- ローカル: /Users/oniku/Claude-Project/004_kakeibo/
- スタック: Next.js 16 / Supabase / Claude Vision sonnet / Stripe / recharts
- OCR: sharp で1920px以内にリサイズ → sonnet へ送信（haikusでは精度不足）
- pdf-parse: named importでなくdefault importを使うこと
- maxDuration=60 全Claude/OCRルートに設定済み

---

### pocket-claude（このツール自体）
- ローカル: /Users/oniku/pocket-claude/
- GitHub: https://github.com/ippanshimin99/pocket-claude
- 外部アクセス: https://natsumimacbook-air.tail67d196.ts.net
- 設計制約: 127.0.0.1バインド必須 / permissionMode=default / express+agent-sdkのみ / シングルセッション

---

## インフラ全体

| サービス | プラン | 用途 |
|---------|--------|------|
| Vercel Pro | 月$20 | Next.jsホスティング・Cron・maxDuration=60 |
| Supabase Free | 無料 | DB・Auth・RLS |
| Cloudflare | 無料 | DNS（news.daily-pulse.app） |
| Stripe | 本番 | 課金 ¥680/月 |
| Anthropic API | 従量課金 | haiku（要約）/ sonnet（OCR）|
| LINE Developers | 無料 | Messaging API |
| Tailscale | 無料 | pocket-claudeの外部アクセス |

**デプロイ:** git push → Vercel自動デプロイ（手動操作不要）

**よくある障害:**
- LINE Webhook 401 → LINE_CHANNEL_SECRET不一致
- Stripe Webhook 400 → STRIPE_WEBHOOK_SECRETがwhsec_で始まっているか確認
- Supabase permission denied → service_role（supabaseAdmin）を使っているか確認
- Cron 401 → CRON_SECRETが環境変数と不一致

---

## マネタイズロードマップ

DailyPulse（稼働中）→ Chat Softener（Chrome拡張・買い切り$5-10）→ ThinkNest（AIノート・サブスク）

---

## 作業ディレクトリ

プロジェクト作成場所: /Users/oniku/Claude-Project/[通番_PJ名]
命名: 変数・関数=camelCase、コンポーネント=PascalCase
