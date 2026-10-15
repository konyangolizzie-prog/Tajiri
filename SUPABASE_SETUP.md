# Supabase account setup

Tajiri POS uses **Supabase Authentication** for email/password sign-in and two
Postgres tables (`users`, `system`) for account roles. Passwords are handled by
Supabase Auth; they are never saved in the POS account records or local browser
storage.

The app talks to Supabase through `supabase-shim.js`, which exposes the same
`window.firebaseAuth` / `window.firebaseDb` interface the app was originally
written against — the rest of the POS code is unchanged.

## Provision the Supabase project

1. Create a project at [supabase.com](https://supabase.com).
2. In the SQL editor, run [`supabase-schema.sql`](./supabase-schema.sql)
   (tables, row-level security policies, and the bootstrap RPC).
3. In **Authentication → Providers**, enable **Email**. Turn off
   "Confirm email" only if you do not want email verification.
4. In **Authentication → URL Configuration**, set the Site URL to where the POS
   is hosted (include `http://localhost:3000` for development).
5. Copy the project URL and anon key from **Settings → API** into
   `index.html`:

   ```js
   window.TAJIRI_SUPABASE_CONFIG = {
     url: "https://YOUR-PROJECT.supabase.co",
     anonKey: "YOUR-ANON-KEY",
   };
   ```

6. Open the admin setup page (`index.html?roleShell=admin`) and register the
   first admin with any valid email. Verify the email using the link Supabase
   sends, then sign in to finish setup. The bootstrap row in the `system` table
   allows first-admin setup only once.
7. In **Staff access**, an admin can create cashier accounts and additional
   administrator accounts. The limit is three administrators total, including
   the first admin, enforced by the `claim_admin_bootstrap` RPC and the
   `system` bootstrap row. New staff must verify their email before signing in.

## Existing local accounts

Accounts created before the cloud integration exist only in that browser's
local storage. Their password hashes cannot be converted into Supabase
passwords. Create the cloud admin with the authorized email, then recreate
staff accounts from the Admin workspace and assign each a password.

Sales, inventory, settings, and other POS data remain stored locally on each
device; this change centralizes authentication and account roles only. It does
not synchronize business data between browsers.
