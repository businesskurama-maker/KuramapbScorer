/* Kurama Pickleball Scorer — deployment settings.
 * Supabase project: kurama_pickleball_scorer (ap-southeast-1).
 * The publishable key is safe to expose in the browser; access is enforced by row-level security.
 * Set both to '' to run without sign-in (free mode).
 */
window.PB_CONFIG = {
  supabaseUrl: 'https://wwyebsroqypdkeqtiylv.supabase.co',
  supabaseAnonKey: 'sb_publishable_SZwLunxKKG4EX4ytGcZs6A_R526LibB',
  // Public key for owner donation alerts (web push). The matching private key stays on the server.
  // Google OAuth Web Client ID (Google Cloud → APIs & Services → Credentials). When set, sign-in uses Google's own
  // button on dinkykong.pro, so Google's screen shows our site instead of the Supabase address.
  googleClientId: '728667455268-biqoa2gdvd2n0ig2vemd75bqv5cjqqit.apps.googleusercontent.com',
  vapidPublicKey: 'BHQkHCcSS667tABSCh1u_o5fewgqo-roVy7JyHEFIqPhNSGqBZlOqEIFlOeMsVKa1bMrChzMk_EBvbgezYmMHoo'
};
