# tab-tidy 設計書

- 日付: 2026-10-11
- ステータス: レビュー待ち

## 1. 目的

Firefox 拡張機能 **tab-tidy** は、開いているタブを定期的に自動整理する。Firefox Add-ons (AMO) で公開する。

解決する課題:

- A. タブが多すぎて目的のタブが見つからない → 分類して見通しを良くする
- B. タブが多すぎて重い → 重複タブを統合して数を減らす
- C. 調べものでタブが散らかる → テーマ別にタブグループへまとめる

### 成功条件

- LLM がなくても、インストール直後から重複統合とドメイン単位の分類が動く
- ローカル LLM（Ollama / LM Studio などの OpenAI 互換 API）を設定すると、内容に基づく分類になる
- 利用者が意図しないタブ喪失が起きない（安全側の除外ルール、実行直前の再検証、元に戻す）
- 作業中にタブが動かない（操作していないときだけ定期実行する）

### 差別化

既存の類似拡張機能（例: Smart Tab Groups）や Firefox 標準の AI タブグループ提案に対し、次の 3 点で差別化する。

1. 定期的な自動実行
2. 重複タブの統合
3. 利用者が選んだローカル LLM の利用

## 2. 決定事項の要約

| 項目 | 決定 |
|---|---|
| LLM | 必須にしない。ルールベースを基本とし、利用者が起動したローカルサーバー（OpenAI 互換 `/v1/chat/completions`）にオプションで対応する |
| 分類の表示 | Firefox 標準のタブグループ（`tabs.group` / `tabGroups.update`） |
| 重複の判定 | 正規化した URL が一致すること |
| 残すタブ | `lastAccessed` が最も新しいタブ |
| 自動化レベル | 機能ごとに「自動 / 提案」を設定で選べる。初期値は重複統合が自動、分類が提案 |
| 実行タイミング | 一定間隔ごと、かつ利用者が操作していないときだけ。初期値は 30 分間隔、60 秒の無操作。「今すぐ実行」も用意する |
| カテゴリの決め方 | 既存のタブグループを優先して振り分け、合わないタブが 2 枚以上集まったら新しいグループを作る |
| 技術スタック | TypeScript + WXT（Manifest V3）、Vitest |
| 最低対応バージョン | Firefox 140（`tabGroups.update` は 139 から、`data_collection_permissions` は 140 から使える） |

## 3. 全体構成

基本方針は「計画を作る（純粋なロジック）」と「実行する（ブラウザ API）」を分けること。計画 (`Plan`) は自動モードではその場で実行し、提案モードでは保存して承認を待つ。

```
entrypoints/
  background.ts       起動処理。scheduler と orchestrator をつなぐだけ
  popup/              今すぐ実行・提案の適用/破棄・元に戻す・LLM 接続状態の表示
  options/            設定画面（LLM 接続先・モデル・接続テスト・各モード・間隔・実行履歴）

core/                 ブラウザ API に依存しない
  types.ts            TabInfo, GroupInfo, DedupePlan, GroupingPlan など
  normalizeUrl.ts     URL の正規化
  planDedupe.ts       タブ一覧 → 閉じるタブの計画
  classifyByDomain.ts LLM なしで使うドメイン単位の分類
  planGrouping.ts     分類結果と既存グループ → グループ化の計画

services/             ブラウザや外部とのやり取り
  tabsAdapter.ts      browser.tabs / tabGroups の読み取りと計画の実行
  llmClient.ts        OpenAI 互換 /v1/chat/completions の呼び出し（タイムアウトあり）
  llmClassifier.ts    プロンプトの組み立てと応答 JSON の検証。失敗したら classifyByDomain に切り替える
  scheduler.ts        alarms と idle の組み合わせ
  settings.ts         storage.local への設定の保存と読み込み（初期値を含む）
  undoLog.ts          直前 1 回分の操作を記録し、元に戻す
  runHistory.ts       実行結果の履歴（直近 20 件）
  orchestrator.ts     1 回分の実行（読む → 計画 → 自動なら実行、提案なら保存）
```

### 権限

- `tabs`, `tabGroups`, `alarms`, `idle`, `storage`, `notifications`, `sessions`
- LLM 接続先のホスト権限は `optional_host_permissions` に宣言する。利用者が接続先を設定したときに `permissions.request` で許可を求める

### プライバシー

- LLM に送るのはタブのタイトルと URL だけ。ページの本文は読まない
- 送信先は利用者が設定した LLM サーバーだけ。そのほか外部への送信は一切しない

## 4. データの流れ

### 4.1 起動

1. `alarms` が `intervalMinutes`（初期値 30 分）ごとに発火する
2. `idle.queryState(idleSeconds)`（初期値 60 秒）が `idle` か `locked` ならすぐ実行する。`active` なら `storage.session` に実行待ちの印を立てる
3. `idle.onStateChanged` で `idle` になったとき、実行待ちの印があれば実行し、印を消す
4. ポップアップの「今すぐ実行」は idle の判定をせず、すぐ実行する
5. 実行中は `storage.session` にロックを置き、同時に 2 回走らないようにする。ロックは 5 分で失効させる
6. `runtime.onStartup` と `runtime.onInstalled` で、アラームがなければ作り直す

### 4.2 重複の統合（`planDedupe`）

1. 全タブの `TabInfo` を取得する
2. 次のタブは対象外にする: `http:` / `https:` 以外、ピン留め、各ウィンドウで表示中、音声を再生中
3. 正規化した URL でまとめる。`dedupeAcrossWindows` が false（初期値）なら、ウィンドウごとにまとめる
4. 2 枚以上あるまとまりで `lastAccessed` が最も新しいタブを残し、ほかを閉じる計画を作る
5. 自動モードなら実行して `undoLog` に記録する。提案モードなら計画を保存して通知する

### 4.3 URL の正規化（`normalizeUrl`）

- `#` 以降のアンカーを除く
- トラッキング用パラメータを除く: `utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `ref_src`（`ref` は GitHub のブランチ指定などで意味を持つため除かない）
- 残ったクエリパラメータをキーで並べ替える
- 末尾の `/` を除く（パスが `/` だけの場合は空と同じ扱い）
- `http` と `https` を区別しない
- ホストの先頭の `www.` を除く。ホストは小文字にする
- 上記以外のクエリは残す（例: 検索語の違う検索結果、`?v=` の違う動画は別ページとみなす）

### 4.4 分類（`planGrouping`）

1. 重複統合の後、タブとタブグループを取得し直す
2. **すでにグループに入っているタブは動かさない。** 分類の対象は、どのグループにも入っていない `http(s)` のタブだけ（ピン留めのタブも除く）
3. 分類方法:
   - LLM が有効なら `llmClassifier` を使う。既存グループの名前と、未分類タブの `{id, title, url}` を渡し、`{"assignments":[{"tabId":number,"group":string}]}` を返してもらう。`group` には既存グループの名前か新しい名前（短い名詞句、ブラウザの UI 言語）が入る。タブは 1 回あたり最大 50 枚に分けて送る
   - LLM が無効か失敗した場合は `classifyByDomain` を使う。ホストから `www.` を除き、登録ドメイン単位でまとめる（例: `docs.github.com` → `github.com`）。グループ名にはドメインの主要部分を使う（例: `GitHub`）
4. 計画を作る:
   - 割り当て先が既存グループの名前に一致すれば、1 枚でもそのグループに追加する（同じウィンドウ内のグループに限る）
   - 新しいグループ名のタブは、同じウィンドウで 2 枚以上集まったときだけグループを作る。1 枚だけならそのままにする
5. 提案モード（初期値）なら計画を保存して通知を出し、ポップアップで「適用」か「破棄」を選んでもらう。自動モードなら `tabs.group` でグループを作り、`tabGroups.update` で名前を付ける。色は Firefox の初期値に任せる

### 4.5 元に戻す（`undoLog`）

- 直前 1 回分の実行だけ記録する
- 閉じたタブは `sessions.getRecentlyClosed` で対応するセッション ID を見つけ、`sessions.restore` で復元する
- グループへ追加したタブは `tabs.ungroup` でグループ未所属に戻す。tab-tidy が作ったグループは、タブがなくなると Firefox が自動で消す

## 5. エラー処理

方針: 失敗してもタブを失わせない。安全側へ倒し、静かに切り替える。

### LLM

| 状況 | 対応 |
|---|---|
| 接続できない | その回はドメイン分類に切り替える。ポップアップに状態を表示する。通知は状態が変わったときに 1 回だけ出す |
| タイムアウト（初期値 30 秒、設定で変更可） | ドメイン分類に切り替える |
| 応答 JSON が不正、存在しない tabId、対象外の tabId | 不正な部分だけ捨て、割り当てのないタブはドメイン分類で補う |
| HTTP 403 | `OLLAMA_ORIGINS=moz-extension://*` の設定漏れである可能性を表示し、手順を案内する |

### タブ操作

| 状況 | 対応 |
|---|---|
| 計画を作った後にタブの状態が変わった | 実行直前に、存在するか・URL・ピン留め・表示中か・グループ所属を確認し直し、条件が変わったタブは飛ばす。提案の適用時も同じ |
| `tabs.remove` / `tabs.group` が一部失敗した | 失敗したタブは飛ばして続ける。成功した分だけ `undoLog` に記録する |
| `tabGroups` API がない | manifest の `strict_min_version: "140.0"` でインストールを防ぐ。実行時にも API の有無を確認し、なければ分類を無効にして重複統合だけ動かす |

### スケジューラ

| 状況 | 対応 |
|---|---|
| 実行中に background がメモリから消えた | ロックの失効（5 分）で回復する |
| ブラウザを再起動した | `onStartup` でアラームを作り直す |

### 実行履歴

各実行の結果（日時、きっかけ、閉じた枚数、グループ化した枚数、分類方法、エラー）を `storage.local` に直近 20 件まで残し、設定画面で表示する。

## 6. 設定項目

| キー | 初期値 | 説明 |
|---|---|---|
| `dedupe.mode` | `auto` | `auto` / `suggest` / `off` |
| `dedupe.acrossWindows` | `false` | ウィンドウをまたいで重複を探すか |
| `grouping.mode` | `suggest` | `auto` / `suggest` / `off` |
| `llm.enabled` | `false` | LLM を使うか |
| `llm.baseUrl` | `http://localhost:11434/v1` | OpenAI 互換 API のベース URL |
| `llm.model` | （空） | モデル名。接続テストで `/v1/models` から候補を表示する |
| `llm.timeoutSeconds` | `30` | 1 回の要求のタイムアウト |
| `schedule.intervalMinutes` | `30` | 定期実行の間隔 |
| `schedule.idleSeconds` | `60` | 無操作とみなすまでの秒数（`idle` API の下限は 15 秒） |

## 7. テスト方針

### 単体テスト（Vitest、中心）

- `normalizeUrl`: 同一とみなすべき例と、同一とみなしてはいけない例の両方
- `planDedupe`: `lastAccessed` が最も新しいタブを残すこと、除外ルール、ウィンドウをまたぐ設定の有無
- `planGrouping`: 既存グループを優先すること、2 枚未満では新しいグループを作らないこと、グループに入っているタブを動かさないこと、ウィンドウの境界
- `classifyByDomain`: サブドメインの扱い、グループ名の生成

### サービス層（Vitest、`@webext-core/fake-browser` でブラウザ API をモック）

- `llmClassifier`: 正常な応答、壊れた JSON、存在しない tabId、タイムアウト、403 のそれぞれで、期待どおりドメイン分類に切り替わること（`fetch` をモックする）
- `orchestrator`: 実行直前の再検証、ロックとロックの失効、自動モードと提案モードの分岐
- `scheduler`: 操作中なら実行待ちになり、`idle` になったら実行されること
- `undoLog`: 閉じたタブの復元とグループ化の取り消し

### 手動の結合確認（Firefox 実機）

WXT の開発モードで読み込み、次のチェックリストで確認する。

- 重複タブの統合と元に戻す
- 分類の提案、適用、破棄
- Ollama 実機との接続と分類
- Ollama 未起動時にドメイン分類へ切り替わること
- `OLLAMA_ORIGINS` 未設定時の 403 表示
- ストア申請前に `web-ext lint` を通す

## 8. 対象外（将来の拡張候補）

- ブラウザ内で LLM を動かす方式（WebLLM / Transformers.js / Firefox ML API）
- LLM による内容ベースの重複判定（提案のみ）
- タブ数のしきい値による起動
- サイドバーでのカテゴリ一覧表示
- Playwright などによる E2E の自動化
