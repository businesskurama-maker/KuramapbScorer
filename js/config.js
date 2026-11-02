/* Kurama Pickleball Scorer — deployment settings.
 * Supabase project: kurama_pickleball_scorer (ap-southeast-1).
 * The publishable key is safe to expose in the browser; access is enforced by row-level security.
 * Set both to '' to run without sign-in (free mode).
 */
window.PB_CONFIG = {
  supabaseUrl: 'https://wwyebsroqypdkeqtiylv.supabase.co',
  supabaseAnonKey: 'sb_publishable_SZwLunxKKG4EX4ytGcZs6A_R526LibB',
  // Public key for owner donation alerts (web push). The matching private key stays on the server.
  vapidPublicKey: 'BHQkHCcSS667tABSCh1u_o5fewgqo-roVy7JyHEFIqPhNSGqBZlOqEIFlOeMsVKa1bMrChzMk_EBvbgezYmMHoo'
};
