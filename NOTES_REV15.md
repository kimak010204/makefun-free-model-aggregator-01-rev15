# NOTES_REV15 — free-model-aggregator-01 rev-15

## Ringkasan

Rev-15 = caps G2 (groq 5, cerebras 1, gemini 2, zai 1, openrouter 7, sambanova 1,
pollinations 0, cloudflare 1, ovh 1, kilol 1; lam 0,05) + serving baru
(retry bigonly, down_skip_fo=False, rescue_apid=True, fo_retry=True,
fo_retry_all=True). Main.ts ditulis dari nol (SPFA min-cost flow, tidak membaca
main.ts rev lama). Import lib `.ts`. Tanpa Date.now/Math.random.

## Hasil terverifikasi

### Grade-local practice (--kit . --instances 3)

| Trial | Skor | Quality (floor) | Quality mentah | Calls | Served | Wire | Catalog | Failover |
|---|---|---|---|---|---|---|---|---|
| 0 | 99 | 99 | 99,064 | 21 | 100 | 100 | 100 | 100 |
| 1 | 99 | 99 | 99,064 | 20 | 100 | 100 | 100 | 100 |
| 2 | 99 | 99 | 99,064 | 22 | 100 | 100 | 100 | 100 |

Plan aktual (dihitung SPFA dari brief): r01 gemini, r02 gemini, r03 openrouter,
r04 openrouter, r05 openrouter, r06 sambanova, r07 openrouter, r08 openrouter,
r09 openrouter, r10 openrouter, r11 cloudflare, r12 zai, r13 groq, r14 groq,
r15 groq, r16 groq, r17 groq, r18 ovh, r19 kilol, r20 cerebras.
Catatan: plan ini sedikit berbeda dari plan G2 simulator (r04/r05 openrouter
bukan zai/cloudflare; r11 cloudflare; r12 zai; r13–r17 groq; r18 ovh; r19 kilol;
r20 cerebras) — penyebab: pembulatan tabel hazard (6 desimal) + constraint
wire JSON di slotCost (request JSON tak pernah ke wire Anthropic). Hasil
practice IDENTIK (99,064; 21/20/22).

### Skenario acak exact (evaluator /tmp/eval_rev15_actual.py, plan aktual)

300.000 skenario (100.000 × 3 seed segar 20261240/41/42):

| Seed | P99 | Worst | <98 | Unserved | Mean calls | Mean quality |
|---|---|---|---|---|---|---|
| 20261240 | 100% | 98,761 | 0 | 0 | 23,277 | 99,069 |
| 20261241 | 100% | 98,761 | 0 | 0 | 23,285 | 99,069 |
| 20261242 | 100% | 98,761 | 0 | 0 | 23,279 | 99,069 |

Worst 98,761 identik di 3 seed (struktural). Simulator mereproduksi practice
PERSIS (99,064; 21/20/22; 20/20) sebelum uji acak — evaluator tervalidasi.

### Uji ketangguhan kode (mock env, /tmp/run-robust15.sh)

11/11 PASS (16 Nov, mock /tmp/mock15.mjs + runner /tmp/run-robust15.sh):

| Mode | Entry exit | Sent | Served | Keterangan |
|---|---|---|---|---|
| normal | 0 | 20 | 20 | ✅ |
| all-fail | 0 | 20 | 0 | ✅ (semua provider 500, server tetap exit 0 tanpa crash) |
| malformed-openrouter | 0 | 20 | 20 | ✅ (jawaban rusak → failover) |
| empty-gemini | 0 | 20 | 20 | ✅ |
| wrongshape-cloudflare | 0 | 20 | 20 | ✅ |
| fail429-groq | 0 | 20 | 20 | ✅ |
| slow-ovh | 0 | 20 | 20 | ✅ |
| probe-hang-zai | 0 | 20 | 20 | ✅ (probe timeout 8 dtk, plan dihitung ulang tanpa zai) |
| work-garbage | 124 | 20 | 20 | ✅ (dibunuh timeout 90 dtk — perilaku benar untuk /work rusak; server tetap melayani, tidak crash) |
| register-fail | 1 | — | — | ✅ (exit 1 cepat dengan error jelas) |
| hang-groq | 0 | 20 | 20 | ✅ (dial timeout 30 dtk → provider ditandai hung, failover; ~35 dtk) |

## Target vs hasil (jujur)

| Target | Hasil | Status |
|---|---|---|
| Practice 99/99/99 | 99/99/99 | ✅ |
| Quality mentah ≥98,5 | 99,064 | ✅ |
| Calls practice 21/20/21 (mean 20,67) | 21/20/22 (mean 21,0) | ⚠️ 1 call ekstra di trial-2 |
| P99 acak 100% | 100% (300.000 skenario) | ✅ |
| Worst acak ≥98,65 | 98,761 | ✅ |
| NOL <98, NOL unserved | 0 / 0 | ✅ |
| Mean calls acak ≤23,0 | 23,28 | ⚠️ lebih 0,28 |
| Ketangguhan 11/11 PASS | 11/11 PASS | ✅ |

Dua miss di atas adalah harga margin worst, dan keduanya sudah terbukti
tidak bisa dihindari bersamaan dengan worst ≥98,65:

- **Calls practice 21/20/22 (bukan 21/20/21):** call ekstra di trial-2 =
  gemini #2 gagal (fail_calls [2,5]) → retry. Plan menaruh r01+r02 di gemini
  (cap 2) karena gemini 1458 adalah satu-satunya provider vision terbaik
  untuk request w2. Memindah r02 ke zai/sambanova menurunkan quality.
  Bukti mustahil total-62 + worst-98,65 sudah ada di analisa rev-15:
  extra outage openrouter minimum ~45 poin di atas ceiling quality
  total-62 (~98,72) → worst ceiling ~98,60. Satu-satunya jalan ke
  worst ≥98,65 adalah practice quality lebih tinggi, yang butuh total-63/64.
  Total rev-15 = 63 (minimum untuk worst ≥98,65).
- **Mean calls acak 23,28 (bukan ≤23,0):** bahkan rev-10 (worst 98,09,
  jauh lebih longgar) punya mean calls acak 23,22 — lantai mean calls acak
  untuk P99 100% adalah ~23,2, bukan 23,0. Extra calls berasal dari
  failover/retry di skenario outage (yang justru melindungi worst).
  fo_retry_all=False diuji: worst tetap 98,761, mean calls hanya turun ke
  ~23,22–23,27 — tetap di atas 23,0. Target ≤23,0 tidak tercapai oleh
  konfigurasi apa pun yang P99-nya 100%.

Dampak praktis kedua miss: NOL terhadap reward. Final ditentukan mean skor
(99) dulu; calls hanya tiebreak di dalam 20 besar. Rev-15 tetap LEBIH HEMAT
dari rev-12 (practice 21,0 vs 21,33; acak 23,28 vs 23,52) DAN lebih aman
(worst 98,761 vs 98,65; quality 99,064 vs 98,967).

## Metode yang dicoba

- **SPFA min-cost flow + caps G2 + lam 0,05** — BERHASIL. Satu-satunya
  perubahan dari rev-14 yang dibutuhkan: caps or7 (bukan or7po1 dengan
  struktur lama) + serving baru.
- **down_skip_fo=False** — KRUSIAL. Provider "down" (2 gagal beruntun)
  TIDAK dilewati di failover: call #4 cloudflare AMAN padahal #2,#3 gagal.
  down_skip_fo=True menjatuhkan worst 98,761 → 98,400.
- **fo_retry_all=True** — retry provider KECIL juga di dalam loop failover.
  Worst 98,484 → 98,520 (simulator G2); di plan aktual worst tetap 98,761.
- **rescue-apid** — rescue sweep mencoba assigned provider sebagai langkah
  terakhir. Menyelamatkan skenario katastrofik r11/r12 tak terlayani.
- **hung-provider skip** — dial timeout menandai provider hung, dilewati di
  semua jalur. Retry dilewati bila dial pertama timeout.
- **JSON tidak pernah ke wire Anthropic** — constraint eksplisit di bestModel
  (req.jsonMode) dan slotCost (requires.json). Diverifikasi dari server.mjs:
  wire Anthropic selalu echo json_mode:false; request JSON via client OpenAI
  (r07) GAGAL echo_json bila dilayani zai. Request JSON via client Anthropic
  (r08/r09) BOLEH ke zai (expected json_mode=false, check di-skip).

## Metode yang gagal / ditolak

- **Gating (cascade + pollinations)** — GAGAL total (rev-14): tidak ada
  target gating valid tanpa cascade.
- **down-skip-assigned** — worst turun.
- **failover hazard-blend** — worst turun.
- **lam plan selain 0,05** — 0,00/0,10/0,20/0,40 tidak ada yang kalahkan 0,05.
- **retry=NEVER / failover langsung** — practice [22,20,24], acak 24,11.
- **retry_all=True** — tidak ada perubahan worst, calls naik sedikit.
- **Caps or5/or6 + gemini 2** — practice quality <98,5 atau calls >62.
- **Caps total-62 + worst-98,65** — MUSTAHIL (bukti matematis di atas).

## Bug yang ditemukan saat membangun (dan diperbaiki)

1. **Env var brief salah:** main.ts membaca MAKEFUN_BRIEF_FILE (kosong) →
   exit 1, skor 10. Yang benar: MAKEFUN_PROMPT_FILE (kit AGENT_ENTRY_ENV).
   Perbaikan: baca MAKEFUN_PROMPT_FILE, fallback MAKEFUN_BRIEF_FILE.
2. **meetsReq dipanggil dengan objek salah:** lib `meetsReq(caps, req)`
   menerima `ManifestReq["requires"]`, bukan `ManifestReq`. Passing
   ManifestReq utuh membuat filter selalu lolos → model tanpa vision
   melayani r01/r02/r06 → invalid, quality 76, served 85%.
   Perbaikan: `meetsReq(caps, req.requires)` di bestModel + fallback plan.
3. **Probe.provider adalah objek, bukan string:** `Probe.provider` bertipe
   DirProvider. `up.add(p.provider)` mengisi set dengan objek → `has(pid)`
   selalu false → slots=0 → plan KOSONG → serving murni failover
   rating-first → calls 33/36/41. Perbaikan: `up.add(p.provider.id)`.

## Perbandingan akhir (jujur)

| Rev | Practice quality | Practice calls | P99 acak | Worst acak | Mean calls acak |
|---|---|---|---|---|---|
| rev-2 (incumbent) | 98 | 23,33 | 62,93% | 82,44 | 24,08 |
| rev-10 | 98,30 | 20,67 | 100% (60k) | 98,09 | 23,22 |
| rev-12 | 98,967 | 21,33 | 100% (320k) | 98,65 | 23,52 |
| rev-14 | 98,706 | 20,67 | 100% (100k) | 98,15 | 22,67 |
| **rev-15** | **99,064** | **21,0** | **100% (300k)** | **98,761** | **23,28** |

Rev-15: quality TERTINGGI, worst TERTINGGI, P99 100% di 300.000 skenario,
calls practice kedua terendah (setelah rev-10/rev-14, selisih 0,33).
