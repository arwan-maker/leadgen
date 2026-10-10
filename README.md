# LeadGEN

Listing search, lead capture and realtor alerts for iCloud Realty Ltd., Brokerage (GTA, Waterloo, Cambridge).
Node.js + Postgres, runs on Vercel. No framework or build step.

## How it works
1. **Listings**: an hourly Vercel cron (`api/cron/sync-listings.js`) pulls listings from CREA DDF (and PropTx once approved) into Postgres. A full pass at least every 24 hours marks removed listings inactive.
2. **Search site** (`public/index.html`): visitors accept the terms of use, then search listings from our own database (`GET /api/listings`).
3. **Leads**: the pop-up (`public/leadgen-popup.js`) opens after a search or on "Contact about this home" and posts to `POST /api/leads`. Google Ads lead forms post to `POST /api/google-leads`.
4. **Matching and alerts**: each new lead is matched to up to 5 listings (`lib/matching.js`), assigned to a realtor, and the realtor gets an email (Resend) and a text (Twilio) (`lib/process-lead.js`).
5. **Admin** (`public/admin.html`): the realtor works leads (status, notes, CSV export), sees matches and alert history, and manages realtors.

Rules followed: CREA DDF display and data rules (see `../paperwork/3-rules-the-app-must-follow.md`), CASL consent (express for the pop-up; implied for Google leads, expiring after 6 months), and leads go only to the feed-owning realtor by default (`LEAD_ROUTING=owner`).

## Deploy on Vercel (one time)
1. Push this folder to GitHub and import it in Vercel (New Project). No build settings are needed.
2. **Storage > Neon (Postgres)**: this sets `DATABASE_URL`.
3. **Settings > Environment Variables**: copy the names from `.env.example` and fill in what you have. The app runs without the feed and alert keys; those features just skip until they're set.
   **The realtor enters the feed logins herself** (`DDF_CLIENT_ID`, `DDF_CLIENT_SECRET`, later `PROPTX_TOKEN`). CREA's rules don't let her share her DDF login with a tech provider. Add her to the Vercel team and have her save them as **Sensitive** variables, which nobody can read back after saving. The domain should be in her or the brokerage's name.
4. Create the tables: paste `db/schema.sql` into Neon's SQL editor, or run `DATABASE_URL=... npm run migrate`. It's safe to run again after updates.
5. Redeploy. Open `/admin.html`, sign in with `ADMIN_TOKEN`, and add the realtor under **Sellers** (email, mobile number).
6. The hourly cron needs a Vercel Pro plan. To run a sync right away: `curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR-APP/api/cron/sync-listings?full=1`, then check the `sync_runs` table shows `fetched` above 0.

Before going live, replace the three placeholders marked TODO: CREA's terms-of-use wording and "Powered by REALTOR.ca" logo (`public/search.js`, `public/index.html`), and the iCloud Realty logo.

## Pop-up on another website
    <script src="https://YOUR-APP/leadgen-popup.js" data-search-form="#your-search-form"></script>
Options: `data-delay="20"`, `data-title`, `data-subtitle`. From a button: `LeadGen.open({ listing_id: "C1234567" })`.

## Google Ads lead form
Webhook URL `https://YOUR-APP/api/google-leads`, key = `GOOGLE_LEADS_KEY`. Full setup: `../google-ads/setup-guide.md`.

## API
| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /api/listings` | public, rate limited | search: `q, area, city, type, property_type, min_price, max_price, beds, baths, sort, page, page_size`; `?id=` one listing |
| `POST /api/leads` | public, 5 per IP per 10 min | pop-up leads |
| `POST /api/google-leads` | `google_key` | Google Ads lead form webhook |
| `GET/PATCH /api/admin/leads` | `ADMIN_TOKEN` | list, filter, CSV (`?format=csv`), detail and update (`?id=`) |
| `GET/POST/PATCH /api/admin/sellers` | `ADMIN_TOKEN` | realtors who receive leads |
| `GET /api/admin/stats` | `ADMIN_TOKEN` | dashboard numbers |
| `GET /api/cron/sync-listings` | `CRON_SECRET` | listing sync (`?full=1` forces a full pass) |
| `GET /api/config` | public | CREA analytics id for the front end |

## Run locally
    npm install
    DATABASE_URL=postgres://... npm run migrate
    DATABASE_URL=postgres://... npm run seed     # 30 fake demo listings; never run against production
    DATABASE_URL=postgres://... ADMIN_TOKEN=... npm run dev    # http://localhost:3000
    DATABASE_URL=postgres://.../a_test_db npm test            # drops and recreates all tables: use a throwaway database

Screenshots of the search site and admin are in `docs/`.
