# Dr. Mohamed Ghoneim Clinic: booking website

Arabic/English website where patients book a **day** at one of the clinic's branches. Entry to the doctor is **first come, first served**, so there are no individual appointment times. Staff manage bookings and follow up with patients who didn't come from a simple dashboard.

Requires only Node.js 18+ (no packages to install).

## Run it

```bash
cp .env.example .env     # set ADMIN_PASSWORD (and BASE_URL when online)
node server.js           # site: http://localhost:3000   staff dashboard: /admin
```

## Branches (edit in `config.json`)

| Branch | Days | Clinic hours shown |
|---|---|---|
| Alexandria - Rushdy | Sat, Mon / Wed | 8-10 pm / 5-7 pm |
| Alexandria - i Care Center, Smouha (19732) | Sun, Tue, Thu | 12-5 pm |
| Cairo - Sheikh Zayed | Sat | 12-3 pm |
| Cairo - Mohandessin (Barada Eye Center) | Sat | 10 am-12 pm |

Change `workingHours` in `config.json` if any window changes. The closing time of each window is also what the system uses to decide a booked patient has missed the day.

`maxBookingsPerSession` (default `0` = unlimited) can cap the number of bookings per branch per day.

## How booking works

1. Patient picks a branch, then a day (only open days are shown), enters name and phone.
2. The site registers their day and shows the clinic hours with the first-come, first-served note. A button lets them send the clinic a WhatsApp message (click-to-chat, no API needed).
3. The same phone can't book the same branch and day twice.

## Staff dashboard (`/admin`)

- Tabs: Today, Upcoming, Missed, Recovered, All.
- Mark **Attended** after each visit (this prevents the missed flag), **No-show**, or **Cancel**.
- About 45 minutes after a branch's clinic hours end, anyone still "booked" is flagged **Missed** automatically.
- For missed patients, tap **WhatsApp patient (prefilled)**: it opens WhatsApp with a ready message and a personal rebooking link that fills in their details. Then tap **Mark contacted** to keep track.
- Patients who rebook later are shown under **Recovered**.

## WhatsApp API: currently OFF

`config.json` → `"whatsapp": { "enabled": false }`. While off, nothing is sent automatically and all follow-up is done by staff with the prefilled WhatsApp buttons.

To turn automatic messages on later (confirmation, reminder the day before, missed-day recontact + one follow-up after 3 days):

1. Set up the WhatsApp Business Platform at developers.facebook.com for the clinic's number, create a permanent token and copy the Phone number ID.
2. Put them in `.env` as `WA_TOKEN` and `WA_PHONE_ID`.
3. Set `"enabled": true`.
4. Create and submit 6 templates (category **Utility**, languages `ar` and `en`, names as in `config.json`):

| Template | Variables | Suggested body |
|---|---|---|
| `appointment_confirmation_ar/en` | {{1}} name, {{2}} date, {{3}} clinic + branch, {{4}} clinic hours | AR: مرحباً {{1}}، تم تسجيل حجزك يوم {{2}} في {{3}}. فترة الكشف {{4}}، والدخول بنظام الأسبقية دون موعد محدد. / EN: Hello {{1}}, your booking on {{2}} at {{3}} is registered. Clinic hours {{4}}; entry is first come, first served. |
| `appointment_reminder_ar/en` | same | AR: تذكير: حجزك {{2}} في {{3}}، فترة الكشف {{4}}. الدخول بنظام الأسبقية. / EN: Reminder: you're booked on {{2}} at {{3}}, clinic hours {{4}}. Entry is first come, first served. |
| `missed_appointment_ar/en` | {{1}} name, {{2}} date, {{3}} clinic + branch, {{4}} rebooking link | AR: مرحباً {{1}}، لاحظنا أنك لم تتمكن من الحضور يوم {{2}} في {{3}}. يمكنك حجز يوم جديد من هنا: {{4}} / EN: Hello {{1}}, we noticed you couldn't make it on {{2}} at {{3}}. You can book a new day here: {{4}} |

Without keys but with `enabled: true`, messages are only written to `data/outbox.log` (dry-run).

## Put it online

Needs a host that runs Node and keeps its disk (small VPS, Render, Railway, Fly.io with a volume). Keep `data/` persistent and backed up, use HTTPS, set `BASE_URL`, and `TRUST_PROXY=1` behind a proxy. Bookings contain patient names and phone numbers: use a strong `ADMIN_PASSWORD`.

## Photos and videos

The site has a hero photo, a gallery and a video section. They stay hidden until you fill in `"media"` in `config.json`:

```json
"media": {
  "heroImage": "/media/clinic.jpg",
  "gallery": [
    { "src": "/media/room1.jpg", "alt": { "ar": "غرفة الكشف", "en": "Examination room" } }
  ],
  "videos": [
    { "facebookUrl": "https://www.facebook.com/<page>/videos/<id>" },
    { "src": "/media/intro.mp4", "poster": "/media/intro.jpg" }
  ]
}
```

- Put image/video files in `public/media/` (JPG, PNG, WebP, MP4; keep photos under about 500 KB each).
- Facebook videos can be embedded straight from their public link, with no download needed.
