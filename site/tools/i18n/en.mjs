export default {
  code: 'en', htmlLang: 'en', base: '/en', ogLocale: 'en_US', label: 'EN',
  ui: { skip: 'Skip to content', menu: 'Menu', logoAlt: 'ParkBor', home: 'Home', langNav: 'Language' },
  nav: { how: 'How it works', benefits: 'Features', drivers: 'Drivers', faq: 'FAQ', contact: 'Contact' },
  home: {
    title: 'ParkBor: fill more of your parking lot',
    desc: 'ParkBor gives parking lot owners advance booking, online payment, QR gate control and CRM reports. A mobile app for drivers.',
    eyebrow: 'For parking lot owners',
    h1: 'Increase the occupancy of your parking lot',
    sub: 'Drivers book a space in the app ahead of time and pay for it. You see spaces, income and occupancy in one place, ParkBor CRM.',
    cta1: 'Sign in to ParkBor CRM', cta2: 'Contact us',
    how: { h: '3 steps for owners', items: [
      ['Add your lot to the CRM', 'Enter the number of spaces, the price and opening hours.'],
      ['Drivers book in advance', 'A driver finds a free space in the app, books it and pays online.'],
      ['The operator scans the QR at the gate', 'You follow income and occupancy in the CRM.'],
    ] },
    benefits: { h: 'What the CRM gives you', intro: 'Only features the system really has are listed here.', items: [
      ['Space status', 'Free, occupied and booked spaces of each lot are visible in the CRM.'],
      ['Online payment', 'The driver pays for the booking in advance through a payment provider.'],
      ['QR control', 'At entry and exit the operator scans the driver’s QR code. Codes are signed and single-use.'],
      ['Reports and Excel', 'Statistics on bookings, income and occupancy; data can be exported to Excel.'],
      ['Operators', 'You add gate staff with an invitation code. They scan QR codes in the app.'],
      ['Telegram notifications', 'Booking messages arrive through the Telegram bot and app notifications.'],
    ] },
    drivers: { h: 'For drivers', p: 'Drivers use the ParkBor mobile app: find a lot nearby, book a space, pay, and show the QR code at the gate.',
      points: ['Find parking lots on a map', 'Book and pay in advance', 'QR code at entry and exit'],
      soon: 'Coming soon', bot: 'Telegram bot @parkborbot', botNote: 'Sign-in is done through Telegram.' },
    faq: { h: 'Frequently asked questions', items: [
      ['How do I start?', 'Contact us. We agree on terms and link your Telegram account as a lot owner. Then you sign in to ParkBor CRM with Telegram and add your lot.'],
      ['How much does it cost?', 'Contact us for terms. We do not publish prices or commission here.'],
      ['Who sees my data?', 'An owner sees bookings of their own lots only. An operator sees the booking details needed at the gate. Platform administrators have access to run the system. Details: <a href="{B}/privacy/">Privacy Policy</a>.'],
      ['How does a driver pay?', 'The driver pays for the booking in the app on a payment provider’s page. Bank card details are not stored by ParkBor.'],
      ['Do I need operators?', 'You can assign operators to accept bookings by QR at the gate. The owner adds an operator in the CRM with an invitation code.'],
      ['How can I delete my account?', 'A driver opens Profile, then Delete account in the app. Details: <a href="{B}/delete-account/">Delete account</a>.'],
    ] },
    contact: { h: 'Contact', p: 'Write or call us about partnership or any question. The site has no form that collects data.', tg: 'Telegram: @habibullo_2313', email: 'Email: parkbooor@gmail.com' },
  },
  footer: { privacy: 'Privacy Policy', terms: 'Terms of Use', del: 'Delete account', crm: 'ParkBor CRM', bot: 'Telegram bot', rights: 'ParkBor. All rights reserved.' },
  legalCommon: { updated: 'Last updated', draft: 'Legal entity name, address and tax ID (STIR) will be added later.' },
  privacy: {
    title: 'Privacy Policy | ParkBor', desc: 'What personal data ParkBor collects, why, who it is shared with and how long it is kept.', h1: 'Privacy Policy',
    sections: [
      ['1. Operator and scope', '<p>[Operator: ParkBor, contact email parkbooor@gmail.com]</p><p>This policy applies to the ParkBor mobile app, ParkBor CRM (crm.parkbor.uz), the parkbor.uz website and the Telegram bot @parkborbot.</p>'],
      ['2. What we collect', `<ul>
<li><strong>Sign-in with Telegram:</strong> Telegram ID, name, username. A phone number is stored only if you share it with the bot yourself.</li>
<li><strong>Vehicle:</strong> the plate number and type you enter.</li>
<li><strong>Bookings and payments:</strong> lot, time, amount, status. Bank card details are not stored by ParkBor; they are entered on the payment provider’s page.</li>
<li><strong>Device notification token</strong> (push), to send notifications.</li>
<li><strong>Approximate location:</strong> only with your permission and while you use the map; sent rounded to about 110 m to find lots nearby.</li>
<li><strong>Camera:</strong> only for operators scanning QR codes; images are not stored.</li>
<li><strong>Owners and operators (CRM):</strong> lot data, prices, the list of operators and a log of important actions (audit).</li>
<li><strong>Technical logs:</strong> error monitoring and server logs are configured to avoid personal data. IP addresses may remain in infrastructure logs.</li>
<li><strong>Website:</strong> no cookies, advertising or analytics tools. No forms.</li></ul>`],
      ['3. Why we use it', '<p>To sign you in, make bookings and payments, send notifications, prevent abuse, keep the system secure and keep accounting records. Data is not sold for advertising.</p>'],
      ['4. Third-party processors', `<ul>
<li>Railway: server and database hosting.</li>
<li>Cloudflare: DNS and delivery of the site and map traffic.</li>
<li>Telegram: sign-in and notifications.</li>
<li>Expo: delivery of app push notifications.</li>
<li>Payment providers: accepting payments.</li>
<li>OpenStreetMap / OpenFreeMap: map tiles (the device IP address and the viewed area are visible to the tile provider).</li>
<li>Nominatim (OpenStreetMap): address search in the CRM.</li>
<li>Error monitoring (Sentry): without personal data.</li></ul>
<p>Data may be processed on infrastructure outside Uzbekistan.</p>`],
      ['5. Retention', `<ul>
<li>Account data: while the account is active; on deletion name, username and phone are erased.</li>
<li>Booking and payment records: kept for accounting, anonymised after the account is deleted.</li>
<li>Notification log: 180 days.</li>
<li>Audit log: 365 days by default; plate numbers are masked in it.</li>
<li>Notification tokens: removed on sign-out or account deletion.</li>
<li>Infrastructure logs: short period.</li></ul>`],
      ['6. Your rights', '<p>You may ask for information about your data, request correction or deletion, and withdraw location and camera permissions in your device settings at any time. A driver deletes the account in the app: <a href="{B}/delete-account/">Delete account</a>. For other requests write to parkbooor@gmail.com.</p>'],
      ['7. Security', '<p>Traffic uses HTTPS; the refresh token is kept in the device’s secure storage; QR codes are signed and single-use; access is limited by role; important actions are logged. Absolute security cannot be guaranteed.</p>'],
      ['8. Changes', '<p>This policy may be updated. The current version is published on this page with the date above.</p>'],
      ['9. Contact', '<p>parkbooor@gmail.com</p>'],
    ],
  },
  terms: {
    title: 'Terms of Use | ParkBor', desc: 'Terms of using ParkBor: account, booking, payment, obligations of lot owners and users.', h1: 'Terms of Use',
    sections: [
      ['1. General', '<p>[Operator: ParkBor, contact email parkbooor@gmail.com]</p><p>By using the ParkBor mobile app, ParkBor CRM and parkbor.uz you agree to these terms. If you do not agree, do not use the service.</p>'],
      ['2. The service', '<p>ParkBor lets drivers book and pay for a parking space in advance, and lets owners manage spaces and view reports. Lots are run by their owners; ParkBor is a booking and payment tool.</p>'],
      ['3. Account', '<p>Sign-in is done with Telegram. You are responsible for the security of your account and the accuracy of what you enter. Do not share your account.</p>'],
      ['4. Booking and payment', '<p>The price, time and cancellation rules are shown in the app before payment. The time to pay is limited; after it expires the booking may be cancelled. Staying beyond the paid time may result in an extra charge. Refunds follow the rules shown in the app.</p>'],
      ['5. Lot owners', '<p>The owner is responsible for the accuracy of lot data, prices and opening hours, and for providing the booked space. Operators are added by invitation code with their consent. Financial terms are agreed separately: see the contact section.</p>'],
      ['6. Prohibited', '<ul><li>Entering false data or acting as another person.</li><li>Attempting unauthorised access, disrupting the system or creating artificial load.</li><li>Forging QR codes or giving them to others.</li><li>Using the service for unlawful purposes.</li></ul>'],
      ['7. Limitation of liability', '<p>The service is provided “as is”. To the extent permitted by law, ParkBor is not liable for property left at a lot or for the actions of an owner. Consumer rights set by law remain.</p>'],
      ['8. Deleting your account', '<p>You can delete your account at any time: <a href="{B}/delete-account/">Delete account</a>. Access may be restricted if these terms are breached.</p>'],
      ['9. Changes and law', '<p>These terms may change; the current version is published on this page. The laws of the Republic of Uzbekistan apply.</p>'],
      ['10. Contact', '<p>parkbooor@gmail.com</p>'],
    ],
  },
  del: {
    title: 'Delete account | ParkBor', desc: 'How to delete your account in the ParkBor app, what is erased and what is kept for accounting.', h1: 'Delete account',
    sections: [
      ['Delete in the app (driver)', '<ol><li>Open the ParkBor app and sign in.</li><li>Go to <strong>Profile</strong>.</li><li>Tap <strong>Delete account</strong> and confirm.</li></ol><p>If you cannot open the app, see the contact section below.</p>'],
      ['When deletion is not possible', '<ul><li>You have an active or upcoming booking (awaiting payment, confirmed, vehicle on site or overstaying).</li><li>The account owns a parking lot. Hand it over or delete it first.</li><li>You are the last active platform administrator.</li></ul><p>The app shows the reason. Try again once the conditions are met.</p>'],
      ['What is erased', '<ul><li>Name, username and phone number are cleared.</li><li>The Telegram ID is replaced and no longer linked to the account.</li><li>Device push tokens are removed and sessions are revoked.</li><li>Operator assignments end.</li></ul>'],
      ['What is kept', '<p>Bookings and payments are kept for accounting and legal requirements, without a link to you, in anonymised form. The notification log is deleted after 180 days.</p><p>If you wish, you can later open a new account with the same Telegram.</p>'],
      ['Contact', '<p>If you cannot delete the account in the app, write to parkbooor@gmail.com or Telegram <a href="https://t.me/habibullo_2313">@habibullo_2313</a>. We may ask for your Telegram username or ID to verify it is you. Owners and operators use the same contacts.</p>'],
    ],
  },
  b: { title: 'Open in the ParkBor app', h1: 'Open your booking in the app', open: 'Open in the ParkBor app', hint: 'The app must be installed.', bad: 'Invalid link', badHint: 'Open the link from the Telegram message again.', home: 'Go to the ParkBor website', noscript: 'This page needs JavaScript.' },
  notFound: { title: 'Page not found | ParkBor', h1: 'Page not found', p: 'This page does not exist or has moved.', home: 'Back to home' },
};
