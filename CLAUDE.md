# Habi — avtoturargoh bron qilish tizimi
To‘liq arxitektura: docs/ARCHITECTURE.md. Unga zid ish qilma; o‘zgartirish kerak bo‘lsa, avval hujjatni yangila.

## Tuzilma
- backend/ — Django 5 + DRF + GeoDjango + Channels + Celery (Python 3.12)
- mobile/ — Expo (React Native, TypeScript), Expo Router
- admin/ — React 19 + Vite + Ant Design 5 (@ant-design/v5-patch-for-react-19)
- packages/api-client — OpenAPI’dan generatsiya, qo‘lda tahrirlanmaydi

## Qoidalar
- Django admin ishlatilmaydi (django.contrib.admin o‘chirilgan).
- Kirish faqat Telegram orqali (bot kodi yoki Login Widget). SMS qo‘shma; parol faqat super admin zaxira kirishi uchun.
- Biznes mantiq faqat services.py da, o‘qish so‘rovlari selectors.py da; viewlar ingichka.
- Bron holati faqat bookings/services.py orqali o‘zgaradi.
- Pul — Decimal; vaqt — timezone-aware (Asia/Tashkent), bazada UTC.
- Har yangi endpoint: serializer + permission + test + drf-spectacular sxemasi.
- Mobil va admin’dagi barcha matnlar i18n orqali (uz, ru, en).
- Maxfiy kalitlar faqat .env da; .env.example ni yangilab bor.

## Buyruqlar
- Backend: `docker compose up -d db redis` · `cd backend && pytest` · `ruff check .`
- API klient: `pnpm --filter @habi/api-client generate`
- Mobil: `cd mobile && npx expo start` · `pnpm --filter mobile test`
- Admin: `pnpm --filter admin dev` · `pnpm --filter admin test`
