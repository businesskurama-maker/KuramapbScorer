# Kurama Pickleball Scorer

Full-screen pickleball scoreboard (PWA) for a smart TV or tablet, controlled from phones.
Developer: Kurama Information Technology Solutions · by CHI

## How it works
1. Open the site's domain on the TV/tablet → it shows a big QR code.
2. Scan with a phone → sign in with Google.
3. The scoreboard checks the account in Supabase:
   - active 24-hour pass, or at least 1 credit → starts a pass (uses 1 credit) and the phone becomes the remote
   - no credits → **Access denied** on the TV and the phone
4. Tap the team that **won the rally**; the app applies the rules.
5. When the pass ends, the board locks and asks for a new scan (another credit).

## Credits (admin)
Open `/admin.html` and sign in with an admin Google account (chiomegadeveloper@gmail.com is admin by default).
Search a user and add credits after they pay (e.g. GCash). Users must sign in once before they can be topped up.
Admins: add more in the `admin_emails` table (applies on first sign-in) or set `profiles.is_admin = true`.

## Supabase
Project `kurama_pickleball_scorer` (ap-southeast-1). Schema: `supabase/schema.sql`
(profiles, credit_ledger, start_day_pass(), admin_add_credits(), RLS).
Settings in `js/config.js` (publishable key — safe in the browser). Empty values = free mode, no sign-in.

**Google sign-in setup (one time):**
1. Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID (Web application).
   Authorized redirect URI: `https://wwyebsroqypdkeqtiylv.supabase.co/auth/v1/callback`
2. Supabase → Authentication → Sign In / Providers → Google → enable, paste Client ID + Secret.
3. Supabase → Authentication → URL Configuration → Site URL = your live domain;
   add `https://YOUR-DOMAIN/**` (and Vercel preview URLs if wanted) to Redirect URLs.

## Scoring
Doubles side-out (0-0-2), singles, or rally scoring · games to 11/15/21, win by 2 · 1, best of 3 or 5 ·
auto switch ends · player names with court positions and current server · undo · multiple remotes.

## Scoreboard keys (only after a pass is active)
← / → rally won by left / right · ↓ or U undo · S swap sides · ↑ or Q show QR · F full screen · Enter/N next game

## Deploy
Static site, no build step, HTTPS required. Vercel: import the GitHub repo (framework preset "Other").
