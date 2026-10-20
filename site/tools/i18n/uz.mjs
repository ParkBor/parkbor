// Uzbek (default language, served at /). Placeholder {B} = language base path ("" | "/ru" | "/en").
export default {
  code: 'uz', htmlLang: 'uz', base: '', ogLocale: 'uz_UZ', label: 'UZ',
  ui: { skip: 'Asosiy mazmunga o‘tish', menu: 'Menyu', logoAlt: 'ParkBor', home: 'Bosh sahifa', langNav: 'Til' },
  nav: { how: 'Qanday ishlaydi', benefits: 'Imkoniyatlar', drivers: 'Haydovchilar', faq: 'Savollar', contact: 'Bog‘lanish' },
  home: {
    title: 'ParkBor: avtoturargohingiz bandligini oshiring',
    desc: 'ParkBor avtoturargoh egalariga joylarni oldindan bron qilish, onlayn to‘lov, QR nazorat va CRM hisobotlarini beradi. Haydovchilar uchun mobil ilova.',
    eyebrow: 'Avtoturargoh egalari uchun',
    h1: 'Avtoturargohingiz bandligini oshiring',
    sub: 'Haydovchilar joyni ilovada oldindan bron qilib, to‘lab qo‘yadi. Siz esa joylar, daromad va bandlikni ParkBor CRM’da bir joyda ko‘rasiz.',
    cta1: 'ParkBor CRM ga kirish', cta2: 'Bog‘lanish',
    how: { h: 'Egalar uchun 3 qadam', items: [
      ['Avtoturargohni CRM’ga joylaysiz', 'Joylar sonini, narxni va ish vaqtini kiritasiz.'],
      ['Haydovchilar oldindan bron qiladi', 'Haydovchi ilovada bo‘sh joyni topadi, bron qiladi va onlayn to‘laydi.'],
      ['Operator darvozada QR bilan kiritadi', 'Siz CRM’da daromad va bandlikni kuzatasiz.'],
    ] },
    benefits: { h: 'CRM nimalarni beradi', intro: 'Quyida faqat tizimda haqiqatan mavjud imkoniyatlar keltirilgan.', items: [
      ['Joylar holati', 'Har bir avtoturargohdagi bo‘sh, band va bron qilingan joylar CRM’da ko‘rinib turadi.'],
      ['Onlayn to‘lov', 'Haydovchi bronni to‘lov provayderi orqali oldindan to‘laydi.'],
      ['QR nazorat', 'Kirish va chiqishda operator haydovchining QR kodini skanerlaydi. Kodlar imzolangan va bir martalik.'],
      ['Hisobotlar va Excel', 'Bronlar, daromad va bandlik bo‘yicha statistika; ma’lumotlarni Excel’ga yuklab olish mumkin.'],
      ['Operatorlar', 'Darvozadagi xodimlarni taklif kodi bilan biriktirasiz. Ular ilovada QR skanerlaydi.'],
      ['Telegram bildirishnomalar', 'Bron bo‘yicha xabarlar Telegram bot va ilova bildirishnomalari orqali keladi.'],
    ] },
    drivers: { h: 'Haydovchilar uchun', p: 'Haydovchilar ParkBor mobil ilovasidan foydalanadi: yaqin atrofdagi avtoturargohni topadi, joyni bron qiladi, to‘laydi va kirishda QR kodni ko‘rsatadi.',
      points: ['Xaritada avtoturargohlarni topish', 'Joyni oldindan bron qilish va to‘lash', 'Kirish va chiqishda QR kod'],
      soon: 'Tez orada', bot: 'Telegram bot @parkborbot', botNote: 'Kirish Telegram orqali amalga oshadi.' },
    faq: { h: 'Ko‘p so‘raladigan savollar', items: [
      ['Qanday boshlayman?', 'Biz bilan bog‘laning. Shartlarni kelishib, Telegram akkauntingizni avtoturargoh egasi sifatida biriktiramiz. Keyin Telegram orqali ParkBor CRM’ga kirasiz va avtoturargohingizni qo‘shasiz.'],
      ['Xizmat qancha turadi?', 'Shartlar bo‘yicha bog‘laning. Narx va komissiyani bu yerda e’lon qilmaymiz.'],
      ['Mening ma’lumotlarimni kim ko‘radi?', 'Avtoturargoh egasi faqat o‘z avtoturargohlari bo‘yicha bronlarni ko‘radi. Operator darvozada kerakli bron ma’lumotini ko‘radi. Platforma ma’murlari tizimni boshqarish uchun kirish huquqiga ega. Batafsil: <a href="{B}/privacy/">Maxfiylik siyosati</a>.'],
      ['Haydovchi to‘lovni qanday qiladi?', 'Haydovchi bronni ilovada to‘lov provayderi sahifasi orqali to‘laydi. Bank kartasi ma’lumotlari ParkBor’da saqlanmaydi.'],
      ['Operatorlar kerakmi?', 'Darvozada bronlarni QR bilan qabul qilish uchun operator biriktirish mumkin. Egasi operatorni taklif kodi bilan CRM’dan qo‘shadi.'],
      ['Hisobni qanday o‘chirish mumkin?', 'Haydovchi ilovada Profil, so‘ng Akkauntni o‘chirish bo‘limiga kiradi. Shartlar: <a href="{B}/delete-account/">Hisobni o‘chirish</a>.'],
    ] },
    contact: { h: 'Bog‘lanish', p: 'Savol yoki hamkorlik bo‘yicha yozing yoki qo‘ng‘iroq qiling. Saytda ma’lumot yig‘uvchi forma yo‘q.', tg: 'Telegram: @habibullo_2313', email: 'E-pochta: parkbooor@gmail.com' },
  },
  footer: { privacy: 'Maxfiylik siyosati', terms: 'Foydalanish shartlari', del: 'Hisobni o‘chirish', crm: 'ParkBor CRM', bot: 'Telegram bot', rights: 'ParkBor. Barcha huquqlar himoyalangan.' },
  legalCommon: { updated: 'Oxirgi yangilanish', draft: 'Yuridik shaxs nomi, manzili va STIR keyin qo‘shiladi.' },
  privacy: {
    title: 'Maxfiylik siyosati | ParkBor', desc: 'ParkBor qanday shaxsiy ma’lumotlarni yig‘adi, nima uchun, kim bilan ulashadi va qancha saqlaydi.', h1: 'Maxfiylik siyosati',
    sections: [
      ['1. Operator va qamrov', '<p>[Operator: ParkBor, contact email parkbooor@gmail.com]</p><p>Ushbu siyosat ParkBor mobil ilovasi, ParkBor CRM (crm.parkbor.uz), parkbor.uz sayti va Telegram bot @parkborbot uchun amal qiladi.</p>'],
      ['2. Qanday ma’lumotlar yig‘iladi', `<ul>
<li><strong>Telegram orqali kirish:</strong> Telegram ID, ism, username. Telefon raqami faqat botga o‘zingiz ulashsangiz saqlanadi.</li>
<li><strong>Avtomobil:</strong> siz kiritgan davlat raqami va turi.</li>
<li><strong>Bronlar va to‘lovlar:</strong> avtoturargoh, vaqt, summa, holat. Bank kartasi ma’lumotlari ParkBor’da saqlanmaydi, ular to‘lov provayderi sahifasida kiritiladi.</li>
<li><strong>Qurilma bildirishnoma tokeni</strong> (push), bildirishnoma yuborish uchun.</li>
<li><strong>Taxminiy joylashuv:</strong> faqat ruxsat bersangiz va xaritadan foydalanayotganda; yaqin atrofdagi avtoturargohlarni topish uchun taxminan 110 m gacha yaxlitlangan holda yuboriladi.</li>
<li><strong>Kamera:</strong> faqat operatorlar QR kodni skanerlashi uchun; suratlar saqlanmaydi.</li>
<li><strong>Avtoturargoh egalari va operatorlar (CRM):</strong> avtoturargoh ma’lumotlari, narxlar, operatorlar ro‘yxati va muhim amallar jurnali (audit).</li>
<li><strong>Texnik jurnallar:</strong> xatolar monitoringi va serverlar jurnali; ular shaxsiy ma’lumotlarsiz yuritilishi uchun sozlangan. IP manzillar infratuzilma jurnallarida qolishi mumkin.</li>
<li><strong>Veb-sayt:</strong> cookie, reklama va tahlil vositalari ishlatilmaydi. Hech qanday forma yo‘q.</li></ul>`],
      ['3. Nima uchun ishlatiladi', '<p>Kirishni ta’minlash, bron va to‘lovlarni amalga oshirish, bildirishnomalar yuborish, suiiste’molning oldini olish, tizim xavfsizligi va hisob-kitob yuritish uchun. Ma’lumotlar reklama maqsadida sotilmaydi.</p>'],
      ['4. Xizmat ko‘rsatuvchi uchinchi tomonlar', `<ul>
<li>Railway: serverlar va ma’lumotlar bazasi hostingi.</li>
<li>Cloudflare: DNS, sayt va xarita trafigini yetkazish.</li>
<li>Telegram: kirish va bildirishnomalar.</li>
<li>Expo: ilova bildirishnomalarini (push) yetkazish.</li>
<li>To‘lov provayderlari: to‘lovni qabul qilish.</li>
<li>OpenStreetMap / OpenFreeMap: xarita plitkalari (qurilma IP manzili va ko‘rilayotgan hudud plitkalar provayderiga ko‘rinadi).</li>
<li>Nominatim (OpenStreetMap): CRM’da manzil qidirish.</li>
<li>Xatolar monitoringi (Sentry): shaxsiy ma’lumotlarsiz.</li></ul>
<p>Ma’lumotlar O‘zbekiston tashqarisidagi infratuzilmada ishlanishi mumkin.</p>`],
      ['5. Saqlash muddati', `<ul>
<li>Hisob ma’lumotlari: hisob faol bo‘lgan davrda; o‘chirilganda ism, username, telefon tozalanadi.</li>
<li>Bron va to‘lov yozuvlari: hisob-kitob uchun saqlanadi, hisob o‘chirilgandan keyin shaxssizlantirilgan holda.</li>
<li>Bildirishnomalar jurnali: 180 kun.</li>
<li>Audit jurnali: sukut bo‘yicha 365 kun; unda davlat raqami niqoblangan.</li>
<li>Bildirishnoma tokenlari: chiqishda yoki hisob o‘chirilganda o‘chiriladi.</li>
<li>Infratuzilma jurnallari: qisqa muddat.</li></ul>`],
      ['6. Sizning huquqlaringiz', '<p>Siz o‘z ma’lumotlaringiz haqida ma’lumot olish, ularni tuzatish yoki o‘chirishni so‘rash, joylashuv va kamera ruxsatlarini qurilma sozlamalarida istalgan vaqtda o‘chirish huquqiga egasiz. Haydovchi hisobini ilovada o‘zi o‘chiradi: <a href="{B}/delete-account/">Hisobni o‘chirish</a>. Boshqa so‘rovlar uchun parkbooor@gmail.com ga yozing.</p>'],
      ['7. Xavfsizlik', '<p>Aloqa HTTPS orqali; ilovada yangilash tokeni qurilmaning xavfsiz xotirasida saqlanadi; QR kodlar imzolangan va bir martalik; kirish huquqlari rollar bo‘yicha cheklangan; muhim amallar jurnalga yoziladi. Mutlaq xavfsizlikni kafolatlab bo‘lmaydi.</p>'],
      ['8. O‘zgarishlar', '<p>Siyosat yangilanishi mumkin. Joriy versiya shu sahifada, yuqoridagi sana bilan e’lon qilinadi.</p>'],
      ['9. Aloqa', '<p>parkbooor@gmail.com</p>'],
    ],
  },
  terms: {
    title: 'Foydalanish shartlari | ParkBor', desc: 'ParkBor xizmatidan foydalanish shartlari: hisob, bron, to‘lov, avtoturargoh egalari va foydalanuvchilar majburiyatlari.', h1: 'Foydalanish shartlari',
    sections: [
      ['1. Umumiy qoidalar', '<p>[Operator: ParkBor, contact email parkbooor@gmail.com]</p><p>ParkBor mobil ilovasi, ParkBor CRM va parkbor.uz saytidan foydalanib, siz ushbu shartlarga rozilik bildirasiz. Rozi bo‘lmasangiz, xizmatdan foydalanmang.</p>'],
      ['2. Xizmat tavsifi', '<p>ParkBor haydovchilarga avtoturargohlarda joyni oldindan bron qilish va to‘lash, egalariga esa joylarni boshqarish va hisobotlarni ko‘rish imkonini beradi. Avtoturargohlarni egalari boshqaradi; ParkBor bron va to‘lov vositasi hisoblanadi.</p>'],
      ['3. Hisob', '<p>Kirish Telegram orqali amalga oshadi. Hisobingiz xavfsizligi va kiritgan ma’lumotlaringiz to‘g‘riligi uchun siz javobgarsiz. Hisobingizni boshqalarga bermang.</p>'],
      ['4. Bron va to‘lov', '<p>Bron narxi, vaqti va bekor qilish qoidalari to‘lovdan oldin ilovada ko‘rsatiladi. To‘lov muddati cheklangan; muddat o‘tsa, bron bekor bo‘lishi mumkin. Belgilangan vaqtdan ortiq turish qo‘shimcha to‘lovga olib kelishi mumkin. Qaytarish ilovada ko‘rsatilgan qoidalarga muvofiq amalga oshiriladi.</p>'],
      ['5. Avtoturargoh egalari', '<p>Egasi avtoturargoh ma’lumotlari, narxlari va ish vaqtining to‘g‘riligi hamda bron qilingan joyning haydovchiga berilishi uchun javobgar. Operatorlar o‘z roziligi bilan taklif kodi orqali biriktiriladi. Moliyaviy shartlar alohida kelishiladi: bog‘lanish bo‘limiga qarang.</p>'],
      ['6. Taqiqlanadigan harakatlar', '<ul><li>Soxta ma’lumot kiritish yoki boshqa odam nomidan harakat qilish.</li><li>Tizimga ruxsatsiz kirish, uni buzish yoki yuklamani sun’iy oshirish.</li><li>QR kodlarni soxtalashtirish yoki boshqalarga berish.</li><li>Xizmatni qonunga zid maqsadda ishlatish.</li></ul>'],
      ['7. Javobgarlik chegarasi', '<p>Xizmat “mavjud holatda” taqdim etiladi. Qonun ruxsat etgan darajada ParkBor avtoturargohdagi mulk yoki egasining harakatlari uchun javobgar bo‘lmaydi. Qonun bilan belgilangan iste’molchi huquqlari saqlanadi.</p>'],
      ['8. Hisobni o‘chirish', '<p>Hisobni istalgan vaqtda o‘chirishingiz mumkin: <a href="{B}/delete-account/">Hisobni o‘chirish</a>. Shartlar buzilsa, hisobga kirish cheklanishi mumkin.</p>'],
      ['9. O‘zgarishlar va qonun', '<p>Shartlar yangilanishi mumkin; joriy versiya shu sahifada e’lon qilinadi. Shartlarga O‘zbekiston Respublikasi qonunchiligi qo‘llaniladi.</p>'],
      ['10. Aloqa', '<p>parkbooor@gmail.com</p>'],
    ],
  },
  del: {
    title: 'Hisobni o‘chirish | ParkBor', desc: 'ParkBor ilovasida hisobni qanday o‘chirish, nimalar o‘chiriladi va nimalar hisob-kitob uchun saqlanadi.', h1: 'Hisobni o‘chirish',
    sections: [
      ['Ilovada o‘chirish (haydovchi)', '<ol><li>ParkBor ilovasini oching va hisobingizga kiring.</li><li><strong>Profil</strong> bo‘limiga o‘ting.</li><li><strong>Akkauntni o‘chirish</strong> tugmasini bosing va tasdiqlang.</li></ol><p>Ilovaga kira olmasangiz, pastdagi aloqa bo‘limiga qarang.</p>'],
      ['Qachon o‘chirib bo‘lmaydi', '<ul><li>Faol yoki kelgusi bron bor (to‘lov kutilmoqda, tasdiqlangan, joyda turibdi yoki muddati oshgan).</li><li>Hisob avtoturargohga egalik qiladi. Avval avtoturargohni topshirish yoki o‘chirish kerak.</li><li>Siz platformaning oxirgi faol ma’murisiz.</li></ul><p>Sabab ilovada ko‘rsatiladi. Shartlar bajarilgach, qayta urinib ko‘ring.</p>'],
      ['Nima o‘chiriladi', '<ul><li>Ism, username va telefon raqami tozalanadi.</li><li>Telegram ID almashtiriladi va hisobga bog‘lanmaydi.</li><li>Qurilma bildirishnoma tokenlari o‘chadi, sessiyalar bekor qilinadi.</li><li>Operator sifatida biriktirishlar tugatiladi.</li></ul>'],
      ['Nima saqlanadi', '<p>Bronlar va to‘lovlar hisob-kitob va qonuniy talablar uchun saqlanadi, lekin sizga bog‘lanmagan, shaxssizlantirilgan holda. Bildirishnomalar jurnali 180 kundan keyin o‘chiriladi.</p><p>Xohlasangiz, o‘sha Telegram akkaunt bilan keyin yangi hisob ochishingiz mumkin.</p>'],
      ['Aloqa', '<p>Ilovadan o‘chira olmasangiz, parkbooor@gmail.com ga yozing yoki Telegram <a href="https://t.me/habibullo_2313">@habibullo_2313</a> ga murojaat qiling. Shaxsingizni tasdiqlash uchun Telegram username yoki ID so‘ralishi mumkin. Egalar va operatorlar ham shu manzillarga yozadi.</p>'],
    ],
  },
  b: { title: 'ParkBor ilovasida ochish', h1: 'Bronni ilovada oching', open: 'ParkBor ilovasida ochish', hint: 'Ilova o‘rnatilgan bo‘lishi kerak.', bad: 'Havola noto‘g‘ri', badHint: 'Havolani Telegram xabaridan qayta oching.', home: 'ParkBor saytiga o‘tish', noscript: 'Bu sahifa uchun JavaScript kerak.' },
  notFound: { title: 'Sahifa topilmadi | ParkBor', h1: 'Sahifa topilmadi', p: 'Bunday sahifa yo‘q yoki ko‘chirilgan.', home: 'Bosh sahifaga' },
};
