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

## Passes & payments
Support / developer contact: dinkykongsupport@gmail.com. Shown to players: payments support further development; approval takes 5 minutes to 2 hours.
Packages: PHP 50 / 24 h · PHP 150 / 3 days · PHP 300 / 1 week · PHP 800 / 1 month (table `packages`).
1. Player signs in with Google on the phone → no pass → **Buy a pass** → picks a package.
2. Pays with the InstaPay QR (`icons/instapay-qr.png`) from any bank / GCash / Maya.
3. Types the **last 6 digits** of the reference → request goes to the owner.
4. Owner opens `/owner/` (old `/admin.html` redirects there) → **Payments to check** → matches amount + last 6 digits → **Approve** (or Reject).
5. The phone unlocks by itself; time starts at the first scoreboard scan.
One account per purchase, one phone per account: the first phone used is locked to the account.
Owner can **reset the phone lock** in the Users table if a player changes phones.

## Supabase
Project `kurama_pickleball_scorer` (ap-southeast-1). Schema: `supabase/schema.sql`
(profiles, credit_ledger, start_day_pass(), admin_add_credits(), RLS).
Settings in `js/config.js` (publishable key — safe in the browser). Empty values = free mode, no sign-in.

**Google sign-in setup (one time):**
1. Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID (Web application).
   Authorized redirect URI: `https://wwyebsroqypdkeqtiylv.supabase.co/auth/v1/callback`
2. Supabase → Authentication → Sign In / Providers → Google → enable, paste Client ID + Secret.
3. Supabase → Authentication → URL Configuration → Site URL = your live domain;
   add `https://dinkykong.pro/**` (and Vercel preview URLs if wanted) to Redirect URLs.

## Scoring
Doubles side-out (0-0-2), singles, or rally scoring · games to 11/15/21, win by 2 · 1, best of 3 or 5 ·
auto switch ends · player names with court positions and current server · undo · multiple remotes.

## Scoreboard keys (only after a pass is active)
← / → rally won by left / right · ↓ or U undo · S swap sides · ↑ or Q show QR · F full screen · Enter/N next game

## Deploy
Static site, no build step, HTTPS required. Vercel: import the GitHub repo (framework preset "Other").

## LIVE (multi-court + OBS)
- Lobby → **LIVE**, or open `/live.html`. Pick 2–6 courts. Each court has its own code/QR; referees scan it and score with **no sign-in**.
- The organizer activates the screen by scanning the "Scan to activate LIVE" QR and signing in with Google. A **LIVE pass** — PHP 20 / 1 hour, PHP 50 / 4 hours, PHP 150 / 1 day or PHP 300 / 3 days — donated in the app and approved on the owner page like any other donation — unlocks every court and the OBS lower third.
- **OBS:** on the LIVE screen tap *OBS lower third* → copy the link → OBS *Sources → + → Browser*, Width 1920, Height 264. Transparent background, shows all active courts, updates live (via Supabase Realtime). The toggle also shows the strip on the LIVE screen itself.
