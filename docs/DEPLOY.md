# ParkBor: production joylashtirish (runbook)

Arxitektura: `docs/ARCHITECTURE.md` 12, 14.3, 15, 16, 17. Bu hujjat — amaliy qadamlar (bir hostli compose). Railway varianti: `docs/RAILWAY.md`. Fayllar:

| Fayl | Vazifasi |
|---|---|
| `infra/docker-compose.prod.yml` | butun stek (bitta host) |
| `infra/prod.env.example` | `infra/.env.prod` shabloni (haqiqiy `.env.prod` gitga TUSHMAYDI) |
| `infra/nginx/` | nginx rasmi (admin SPA ichida), `nginx.conf`, `templates/parkbor.conf.template`, `snippets/` |
| `infra/healthcheck/api.py` | `api` konteyneri uchun HTTP healthcheck |
| `.github/workflows/` | `backend.yml` (testlar, pip-audit, Docker build), `infra.yml` (compose + nginx -t), `admin.yml`, `mobile.yml` |
| `mobile/eas.json` | EAS profillari: development / preview / production |

Xizmatlar: `db` (PostGIS 16), `redis` (noeviction + AOF: broker, channels, holat), `redis-cache` (allkeys-lru: kesh),
`osrm`, `api` (uvicorn ASGI), `worker-default` (`-Q celery`), `worker-realtime` (`-Q realtime`), `worker-notify`
(`-Q notify`, **faqat 1 nusxa**), `beat` (**faqat 1 nusxa**), `nginx`. `migrate` — bir martalik (`--profile ops`).
Docs (16) talabi bo‘yicha har navbatga alohida worker (`--prefetch-multiplier 1`): `realtime` va `notify` ni bitta
workerga birlashtirmang, sekin Telegram/Expo jonli yangilanishni kechiktirib yuboradi.

Tarmoq: `data` (internal, internetga chiqmaydi): db, redis, redis-cache, osrm. `public`: nginx va ilova konteynerlari
(Telegram/Expo/to‘lov provayderlariga chiqish uchun). `api` porti (8000) hostga **e’lon qilinmaydi**, faqat nginx ko‘radi.

## 0. Egasi taqdim etishi kerak bo‘lgan narsalar (checklist)

- [ ] Server (Linux, Docker Engine + compose v2), 4 vCPU / 8 GB RAM / SSD dan boshlash; firewall: faqat 22, 80, 443.
- [ ] Domenlar: `API_DOMAIN` (masalan `api.<domen>`) va `ADMIN_DOMAIN` (`crm.<domen>`) A/AAAA yozuvi serverga; `HABI_PUBLIC_URL` (universal link domeni, `https://`).
- [ ] TLS sertifikatlari (3-bo‘lim).
- [ ] Telegram: bot tokeni (`TELEGRAM_BOT_TOKEN`), bot username (`TELEGRAM_BOT_USERNAME`), `TELEGRAM_WEBHOOK_SECRET`; BotFather `/setdomain` (6-bo‘lim). Staging uchun alohida bot.
- [ ] Payme Business: `PAYME_MERCHANT_ID`, `PAYME_KEY`; Click: `CLICK_SERVICE_ID`, `CLICK_MERCHANT_ID`, `CLICK_MERCHANT_USER_ID`, `CLICK_SECRET_KEY`; Click server IP lari (`PAYMENTS_CLICK_IPS`) — CLICK support dan.
- [ ] Maxfiy kalitlar: `SECRET_KEY`, `JWT_SIGNING_KEY`, `QR_SIGNING_KEY` (>= 50 belgi), Postgres/Redis parollari.
- [ ] Expo/EAS akkaunti, `EXPO_PUBLIC_EAS_PROJECT_ID` (`eas init`), Expo access token (ixtiyoriy `EXPO_ACCESS_TOKEN`).
- [ ] Xarita: kalit kerak emas (MapLibre + OpenFreeMap, ARCHITECTURE 11.3); production uchun xarita uslubi provayderini hal qiling. Apple Developer va Google Play akkauntlari.
- [ ] `mobile/eas.json` dagi haqiqiy domenlar (hozir `api.parkbor.uz`, `staging-api.parkbor.uz`) va bot nomlari (`parkbor_bot`, `parkbor_staging_bot`, `parkbor_dev_bot`) — o‘zingiznikiga almashtiring.
- [ ] Sentry (ixtiyoriy): backend DSN. Mobil/admin DSN nomlari faqat zaxiralangan (`EXPO_PUBLIC_SENTRY_DSN`, `VITE_SENTRY_DSN`), SDK hali o‘rnatilmagan.
- [ ] Zaxira nusxa saqlanadigan tashqi joy (boshqa server / S3) va monitoring (uptime tekshiruvi).
- [ ] Docker registry (GHCR yoki boshqa), agar rasmni CI dan tortmoqchi bo‘lsangiz (hozir CI rasmni faqat quradi, push qilmaydi).

## 1. Birinchi deploy

```bash
git clone <repo> /opt/parkbor && cd /opt/parkbor/infra
cp prod.env.example .env.prod && chmod 600 .env.prod && $EDITOR .env.prod   # barcha replace-me / example.com ni to‘ldiring
alias dc='docker compose --env-file .env.prod -f docker-compose.prod.yml'
dc config -q                                   # sintaksis va majburiy o‘zgaruvchilar

# OSRM ma’lumotlari (2-bo‘lim), TLS (3-bo‘lim) tayyor bo‘lgach:
dc build                                       # backend + nginx (admin SPA ichida)
dc up -d db redis redis-cache
dc run --rm migrate                            # migratsiyalar
dc run --rm api python manage.py check --deploy --fail-level WARNING
dc run --rm api python manage.py create_superadmin    # HABI_SUPERADMIN_PASSWORD yoki so‘raydi
dc up -d                                       # qolganlari
dc ps                                          # hammasi healthy bo‘lishi kerak
dc run --rm api python manage.py set_telegram_webhook --base-url https://<API_DOMAIN>
```

`.env.prod` da parollarda `$` ishlatmang (compose uni qayta interpolyatsiya qiladi); `ALLOWED_HOSTS` ga ikkala domenni
yozing (admin SPA o‘z domenidan API ga murojaat qiladi, shuning uchun CORS kerak emas).

## 2. OSRM ma’lumotlari (bir marta, so‘ng yiliga 1–2 marta yangilash)

```bash
cd /tmp && wget https://download.geofabrik.de/asia/uzbekistan-latest.osm.pbf
docker volume create parkbor_osrmdata
R="docker run --rm -v parkbor_osrmdata:/data -v $PWD:/src osrm/osrm-backend:v5.27.1"
$R sh -c 'cp /src/uzbekistan-latest.osm.pbf /data/ && osrm-extract -p /opt/car.lua /data/uzbekistan-latest.osm.pbf && osrm-partition /data/uzbekistan-latest.osrm && osrm-customize /data/uzbekistan-latest.osrm && chmod -R a+rX /data'
dc up -d osrm
```

Compose loyiha nomi `parkbor`, shuning uchun volume `parkbor_osrmdata`. Yangilashda yangi fayllarni tayyorlab, `dc restart osrm`.

## 3. TLS sertifikatlari

nginx konteyneri root emas (uid 101) va sertifikatni `${TLS_DIR}/<domen>/fullchain.pem` + `privkey.pem` dan o‘qiydi.
Let’s Encrypt (host da certbot, `--webroot -w /var/www/acme`) bilan:

```bash
sudo certbot certonly --webroot -w /var/www/acme -d <API_DOMAIN>     # 80-port ochiq bo‘lishi uchun avval: dc up -d nginx
sudo certbot certonly --webroot -w /var/www/acme -d <ADMIN_DOMAIN>
```

Yangilanganda nusxalash + reload uchun `/etc/letsencrypt/renewal-hooks/deploy/parkbor.sh`:

```bash
#!/bin/sh
for d in <API_DOMAIN> <ADMIN_DOMAIN>; do
  install -d -o 101 -g 101 -m 750 /opt/parkbor/certs/$d
  install -o 101 -g 101 -m 640 /etc/letsencrypt/live/$d/fullchain.pem /etc/letsencrypt/live/$d/privkey.pem /opt/parkbor/certs/$d/
done
cd /opt/parkbor/infra && docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T nginx nginx -s reload
```

Birinchi marta nginx sertifikatsiz ishga tushmaydi: dastlab vaqtincha o‘z-o‘zidan imzolangan sertifikat qo‘yib, certbot dan keyin almashtiring.
HSTS yoqilgan (`includeSubDomains`): barcha subdomenlar HTTPS ni qo‘llashiga ishonch hosil qiling.

## 4. Yangilash (har bir reliz)

1. CI yashil bo‘lsin (backend testlar postgis+redis bilan, pip/pnpm audit, Docker build, `infra.yml` nginx -t).
2. Serverda: `cd /opt/parkbor && git fetch && git checkout <tag>` va `SENTRY_RELEASE=<tag yoki sha>` ni `.env.prod` ga yozing.
3. **Migratsiyadan oldin zaxira nusxa** (5-bo‘lim), so‘ng:

```bash
dc build
dc run --rm migrate            # ORQAGA mos (additive) migratsiyalar: eski kod yangi sxema bilan ishlay olsin
dc up -d --no-deps api worker-default worker-realtime worker-notify beat nginx
dc ps && dc logs --tail=100 api
```

Migratsiyalarni ikki bosqichda yozing (ustun qo‘shish -> kod -> eskisini o‘chirish), shunda orqaga qaytish xavfsiz.

## 5. Orqaga qaytarish (rollback)

- **Kod:** oldingi tegga qayting: `git checkout <old>`, `dc build`, `dc up -d --no-deps api worker-* beat nginx`. Migratsiya additive bo‘lsa sxemaga tegish shart emas.
- **Sxema buzilgan bo‘lsa:** `dc stop api worker-default worker-realtime worker-notify beat`, zaxiradan tiklang (quyida), keyin eski kodni ko‘taring. `migrate` ni orqaga (`migrate app 00NN`) faqat ma’lumot yo‘qotmaydigan holatda ishlating.
- Tezkor holat: `dc ps`, `dc logs -f --tail=200 <xizmat>`, Sentry (release bo‘yicha filtr).

## 6. Zaxira nusxalar

**PostgreSQL** (kamida kunlik, saqlash 14+ kun, nusxani boshqa joyga ko‘chiring). `/etc/cron.d/parkbor-backup`:

```cron
15 2 * * * root cd /opt/parkbor/infra && docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > /backups/parkbor-$(date +\%F).dump' && find /var/lib/docker/volumes/parkbor_pgbackups/_data -name '*.dump' -mtime +14 -delete
```

Tiklash sinovi (oyiga bir marta, alohida bazada): `pg_restore -U habi -d habi_restore --clean --if-exists /backups/parkbor-<sana>.dump`.
Aniq vaqtga qaytish (PITR) kerak bo‘lsa WAL arxivlash (`archive_mode`, pgBackRest/WAL-G) qo‘shing; bu stekda hozircha yo‘q.

**Redis (`redis`):** AOF (`appendfsync everysec`) + RDB snapshot yoqilgan, `redisdata` volume. Navbatdagi vazifalar va WS ticketlari qayta ishga tushganda saqlanadi (eng ko‘pi bilan ~1 s yo‘qotish). Volume ni Postgres nusxasi bilan birga zaxiralash shart emas (vazifalar idempotent, sweep lar qayta to‘ldiradi). `redis-cache` — o‘chiriladigan kesh, zaxira yo‘q. `noeviction` serverda `used_memory` `REDIS_MAXMEMORY` ga yaqinlashsa signal bering (to‘lsa yozuvlar xato beradi).

## 7. Maxfiy kalitlarni almashtirish (rotation)

| Kalit | Qanday |
|---|---|
| `QR_SIGNING_KEY` | eskisini `QR_SIGNING_KEY_FALLBACKS` ga o‘tkazing, yangisini `QR_SIGNING_KEY` ga yozing; bir QR umri (`BOOKING_QR_EXIT_MINUTES`, 12 soat) o‘tgach fallback ni olib tashlang |
| `SECRET_KEY` | almashtirilsa imzolangan eski qiymatlar (Django signing) yaroqsiz bo‘ladi: past trafik vaqtida, `dc up -d` bilan qayta ishga tushiring |
| `JWT_SIGNING_KEY` | almashtirish barcha foydalanuvchilarni chiqaradi (qayta kirish kerak); ogohlantirib bajaring |
| `TELEGRAM_BOT_TOKEN` | BotFather `/revoke`, yangisini `.env.prod` ga, `dc up -d`, webhook ni qayta o‘rnating (`set_telegram_webhook`) |
| `TELEGRAM_WEBHOOK_SECRET` | yangilab `set_telegram_webhook` ni qayta ishga tushiring |
| Payme/Click kalitlari | provayder kabinetida yangilab, `.env.prod` ni o‘zgartiring va ikkalasini bir vaqtda `dc up -d api worker-default` |
| Postgres/Redis parollari | `ALTER USER ... PASSWORD`/`CONFIG SET requirepass` + `.env.prod` dagi URL lar, so‘ng barcha ilova xizmatlarini qayta ishga tushiring |

Kalit sizib chiqqan bo‘lsa: avval almashtiring, keyin loglarni va Sentry ni tekshiring. Hech qachon kalitni gitga yozmang.

## 8. Telegram sozlamalari

- **BotFather `/setdomain`:** `/setdomain` -> botni tanlang -> `<ADMIN_DOMAIN>` (sxemasiz). Admin Login Widget faqat shu domenda ishlaydi; staging uchun alohida bot va domen.
- **Webhook:** `dc run --rm api python manage.py set_telegram_webhook --base-url https://<API_DOMAIN>` (maxfiy `TELEGRAM_WEBHOOK_SECRET` header sifatida o‘rnatiladi). Tekshirish: `https://api.telegram.org/bot<TOKEN>/getWebhookInfo` (tokenni terminal tarixiga qoldirmang).
- nginx ixtiyoriy ravishda Telegram diapazonlarini (149.154.160.0/20, 91.108.4.0/22) cheklashi mumkin (shablonda izoh bor).

## 9. Payme va Click webhooklari

- Provayder kabinetida URL: `https://<API_DOMAIN>/api/v1/payments/payme/webhook` va `https://<API_DOMAIN>/api/v1/payments/click/webhook` (faqat POST, tana <= 64 KB nginx da, ilova 16 KB dan oshganini rad etadi).
- nginx faqat shu ikki aniq yo‘lni webhook sifatida o‘tkazadi; admin domeni orqali `/api/v1/payments/` va `/api/v1/telegram/webhook` 404 qaytaradi.
- IP allowlist ilovada: `PAYMENTS_PAYME_IPS` (standart — Payme e’lon qilgan 185.234.113.1–15) va `PAYMENTS_CLICK_IPS` (CLICK support dan olinadi; bo‘sh qolsa `check --deploy` `payments.W001` beradi). `NUM_PROXIES=1` nginx ning `X-Forwarded-For` ni qayta yozishiga tayanadi: nginx ni CDN/LB orqasiga qo‘ysangiz, `nginx.conf` dagi `set_real_ip_from` ni va `NUM_PROXIES` ni qayta ko‘rib chiqing.
- `PAYMENTS_SANDBOX=false` bo‘lishi shart (prod aks holda ishga tushmaydi). Test to‘lovlar staging da.
- Kabinetda test to‘lov qilib, `WebhookEvent` va bron holatini (PAID -> CONFIRMED) tekshiring.

## 10. Loglar va Sentry

- nginx access log `$uri` ishlatadi (query yo‘q) va Referer ni yozmaydi, shuning uchun `?ticket=` diskka tushmaydi. `api` konteynerida uvicorn access log o‘chirilgan (`--no-access-log`). Eslatma: nginx **error** logi upstream xatosida so‘rov qatorini (query bilan) yozishi mumkin; ticket bir martalik va 30 s yashaydi, shuning uchun qabul qilingan xavf. Konteyner loglari `json-file`, 20 MB x 5.
- Sentry: `SENTRY_DSN` bo‘sh bo‘lsa o‘chiq. `SENTRY_ENVIRONMENT` (staging/production), `SENTRY_RELEASE` (image tegi / git SHA; Docker build arg `RELEASE` ham o‘rnatadi), `SENTRY_TRACES_SAMPLE_RATE` (0..1, standart 0). So‘rov tanasi hech qachon yuborilmaydi (`max_request_body_size="never"`), `send_default_pii=False`, bot tokeni/ticket/Expo token/QR token/to‘lov kalitlari tozalanadi (`backend/config/sentry.py`, `tests/test_sentry.py`).
- Mobil/admin Sentry: nomlar zaxiralangan (`EXPO_PUBLIC_SENTRY_DSN` EAS env orqali, `VITE_SENTRY_DSN` admin build arg orqali); SDK hali o‘rnatilmagan, shuning uchun ishlamaydi.

## 11. Mobil reliz (EAS)

`mobile/eas.json`: `development` (lokal API, sandbox ruxsat), `preview` (staging domen, APK, sandbox ruxsat), `production` (AAB, `EXPO_PUBLIC_PAYMENT_SANDBOX=false`).
`app.config.ts` production build da `EXPO_PUBLIC_PAYMENT_SANDBOX=true` bo‘lsa yoki haqiqiy Maps kaliti bo‘lmasa buildni **yiqitadi**; CI shuni tekshiradi.

```bash
eas env:create --environment production --name EXPO_PUBLIC_GOOGLE_MAPS_API_KEY --value <kalit> --visibility plaintext
eas env:create --environment production --name EXPO_PUBLIC_EAS_PROJECT_ID --value <id> --visibility plaintext
eas build -p android --profile production        # AAB -> Google Play
eas build -p ios --profile production
eas submit -p android --profile production        # track: internal (draft), so‘ng Play Console da oshiring
pnpm --filter mobile update:production -- --message "..."   # OTA (APP_ENV=production o‘rnatiladi)
```

`eas.json` ichidagi domen/bot nomlarini haqiqiylariga almashtiring (0-bo‘lim checklistida). Universal link (`https://<HABI_PUBLIC_URL>/b/<id>`) uchun `apple-app-site-association` / `assetlinks.json` ni `HABI_PUBLIC_URL` domenida xizmat qilish alohida vazifa (bu stekda yo‘q).

## 12. Tekshirilmagan / ma’lum cheklovlar

- Bu fayllar Docker mavjud bo‘lmagan muhitda yozilgan: `docker compose config`, image build va `nginx -t` **CI da** (`infra.yml`) birinchi marta ishlaydi. Birinchi deploydan oldin serverda `dc config -q` va `dc build` ni ishga tushiring.
- Ikki tekshiruv: **`GET /health/live`** — liveness, I/O yo‘q, autentifikatsiyasiz (`200 {"status":"ok"}`); `infra/healthcheck/api.py` (Docker healthcheck) shuni ishlatadi, chunki Redis/DB uzilganda sog‘lom API konteynerlari `unhealthy` bo‘lib qayta ishga tushmasligi kerak. **`GET /health`** — readiness: PostgreSQL (`SELECT 1`, 2 s) va Redis (`PING`, 2 s timeout) ikkalasi javob bersagina `200`, aks holda `503`; natija jarayon ichida 3 s keshlanadi (so‘rovlar oqimi DB/Redis ni yuklamaydi); tanada faqat tekshiruv nomi va `ok`/`fail`. Prod da `SECURE_REDIRECT_EXEMPT` ikkalasini ham kiritadi (HTTP probe 301 olmaydi). Nginx faqat `/health` ni tashqariga ochadi (`limit_req zone=api_general burst=5`), `/health/live` konteyner ichida qoladi. `HEALTH_PATH` bilan yo‘l almashtirish mumkin.
- OSRM healthcheck (`bash /dev/tcp`) va `osrm/osrm-backend:v5.27.1` tegi bevosita sinalmagan.
- Admin CSP (`'unsafe-eval'`) haqiqiy Telegram vidjeti bilan brauzerda sinab ko‘rilmagan (ARCHITECTURE 14.3): birinchi deploydan keyin tekshiring.
- WAL/PITR, Postgres read-replica, ikkinchi ASGI nusxa (load balancing) va avtomatik staging->production pipeline hozircha yo‘q.
