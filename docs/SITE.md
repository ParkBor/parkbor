# ParkBor sayti (parkbor.uz)

Statik sayt: HTML/CSS/JS, framework yo‘q, npm bog‘liqliklari yo‘q, Cloudflare Pages `site/` papkasidan to‘g‘ridan-to‘g‘ri chiqaradi (build buyrug‘i yo‘q).

## Tuzilma

```
site/
  index.html, privacy/, terms/, delete-account/      uz (asosiy til, /)
  ru/…  en/…                                        ru va en nusxalari (/ru/, /en/)
  b/index.html                                      parkbor://booking/<id> yordamchi sahifa
  404.html, robots.txt, sitemap.xml
  _headers, _redirects                              Cloudflare Pages sozlamalari (CSP, kesh, /b/* qayta yozish)
  .well-known/security.txt                          aloqa parkbooor@gmail.com, amal qilish 2027-10-20
  favicon.svg, favicon.png, apple-touch-icon.png
  assets/site.css, site.js, parkbor-logo.png, parkbor-mark.png, og-image.png
  tools/build.mjs, tools/i18n/{uz,ru,en}.mjs        HTML generatori (faqat dasturchi uchun)
  tests/                                            node --test
```

Rasmlar `admin/public` dan nusxalangan (logo 640x216, belgi 256x256, favicon, og-image 1200x630); jami `assets/` ~ 240 KB, sahifa HTML ~ 8-14 KB.

## Matnlarni tahrirlash

HTML fayllar `site/tools/build.mjs` bilan **generatsiya qilinadi** (3 til bir xil tuzilishda bo‘lishi uchun). Matnlar `site/tools/i18n/uz.mjs`, `ru.mjs`, `en.mjs` da. Tahrirdan keyin:

```
node site/tools/build.mjs     # HTML va sitemap.xml ni qayta yozadi
cd site && node --test        # testlar
```

Natijaviy HTML gitga kiritiladi; Cloudflare generatorni ishga tushirmaydi. Yagona matnni qo‘lda HTML’da tuzatish ham mumkin, lekin keyingi `build.mjs` uni qayta yozadi. Sahifa tuzilishi (bo‘limlar) `build.mjs` da. `assets/*` o‘zgarsa, `build.mjs` dagi `V` ni oshiring (fayllar `?v=` bilan chaqiriladi, `/assets/*` bir yil keshlanadi). Sana (`UPDATED`) huquqiy matn o‘zgarganda yangilanadi.

Kontaktlar (Telegram, telefonlar, e-pochta) `build.mjs` va i18n fayllarda; testlar faqat ruxsat etilgan ro‘yxatdagi `tel:`/`mailto:`/`t.me` havolalarini qabul qiladi.

## Cloudflare Pages sozlash

1. Cloudflare dashboard, **Workers & Pages**, **Create**, **Pages**, **Connect to Git**.
2. Repozitoriy: `ParkBor/parkbor`. Production branch: `main`.
3. Framework preset: **None**. Build command: bo‘sh. **Build output directory: `site`**. Deploy.
4. Keyin **Custom domains**: `parkbor.uz` qo‘shing; `www.parkbor.uz` ni ham qo‘shib, `parkbor.uz` ga yo‘naltiring (Redirect Rule: `www.parkbor.uz/*` -> `https://parkbor.uz/$1`, 301).
5. DNS dagi `api` va `crm` CNAME yozuvlariga tegmang.
6. Tekshiruv: `https://parkbor.uz/`, `/ru/`, `/en/`, `/privacy/`, `/b/123e4567-e89b-12d3-a456-426614174000`, `/.well-known/security.txt`, sarlavhalar (`curl -I`) va CSP konsol xatolarisiz.

CSP skriptni faqat `'self'` dan ruxsat beradi; JSON-LD (`type="application/ld+json"`) bajariladigan skript emas, shuning uchun CSP buzilmaydi.

## `/b/` chuqur havola yordamchisi

`/b/*  /b/index.html  200` (`_redirects`). `assets/site.js` `location.pathname` dan id ni oladi, qat’iy UUID regexi bilan tekshiradi va faqat tekshirilgan id dan `parkbor://booking/<id>` havolasini yasaydi. Noto‘g‘ri bo‘lsa “Havola noto‘g‘ri” (kiritilgan matn aks ettirilmaydi). Avto-yo‘naltirish yo‘q, kuzatuv yo‘q. Sahifa `noindex`, `robots.txt` da yopiq.

### assetlinks.json / apple-app-site-association (HALI QILINMAGAN)

Imzo barmoq izi kerak, shuning uchun hozir yaratilmagan. Keyin:

- **Android** (`site/.well-known/assetlinks.json`): `cd mobile && eas credentials` (Android, production keystore) dan **SHA-256** ni oling (yoki Play Console, App signing). Fayl:
  ```json
  [{"relation":["delegate_permission/common.handle_all_urls"],
    "target":{"namespace":"android_app","package_name":"uz.parkbor.app",
              "sha256_cert_fingerprints":["AA:BB:..."]}}]
  ```
  So‘ng ilovada `app.config.ts` da `https://parkbor.uz/b/` uchun `intentFilters` (`autoVerify: true`) kerak.
- **iOS** (`site/.well-known/apple-app-site-association`, kengaytmasiz, `Content-Type: application/json`): `{"applinks":{"details":[{"appIDs":["<TEAMID>.uz.parkbor.app"],"components":[{"/":"/b/*"}]}]}}`; `associatedDomains: ["applinks:parkbor.uz"]`. `_headers` ga shu fayl uchun `Content-Type: application/json` qo‘shing.
- Ikkala fayl uchun `/.well-known/*` allaqachon qisqa keshlangan; yo‘naltirish bo‘lmasligi kerak.

## Rang kontrasti (WCAG AA, 4.5:1)

`site/tests/contrast.test.js` `site.css` tokenlaridan hisoblaydi (`node site/tests/contrast.test.js` jadval chiqaradi).

| Mavzu | Juft | Nisbat |
|---|---|---|
| light | matn #0b1220 / fon #ffffff | 18.72 |
| light | matn / sirt #f3f7fc | 17.40 |
| light | xira #475467 / fon | 7.69 |
| light | xira / sirt | 7.15 |
| light | havola #0057b5 / fon | 6.93 |
| light | havola / sirt | 6.44 |
| light | tugma matni #ffffff / #0057b5 | 6.93 |
| light | yashil matn #177a32 / fon | 5.43 |
| light | yashil matn / sirt | 5.05 |
| dark | matn #e6edf7 / fon #0b0f17 | 16.28 |
| dark | matn / sirt #131a26 | 14.81 |
| dark | xira #a9b4c6 / fon | 9.16 |
| dark | xira / sirt | 8.34 |
| dark | havola #4da3ff / fon | 7.30 |
| dark | havola / sirt | 6.65 |
| dark | tugma matni #0b0f17 / #4da3ff | 7.30 |
| dark | yashil matn #3cc755 / fon | 8.67 |
| dark | yashil matn / sirt | 7.89 |
| dark | logotip plitasi #ffffff / “Park” #0057b5 | 6.93 |

Yorqin yashil #3cc755 (#ffffff da 2.2:1) faqat bezak (kartalar chizig‘i), matnda yorug‘ mavzuda #177a32 ishlatiladi. Qorong‘i rejimda logotip oq plita ustida ko‘rinadi.

## Huquqiy ko‘rib chiqish ro‘yxati (MAJBURIY: huquqshunos)

Maxfiylik siyosati, Foydalanish shartlari va Hisobni o‘chirish matnlari tizim haqiqatan yig‘adigan narsalar asosida yozilgan, lekin **yuridik ko‘rikdan o‘tmagan**.

- [ ] Operator: hozir `[Operator: ParkBor, contact email parkbooor@gmail.com]`. Yuridik shaxs nomi, STIR (INN), manzil, rahbar **to‘ldirilishi kerak** (uchala tilda, ikkala hujjatda; sahifadagi “keyin qo‘shiladi” izohini olib tashlang).
- [ ] O‘zbekistonning “Shaxsga doir ma’lumotlar to‘g‘risida”gi qonuni: ma’lumotlarni mahalliylashtirish (serverlar Railway/xorijda), ro‘yxatdan o‘tkazish, rozilik shakli, trans-chegaraviy uzatish.
- [ ] Qayta ishlovchilar ro‘yxati (Railway, Cloudflare, Telegram, Expo, to‘lov provayderlari, OpenFreeMap/OSM, Nominatim, Sentry) haqiqiy sozlamaga mos ekani (masalan Sentry yoqilganmi, qaysi to‘lov provayderi ishlaydi).
- [ ] Saqlash muddatlari: bildirishnoma jurnali 180 kun (kod bo‘yicha), audit 365 kun (`AUDIT_RETENTION_DAYS` standarti; prod qiymatini tekshiring), infratuzilma jurnallari “qisqa muddat” (aniq muddat belgilanmagan).
- [ ] Bron/to‘lov yozuvlarini hisob uchun saqlash muddati va asosi (soliq/buxgalteriya talablari).
- [ ] Shartlarda javobgarlik cheklovi, qaytarish/bekor qilish, oshib turish to‘lovi, iste’molchi huquqlari, nizolarni hal qilish tartibi (sud/arbitraj) va ofertaga muvofiqlik.
- [ ] Ilova do‘konlari talablari (Google Play Data safety, App Store privacy labels) siyosat bilan mos; hisobni o‘chirish URL i: `https://parkbor.uz/delete-account/`.
- [ ] Narx/komissiya matnda ataylab yo‘q (“shartlar bo‘yicha bog‘laning”).

## Tekshiruv natijalari va nima QILINMAGAN

- `cd site && node --test`: HTML tuzilmasi, bitta h1, lang, canonical/hreflang, OG/Twitter, JSON-LD, ichki havolalar, inline skript/handler yo‘qligi, ruxsat etilgan kontaktlar, sitemap, `_headers`/`_redirects`, UUID tekshiruvchi, kontrast. (Faqat regex asosidagi tekshiruvlar, to‘liq HTML validator emas.)
- Haqiqiy brauzerlarda ko‘rinish, 320-1440 px moslashuvi, dark rejim, klaviatura bilan yurish, Lighthouse/axe, Cloudflare’da CSP va sarlavhalar — **tekshirilmagan**.
- App Store / Google Play tugmalari o‘chirilgan (“Tez orada”); ilova ro‘yxatdan o‘tgach havola qo‘shiladi.
- `assetlinks.json` va `apple-app-site-association` yaratilmagan (yuqoriga qarang).
- Analitika, cookie, forma, uchinchi tomon shriftlari ataylab yo‘q. Rasmiy hujjatlarda yuridik shaxs ma’lumotlari yo‘q.
