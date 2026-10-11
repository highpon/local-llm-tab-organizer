// Embeds a fixed set of tab texts with the on-device embedding model and prints the fixture JSON
// used by tests/core/thresholds.test.ts. Usage: node scripts/embed-fixture.mjs > tests/fixtures/embeddings.json
// Texts are already in embedText() form: "<title without site suffix> <hostname>".
import { pipeline } from '@huggingface/transformers';

const EMBED_MODEL = {
  id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  revision: '2c4055b12046f11709e9df2c122e59ffbdc2f900',
  dtype: 'q8',
}; // keep in sync with services/ml/models.ts

const ITEMS = [
  // code review
  ['review', 'Fix race condition in scheduler by alice · Pull Request #412 · acme/api github.com'],
  ['review', 'Pull requests · acme/web github.com'],
  ['review', 'Add retry to upload client !128 · Merge requests · acme/mobile gitlab.com'],
  ['review', 'スケジューラの競合状態を修正 · Pull Request #87 · acme/batch github.com'],
  ['review', 'プルリクエスト一覧 · acme/infra github.com'],
  ['review', 'Code review: refactor auth middleware github.com'],
  ['review', 'コードレビュー: 認証ミドルウェアのリファクタリング github.com'],
  ['review', 'Review requested: bump dependencies #902 github.com'],
  // cooking
  ['cooking', 'Easy Chocolate Chip Cookies Recipe allrecipes.com'],
  ['cooking', 'How to Make Perfect Risotto bbcgoodfood.com'],
  ['cooking', 'Vegetable curry recipe for weeknights seriouseats.com'],
  ['cooking', '簡単！肉じゃがの作り方 レシピ cookpad.com'],
  ['cooking', '本格チキンカレーのレシピ delishkitchen.tv'],
  ['cooking', '人気の時短パスタレシピ 20 選 kurashiru.com'],
  ['cooking', 'Banana bread recipe (moist and easy) kingarthurbaking.com'],
  ['cooking', 'ふわふわパンケーキの焼き方 cookpad.com'],
  // trains
  ['trains', '東京 から 新大阪 乗換案内 transit.yahoo.co.jp'],
  ['trains', '山手線 時刻表 渋谷駅 jorudan.co.jp'],
  ['trains', '新幹線 のぞみ 指定席 予約 smartex.jp'],
  ['trains', 'Shinkansen timetable Tokyo to Kyoto japan-guide.com'],
  ['trains', 'JR East train route search navitime.co.jp'],
  ['trains', '終電 検索 品川 から 横浜 ekitan.com'],
  ['trains', 'Japan Rail Pass seat reservations japanrailpass.net'],
  ['trains', '中央線 運行情報 遅延 jreast.co.jp'],
  // typescript docs
  ['typescript', 'TypeScript: Documentation - Generics typescriptlang.org'],
  ['typescript', 'TypeScript: Handbook - Narrowing typescriptlang.org'],
  ['typescript', 'Utility Types typescriptlang.org'],
  ['typescript', 'TypeScript 入門 ジェネリクスの使い方 zenn.dev'],
  ['typescript', '型の絞り込み (Narrowing) を理解する qiita.com'],
  ['typescript', 'How to type a React component with TypeScript stackoverflow.com'],
  ['typescript', 'tsconfig compilerOptions strict typescriptlang.org'],
  ['typescript', 'TypeScript の Utility Types まとめ qiita.com'],
  // travel booking
  ['travel', 'Hotels in Kyoto - Book now booking.com'],
  ['travel', 'Cheap flights from Tokyo to Seoul skyscanner.net'],
  ['travel', 'Kyoto ryokan with private onsen expedia.com'],
  ['travel', '京都 ホテル 予約 格安 jalan.net'],
  ['travel', '羽田 ソウル 航空券 比較 skyscanner.jp'],
  ['travel', '箱根 温泉旅館 宿泊プラン travel.rakuten.co.jp'],
  ['travel', 'Airbnb apartments in Osaka airbnb.com'],
  ['travel', '沖縄 ツアー 2泊3日 ホテル付き his-j.com'],
  // unrelated singletons
  ['single-weather', '東京の天気 tenki.jp'],
  ['single-bank', 'Online Banking - Account summary chase.com'],
  ['single-music', 'Lo-fi beats to study to youtube.com'],
  ['single-tax', '確定申告書等作成コーナー keisan.nta.go.jp'],
];

const extractor = await pipeline('feature-extraction', EMBED_MODEL.id, {
  revision: EMBED_MODEL.revision, dtype: EMBED_MODEL.dtype,
});
const texts = ITEMS.map(([, text]) => text);
const vectors = (await extractor(texts, { pooling: 'mean', normalize: true })).tolist();
const items = ITEMS.map(([topic, text], i) => ({
  topic, text, vector: vectors[i].map((x) => Math.round(x * 1e4) / 1e4),
}));
process.stdout.write(JSON.stringify({ model: EMBED_MODEL.id, revision: EMBED_MODEL.revision, items }) + '\n');
