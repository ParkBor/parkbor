# Unumdorlik (performance): taxminlar va birinchi o'lchovlar

Maqsadlar `ARCHITECTURE.md` 3.2 dan: nearby p95 < 200 ms, bron yaratish p95 < 500 ms, 10 000+ bir vaqtdagi
foydalanuvchi, double booking = 0, mavjudlik 99.5%. Yuklama skriptlari: `loadtest/README.md`.
Quyidagi raqamlar o'lchov EMAS, rejalashtirish uchun taxmin; staging'da tekshirilmaguncha ishonmang.

## Taxminiy yuklama modeli

* 10 000 bir vaqtdagi foydalanuvchining ~30% i xaritani suradi, har biri ~1 so'rov/10 s: cho'qqi
  **300-600 RPS nearby**; **1000 RPS** stress chegarasi (arxitektura 18).
* Bron yaratish: nearby'ning ~1-2% i. Cho'qqi **5-20 RPS**, lekin bitta mashhur lotda to'planadi
  (soat boshida), shuning uchun **lot bo'yicha ketma-ketlik** (lot qulfi) asosiy cheklov.
* WebSocket: 10 000 ulanish, ulanish boshiga 1-3 obuna; hodisalar lot o'zgarishida (debounce 200 ms).
* Webhook: bronlar soniga teng (2-3 so'rov/to'lov + qayta urinishlar).

## Mumkin bo'lgan to'siqlar (xavf tartibida)

1. **`/parkings/nearby` + OSRM.** Har so'rov OSRM Table API'ga boradi. OSRM sekinlashsa p95 darhol buziladi.
   Keshlash (marshrut keshi) ta'sirini va OSRM'siz (fallback) holatni alohida o'lchang.
2. **Lot qulfi (bron).** Hamma yozuvchi avval `ParkingLot` qatorini qulflaydi: bitta lot bo'yicha o'tkazuvchanlik
   ~1 / (tranzaksiya vaqti). 50-100 ms tranzaksiyada ~10-20 bron/s/lot; undan oshsa `lock_timeout` 503.
3. **Postgres ulanishlari.** Uvicorn workerlari x Django ulanishlari; PgBouncer (transaction mode) bilan
   `SET LOCAL` va `SELECT FOR UPDATE` ishlaydi, session-level holat ishlamaydi.
4. **Redis bitta tugun**: throttle, idempotentlik, ticket, ulanish reestri, channel layer, Celery. Channel layer
   uchun alohida baza/instans ko'rib chiqing (`capacity=1000`, `expiry=10`).
5. **ASGI worker**: bitta jarayon HTTP va WebSocket'ni birga olib yuradi; sinxron ORM chaqiruvlari
   (`sync_to_async`) thread poolni to'ldirishi mumkin. 10 000 jim ulanish xotira va heartbeat (30 s) yuki.
6. **Foydalanuvchi bo'yicha throttle** cheklovi yuklama sinovini buzadi: kamida `RPS / 2` token kerak (nearby).

## Birinchi navbatda staging'da o'lchang

1. `nearby_read.js` 100, 300, 600, 1000 RPS: p95/p99, OSRM p95, Postgres CPU, `pg_stat_statements` top so'rovlar
   (KNN so'rovi indeksni ishlatayaptimi: `EXPLAIN (ANALYZE, BUFFERS)`).
2. `booking_contention.js` RACERS=50/200/500, SLOTS=1 va SLOTS=20: `booking_created` aniq `SLOTS`, p95 < 500 ms,
   503 `lock_timeout` ulushi; DB'da overlap so'rovi 0 qator (README).
3. Bitta lotga uzluksiz bron oqimi (har lotda 10, 20, 50 bron/s): lot qulfi navbati uzunligi
   (`pg_locks`, `wait_event`), deadlock log.
4. `ws_fanout.js` VUS=500, 2000, 5000, 10000 (bir necha k6 mashinasi): `ws_ready_ms`, xotira/ulanish,
   Redis `connected_clients` va ops/s, hodisa kechikishi (`CHURN_USERS`).
5. `payment_webhook_replay.js` (Payme va Click): p95, bir xil javoblar, bron bir marta CONFIRMED.
6. `operator_scan_burst.js` 5-20 operator: `scan_ms`, `scan_double_entry == 0`.
7. Fon vazifalari: Celery navbat uzunligi yuklama paytida (hold muddati tugashi, eslatmalar) va beat kechikishi.
8. Bardoshlilik: yuklama ostida Redis'ni 30 s to'xtating (idempotentlik/ticket fail-closed, ulanish reestri fail-open
   kutilganidek ishlayaptimi), Postgres failover'da `serialization_retry` mijoz qayta urinishi.

## Kuzatiladigan ko'rsatkichlar

API: so'rov p50/p95/p99 yo'l bo'yicha, 5xx va 429 ulushi, `lock_timeout` / `serialization_retry` soni.
Postgres: faol ulanishlar, lock kutish, deadlock, sekin so'rovlar. Redis: xotira, ops/s, kechikish, evicted.
ASGI: ochiq WebSocket, yopish kodlari taqsimoti (4408/4409/4429/1011), event loop kechikishi. Celery: navbat chuqurligi.

## Qabul mezonlari (staging, birinchi bosqich)

nearby p95 < 200 ms @ 300 RPS (stress: 1000 RPS'da p95 < 400 ms va xatosiz); bron p95 < 500 ms, raqobatda aniq `SLOTS`
ta g'olib va overlap = 0; WS `ready` p95 < 1 s @ 5000 ulanish; webhook qayta urinishlari bir xil javob; 5xx < 1%.
Chegaralar `loadtest/` dagi `P95_*` o'zgaruvchilari bilan sozlanadi va o'lchov asosida yangilanadi.
