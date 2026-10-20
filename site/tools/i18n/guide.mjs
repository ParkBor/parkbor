// Guide page texts + Android download strings. Step tuple: [title, text(html), screenshot name(s), alt?]
// Screenshots live in site/assets/guide/<name>.webp|png and are included only if the file exists.
export const DL = {
  uz: { btn: 'Android ilovasini yuklab olish', note: 'Hozircha sinov (beta) versiyasi: Android uchun. O‘rnatishda «noma’lum manbalardan o‘rnatish»ga ruxsat bering. Google Play va App Store tez orada.' },
  ru: { btn: 'Скачать для Android', note: 'Пока это тестовая (бета) версия только для Android. При установке разрешите «установку из неизвестных источников». Google Play и App Store скоро.' },
  en: { btn: 'Download for Android', note: 'For now this is a test (beta) version for Android only. Allow “install from unknown sources” when installing. Google Play and App Store are coming soon.' },
};

const uz = {
  nav: 'Qo‘llanma',
  title: 'Qo‘llanma: ilovani o‘rnatish va foydalanish | ParkBor',
  desc: 'ParkBor qo‘llanmasi: haydovchi uchun o‘rnatishdan to‘lov va QR gacha, avtoturargoh egasi uchun CRM bo‘yicha qadamlar.',
  h1: 'ParkBor qo‘llanmasi',
  intro: 'Ikki qism: haydovchi uchun (mobil ilova) va avtoturargoh egasi uchun (ParkBor CRM). Har qadam qisqa.',
  driver: { h: 'A. Haydovchi uchun', steps: [
    ['Ilovani yuklab oling va o‘rnating', 'Yuqoridagi tugma orqali APK faylni yuklab oling va oching. «Noma’lum manbalardan o‘rnatish»ga ruxsat bering. Google Play Protect ogohlantirsa, «Batafsil», so‘ng «Baribir o‘rnatish» ni bosing.', '01-install', 'APK ni o‘rnatish oynasi'],
    ['Ilovani oching va tilni tanlang', 'Ilovani oching. Til tanlang: o‘zbekcha, ruscha yoki inglizcha.', '02-language', 'Til tanlash ekrani'],
    ['Telegram orqali kiring', 'Ilova @parkborbot botini ochadi. «Start» ni bosing. «Raqamni yuborish» tugmasini bosib, o‘z telefon raqamingizni ulashing. Ilovaga qayting va botdan kelgan 6 xonali kodni kiriting.', ['03-bot-start', '04-share-phone', '05-code'], 'Telegram botda kirish'],
    ['Ismingizni kiriting', 'Ilova ismingizni so‘raydi. Ismingizni yozing va davom eting.', '06-name', 'Ism kiritish'],
    ['Avtomobilingizni qo‘shing', 'Davlat raqamini kiriting. Keyin boshqa avtomobil qo‘shishingiz mumkin.', '07-vehicle', 'Avtomobil qo‘shish'],
    ['Ruxsatlarni bering', 'Joylashuvga ruxsat berish ixtiyoriy: u yaqin avtoturargohlarni topishga yordam beradi. Bildirishnomalarga ruxsat bering, shunda bron haqida xabar olasiz.', null],
    ['Xaritadan avtoturargoh toping', 'Xarita OpenStreetMap asosida. Avtoturargohni tanlab, tafsilotlarni oching. Joy turini va vaqtni tanlang.', ['08-map', '09-booking'], 'Xarita va bron'],
    ['To‘lang va QR oling', 'Bronni onlayn to‘lov provayderi orqali to‘lang. To‘lovdan keyin bron QR kodi paydo bo‘ladi.', '10-qr', 'Bron QR kodi'],
    ['Darvozada QR ni ko‘rsating', 'Kirishda operatorga QR kodni ko‘rsating. Bronni «Bronlar» bo‘limidan bekor qilish mumkin: avval qaytariladigan summa ko‘rsatiladi.', null],
    ['Profil', '«Profil» da tilni o‘zgartirish, ma’lumotlarni tahrirlash va «Hisobni o‘chirish» bor. Batafsil: <a href="{B}/delete-account/">Hisobni o‘chirish</a>.', null],
  ] },
  owner: { h: 'B. Avtoturargoh egasi uchun (CRM)', steps: [
    ['Egasi sifatida qo‘shilish', 'Egasini platforma ma’muri Telegram ID bo‘yicha qo‘shadi. O‘z Telegram ID ingizni ma’murga yuboring. Uni bilish uchun Telegram’da @userinfobot ga yozing.', null],
    ['CRM ga kiring', '<a href="https://crm.parkbor.uz" rel="noopener">crm.parkbor.uz</a> ni oching va Telegram orqali kiring.', 'crm-01-login', 'CRM kirish sahifasi'],
    ['Avtoturargoh qo‘shing', 'Nomini yozing, xaritada nuqtani belgilang: manzil o‘zi to‘ladi. Ish vaqtini kiriting.', 'crm-02-add-lot', 'Avtoturargoh qo‘shish'],
    ['Zonalar, joylar va tariflar', 'Zonalar va joylarni qo‘shing (joylarni ko‘plab yaratish mumkin). Keyin tariflarni belgilang.', 'crm-03-slots', 'Joylar va tariflar'],
    ['Ma’mur tasdiqlaydi', 'Platforma ma’muri avtoturargohni tasdiqlaydi. Shundan keyin u haydovchilarga ko‘rinadi.', 'crm-04-approve', 'Tasdiqlash'],
    ['Operatorlarni taklif qiling', 'CRM da taklif kodi yarating va operatorga yuboring. Operator ilovada «Profil», so‘ng «Operator sifatida qo‘shilish» orqali kodni kiritadi.', null],
    ['Kuzating', 'Bronlar, to‘lovlar va qaytarishlarni CRM da ko‘ring. Ma’lumotlarni Excel’ga yuklab oling.', null],
  ] },
  trouble: { h: 'Muammolar bo‘lsa', items: [
    ['Kod kelmayapti', 'Botda «Start» ni bosganingizni tekshiring. Keyin ilovada kodni qayta so‘rang.'],
    ['«Telegram ma’lumotlari yaroqsiz» chiqdi', 'Qaytadan urinib ko‘ring: Telegram orqali kirishni boshidan boshlang.'],
    ['Xarita bo‘sh', 'Internet ulanishini tekshiring va ilovani qayta oching.'],
    ['Sayt yoki CRM ochilmayapti', 'DNS ni 1.1.1.1 ga o‘zgartiring yoki Android’da «Private DNS» ga one.one.one.one ni kiriting.'],
  ] },
};

const ru = {
  nav: 'Руководство',
  title: 'Руководство: установка и работа с приложением | ParkBor',
  desc: 'Руководство ParkBor: для водителя от установки до оплаты и QR, для владельца парковки шаги в CRM.',
  h1: 'Руководство ParkBor',
  intro: 'Две части: для водителя (мобильное приложение) и для владельца парковки (ParkBor CRM). Каждый шаг короткий.',
  driver: { h: 'A. Для водителя', steps: [
    ['Скачайте и установите приложение', 'Скачайте APK по кнопке выше и откройте файл. Разрешите «установку из неизвестных источников». Если Google Play Protect предупредит, нажмите «Подробнее», затем «Всё равно установить».', '01-install', 'Окно установки APK'],
    ['Откройте приложение и выберите язык', 'Откройте приложение. Выберите язык: узбекский, русский или английский.', '02-language', 'Выбор языка'],
    ['Войдите через Telegram', 'Приложение откроет бота @parkborbot. Нажмите «Start». Нажмите кнопку отправки номера («Raqamni yuborish») и поделитесь СВОИМ номером. Вернитесь в приложение и введите 6-значный код от бота.', ['03-bot-start', '04-share-phone', '05-code'], 'Вход через Telegram-бота'],
    ['Введите имя', 'Приложение спросит ваше имя. Введите его и продолжайте.', '06-name', 'Ввод имени'],
    ['Добавьте автомобиль', 'Введите госномер. Позже можно добавить другие автомобили.', '07-vehicle', 'Добавление автомобиля'],
    ['Дайте разрешения', 'Доступ к местоположению необязателен: он помогает найти парковки рядом. Разрешите уведомления, чтобы получать сообщения о брони.', null],
    ['Найдите парковку на карте', 'Карта построена на OpenStreetMap. Выберите парковку и откройте подробности. Выберите тип места и время.', ['08-map', '09-booking'], 'Карта и бронь'],
    ['Оплатите и получите QR', 'Оплатите бронь онлайн через платёжного провайдера. После оплаты появится QR-код брони.', '10-qr', 'QR-код брони'],
    ['Покажите QR у шлагбаума', 'На въезде покажите QR оператору. Бронь можно отменить в разделе «Bronlar» (брони): сначала показывается сумма возврата.', null],
    ['Профиль', 'В «Профиле» можно сменить язык, изменить данные и удалить аккаунт. Подробнее: <a href="{B}/delete-account/">Удаление аккаунта</a>.', null],
  ] },
  owner: { h: 'B. Для владельца парковки (CRM)', steps: [
    ['Добавление как владельца', 'Владельца добавляет администратор платформы по Telegram ID. Отправьте ему свой Telegram ID. Узнать его можно у бота @userinfobot.', null],
    ['Войдите в CRM', 'Откройте <a href="https://crm.parkbor.uz" rel="noopener">crm.parkbor.uz</a> и войдите через Telegram.', 'crm-01-login', 'Страница входа в CRM'],
    ['Добавьте парковку', 'Укажите название и отметьте точку на карте: адрес заполнится сам. Укажите время работы.', 'crm-02-add-lot', 'Добавление парковки'],
    ['Зоны, места и тарифы', 'Добавьте зоны и места (места можно создавать массово). Затем задайте тарифы.', 'crm-03-slots', 'Места и тарифы'],
    ['Администратор подтверждает', 'Администратор платформы подтверждает парковку. После этого её видят водители.', 'crm-04-approve', 'Подтверждение'],
    ['Пригласите операторов', 'Создайте в CRM код-приглашение и передайте оператору. Оператор вводит код в приложении: «Профиль», затем «Присоединиться как оператор» (Operator sifatida qo‘shilish).', null],
    ['Следите за работой', 'Смотрите брони, платежи и возвраты в CRM. Выгружайте данные в Excel.', null],
  ] },
  trouble: { h: 'Если что-то не работает', items: [
    ['Код не приходит', 'Убедитесь, что вы нажали «Start» в боте. Затем запросите код в приложении ещё раз.'],
    ['Ошибка «Telegram ma’lumotlari yaroqsiz»', 'Попробуйте ещё раз: начните вход через Telegram заново.'],
    ['Карта пустая', 'Проверьте интернет и перезапустите приложение.'],
    ['Сайт или CRM не открывается', 'Смените DNS на 1.1.1.1 или в Android укажите в «Частном DNS» one.one.one.one.'],
  ] },
};

const en = {
  nav: 'Guide',
  title: 'Guide: install and use the app | ParkBor',
  desc: 'ParkBor guide: for drivers from installation to payment and QR, for lot owners the steps in the CRM.',
  h1: 'ParkBor guide',
  intro: 'Two parts: for drivers (mobile app) and for parking lot owners (ParkBor CRM). Every step is short.',
  driver: { h: 'A. For drivers', steps: [
    ['Download and install the app', 'Download the APK with the button above and open the file. Allow “install from unknown sources”. If Google Play Protect warns you, tap “More details”, then “Install anyway”.', '01-install', 'APK install dialog'],
    ['Open the app and choose a language', 'Open the app. Choose Uzbek, Russian or English.', '02-language', 'Language selection'],
    ['Sign in with Telegram', 'The app opens the bot @parkborbot. Press “Start”. Tap the share-number button (“Raqamni yuborish”) and share YOUR OWN phone number. Go back to the app and enter the 6-digit code from the bot.', ['03-bot-start', '04-share-phone', '05-code'], 'Signing in via the Telegram bot'],
    ['Enter your first name', 'The app asks for your first name. Type it and continue.', '06-name', 'Entering your name'],
    ['Add your car', 'Enter the plate number. You can add more cars later.', '07-vehicle', 'Adding a car'],
    ['Allow permissions', 'Location is optional: it helps find lots near you. Allow notifications to get booking messages.', null],
    ['Find a lot on the map', 'The map is based on OpenStreetMap. Pick a lot and open its details. Choose the slot type and the time.', ['08-map', '09-booking'], 'Map and booking'],
    ['Pay and get your QR', 'Pay for the booking online through the payment provider. After payment the booking QR code appears.', '10-qr', 'Booking QR code'],
    ['Show the QR at the gate', 'At entry show the QR to the operator. You can cancel a booking in “Bronlar” (bookings): the refund amount is shown first.', null],
    ['Profile', 'In “Profil” you can change the language, edit your details and delete the account. More: <a href="{B}/delete-account/">Delete account</a>.', null],
  ] },
  owner: { h: 'B. For lot owners (CRM)', steps: [
    ['Get added as an owner', 'A platform admin adds the owner by Telegram ID. Send the admin your Telegram ID. You can get it from the bot @userinfobot.', null],
    ['Sign in to the CRM', 'Open <a href="https://crm.parkbor.uz" rel="noopener">crm.parkbor.uz</a> and sign in with Telegram.', 'crm-01-login', 'CRM sign-in page'],
    ['Add a parking lot', 'Enter the name and pick the point on the map: the address fills in automatically. Set the working hours.', 'crm-02-add-lot', 'Adding a lot'],
    ['Zones, slots and tariffs', 'Add zones and slots (slots can be created in bulk). Then set the tariffs.', 'crm-03-slots', 'Slots and tariffs'],
    ['The admin approves', 'A platform admin approves the lot. After that drivers can see it.', 'crm-04-approve', 'Approval'],
    ['Invite operators', 'Create an invite code in the CRM and send it to the operator. The operator enters it in the app: “Profil”, then “Operator sifatida qo‘shilish” (join as operator).', null],
    ['Keep watch', 'See bookings, payments and refunds in the CRM. Export data to Excel.', null],
  ] },
  trouble: { h: 'Troubleshooting', items: [
    ['The code does not arrive', 'Make sure you pressed “Start” in the bot. Then request the code again in the app.'],
    ['“Telegram ma’lumotlari yaroqsiz” appears', 'Try again: restart the Telegram sign-in from the beginning.'],
    ['The map is empty', 'Check your internet connection and reopen the app.'],
    ['The site or CRM does not open', 'Change your DNS to 1.1.1.1, or on Android set “Private DNS” to one.one.one.one.'],
  ] },
};

export const GUIDE = { uz, ru, en };
