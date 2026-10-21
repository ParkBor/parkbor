// Guide page texts + Android download strings.
// Step tuple: [title, text(html), [image names]]. Image files: assets/guide/<name>.webp|png (real screenshots, win)
// or assets/guide/<name>.<lang>.svg (schematic, made by make-illustrations.mjs). Alt texts: ALT[lang][name].
// Button/menu names below are the REAL labels from mobile/src/i18n/*.json and the bot (messages.py).
export const DL = {
  uz: { btn: 'Android ilovasini yuklab olish', note: 'Hozircha sinov (beta) versiyasi: Android uchun. O‘rnatishda «noma’lum manbalardan o‘rnatish»ga ruxsat bering. Google Play va App Store tez orada.' },
  ru: { btn: 'Скачать для Android', note: 'Пока это тестовая (бета) версия только для Android. При установке разрешите «установку из неизвестных источников». Google Play и App Store скоро.' },
  en: { btn: 'Download for Android', note: 'For now this is a test (beta) version for Android only. Allow “install from unknown sources” when installing. Google Play and App Store are coming soon.' },
};

export const CAPTION_SUFFIX = { uz: 'Namunaviy ko‘rinish', ru: 'Схематичное изображение', en: 'Schematic illustration' };

export const ALT = {
  uz: {
    '01-install': 'APK o‘rnatish oynasi va Play Protect ogohlantirishi',
    '02-language': 'Kirish ekrani: til tanlash',
    '03-bot-start': 'Telegram bot: Start tugmasi',
    '04-share-phone': 'Telegram bot: «Raqamni yuborish» tugmasi',
    '05-code': 'Ilovada 6 xonali kodni kiritish',
    '06-name': 'Ismni kiritish ekrani',
    'crm-00-userinfo': 'Telegram ID ni botdan bilish',
    'crm-01-login': 'ParkBor CRM kirish sahifasi',
  },
  ru: {
    '01-install': 'Окно установки APK и предупреждение Play Protect',
    '02-language': 'Экран входа: выбор языка',
    '03-bot-start': 'Telegram-бот: кнопка Start',
    '04-share-phone': 'Telegram-бот: кнопка «Отправить номер»',
    '05-code': 'Ввод 6-значного кода в приложении',
    '06-name': 'Экран ввода имени',
    'crm-00-userinfo': 'Как узнать Telegram ID у бота',
    'crm-01-login': 'Страница входа в ParkBor CRM',
  },
  en: {
    '01-install': 'APK install dialog and Play Protect warning',
    '02-language': 'Sign-in screen: choosing a language',
    '03-bot-start': 'Telegram bot: the Start button',
    '04-share-phone': 'Telegram bot: the “Share phone number” button',
    '05-code': 'Entering the 6-digit code in the app',
    '06-name': 'Name entry screen',
    'crm-00-userinfo': 'Getting your Telegram ID from a bot',
    'crm-01-login': 'ParkBor CRM sign-in page',
  },
};

const uz = {
  nav: 'Qo‘llanma',
  title: 'Qo‘llanma: ilovani o‘rnatish va foydalanish | ParkBor',
  desc: 'ParkBor qo‘llanmasi: haydovchi uchun o‘rnatishdan to‘lov va QR gacha, avtoturargoh egasi uchun CRM bo‘yicha qadamlar.',
  h1: 'ParkBor qo‘llanmasi',
  intro: 'Ikki qism: haydovchi uchun (mobil ilova) va avtoturargoh egasi uchun (ParkBor CRM). Har qadam qisqa. Rasmlar namunaviy sxemalar, haqiqiy ekran suratlari emas.',
  driver: { h: 'A. Haydovchi uchun', steps: [
    ['Ilovani yuklab oling va o‘rnating', 'Yuqoridagi tugma orqali APK faylni yuklab oling va oching. «Noma’lum manbalardan o‘rnatish»ga ruxsat bering. Google Play Protect ogohlantirsa, «Batafsil», so‘ng «Baribir o‘rnatish» ni bosing.', ['01-install']],
    ['Ilovani oching va tilni tanlang', 'Ilovani oching. Kirish ekranida tilni tanlang: o‘zbekcha, ruscha yoki inglizcha.', ['02-language']],
    ['Telegram orqali kiring', '«Telegram orqali kirish» ni bosing. Ilova @parkborbot botini ochadi. Telegram’dagi Start tugmasini bosing. «Raqamni yuborish» tugmasi bilan O‘Z telefon raqamingizni yuboring.', ['03-bot-start', '04-share-phone']],
    ['6 xonali kodni kiriting', 'Bot kod yuboradi. Ilovaga qayting va 6 xonali kodni kiriting.', ['05-code']],
    ['Ismingizni kiriting', 'Ismingizni yozing va «Saqlash» ni bosing. Xohlasangiz, avtomobil raqamini ham qo‘shing.', ['06-name']],
  ], closing: 'Qolganini ilovaning o‘zida oson o‘rganasiz: xaritadan avtoturargoh toping, bron qiling va QR bilan kiring.' },
  owner: { h: 'B. Avtoturargoh egasi uchun (CRM)', steps: [
    ['Telegram ID ingizni bizga yuboring', 'Egasini platforma ma’muri Telegram ID bo‘yicha qo‘shadi. Telegram’da @userinfobot ga yozing va ID ingizni oling. So‘ng uni bizga yuboring: <a href="{B}/#contact">Bog‘lanish</a>.', ['crm-00-userinfo']],
    ['CRM ga kiring', '<a href="https://crm.parkbor.uz" rel="noopener">crm.parkbor.uz</a> ni oching va Telegram orqali kiring.', ['crm-01-login']],
    ['Qolganini CRM ichida bajarasiz', 'Avtoturargoh qo‘shish, joylar, operatorlar, hisobotlar: hammasi CRM ichida.', []],
  ] },
  trouble: { h: 'Muammolar bo‘lsa', items: [
    ['Kod kelmayapti', 'Botda Start tugmasini bosganingizni tekshiring. Keyin ilovada kodni qayta so‘rang.'],
    ['«Telegram ma’lumotlari yaroqsiz yoki eskirgan» chiqdi', 'Qaytadan urinib ko‘ring: Telegram orqali kirishni boshidan boshlang.'],
    ['Sayt yoki CRM ochilmayapti', 'DNS ni 1.1.1.1 ga o‘zgartiring yoki Android’da «Private DNS» ga one.one.one.one ni kiriting.'],
  ] },
};

const ru = {
  nav: 'Руководство',
  title: 'Руководство: установка и работа с приложением | ParkBor',
  desc: 'Руководство ParkBor: для водителя от установки до оплаты и QR, для владельца парковки шаги в CRM.',
  h1: 'Руководство ParkBor',
  intro: 'Две части: для водителя (мобильное приложение) и для владельца парковки (ParkBor CRM). Каждый шаг короткий. Картинки схематичные, это не настоящие скриншоты.',
  driver: { h: 'A. Для водителя', steps: [
    ['Скачайте и установите приложение', 'Скачайте APK по кнопке выше и откройте файл. Разрешите «установку из неизвестных источников». Если Google Play Protect предупредит, нажмите «Подробнее», затем «Всё равно установить».', ['01-install']],
    ['Откройте приложение и выберите язык', 'Откройте приложение. На экране входа выберите язык: узбекский, русский или английский.', ['02-language']],
    ['Войдите через Telegram', 'Нажмите «Войти через Telegram». Приложение откроет бота @parkborbot. Нажмите кнопку Start в Telegram. Кнопкой «Отправить номер» отправьте СВОЙ номер телефона.', ['03-bot-start', '04-share-phone']],
    ['Введите 6-значный код', 'Бот пришлёт код. Вернитесь в приложение и введите 6-значный код.', ['05-code']],
    ['Введите имя', 'Введите имя и нажмите «Сохранить». При желании добавьте и госномер автомобиля.', ['06-name']],
  ], closing: 'Остальное легко освоите в самом приложении: найдите парковку на карте, забронируйте и въезжайте по QR.' },
  owner: { h: 'B. Для владельца парковки (CRM)', steps: [
    ['Отправьте нам свой Telegram ID', 'Владельца добавляет администратор платформы по Telegram ID. Напишите боту @userinfobot в Telegram и узнайте свой ID. Затем отправьте его нам: <a href="{B}/#contact">Связаться</a>.', ['crm-00-userinfo']],
    ['Войдите в CRM', 'Откройте <a href="https://crm.parkbor.uz" rel="noopener">crm.parkbor.uz</a> и войдите через Telegram.', ['crm-01-login']],
    ['Остальное делаете в CRM', 'Добавление парковки, места, операторы, отчёты: всё внутри CRM.', []],
  ] },
  trouble: { h: 'Если что-то не работает', items: [
    ['Код не приходит', 'Убедитесь, что вы нажали Start в боте. Затем запросите код в приложении ещё раз.'],
    ['Ошибка «Данные Telegram недействительны или устарели»', 'Попробуйте ещё раз: начните вход через Telegram заново.'],
    ['Сайт или CRM не открывается', 'Смените DNS на 1.1.1.1 или в Android укажите в «Частном DNS» one.one.one.one.'],
  ] },
};

const en = {
  nav: 'Guide',
  title: 'Guide: install and use the app | ParkBor',
  desc: 'ParkBor guide: for drivers from installation to payment and QR, for lot owners the steps in the CRM.',
  h1: 'ParkBor guide',
  intro: 'Two parts: for drivers (mobile app) and for parking lot owners (ParkBor CRM). Every step is short. The pictures are simple schematic illustrations, not real screenshots.',
  driver: { h: 'A. For drivers', steps: [
    ['Download and install the app', 'Download the APK with the button above and open the file. Allow “install from unknown sources”. If Google Play Protect warns you, tap “More details”, then “Install anyway”.', ['01-install']],
    ['Open the app and choose a language', 'Open the app. On the sign-in screen choose Uzbek, Russian or English.', ['02-language']],
    ['Sign in with Telegram', 'Tap “Sign in with Telegram”. The app opens the bot @parkborbot. Press Start in Telegram. Tap “Share phone number” to send YOUR OWN number.', ['03-bot-start', '04-share-phone']],
    ['Enter the 6-digit code', 'The bot sends a code. Go back to the app and enter the 6-digit code.', ['05-code']],
    ['Enter your first name', 'Type your first name and tap “Save”. You can also add your car’s plate number.', ['06-name']],
  ], closing: 'You will learn the rest easily inside the app: find a lot on the map, book it and enter with the QR code.' },
  owner: { h: 'B. For lot owners (CRM)', steps: [
    ['Send us your Telegram ID', 'A platform admin adds the owner by Telegram ID. Message the bot @userinfobot in Telegram to get your ID. Then send it to us: <a href="{B}/#contact">Contact</a>.', ['crm-00-userinfo']],
    ['Sign in to the CRM', 'Open <a href="https://crm.parkbor.uz" rel="noopener">crm.parkbor.uz</a> and sign in with Telegram.', ['crm-01-login']],
    ['Do the rest inside the CRM', 'Adding a lot, slots, operators, reports: all inside the CRM.', []],
  ] },
  trouble: { h: 'Troubleshooting', items: [
    ['The code does not arrive', 'Make sure you pressed Start in the bot. Then request the code again in the app.'],
    ['“The Telegram data is invalid or has expired” appears', 'Try again: restart the Telegram sign-in from the beginning.'],
    ['The site or CRM does not open', 'Change your DNS to 1.1.1.1, or on Android set “Private DNS” to one.one.one.one.'],
  ] },
};

export const GUIDE = { uz, ru, en };
