/* Supabase compatibility shim for Tajiri POS.
 *
 * Loads @supabase/supabase-js from the CDN and exposes the same
 * `window.firebaseAuth`, `window.firebaseDb`, and `window.firebase`
 * globals the POS previously got from the Firebase compat SDK. The rest
 * of the app (welcome.js, app.js, index.html boot code) keeps working
 * unchanged while the backend is Supabase.
 *
 * Backing store (run supabase-schema.sql in the SQL editor first):
 *   users  – one row per staff account, id = Supabase auth user id
 *   system – key/value table; the "bootstrap" row holds admin setup state
 *
 * Supabase Auth handles email/password, verification, and password reset.
 * Persistence (LOCAL vs SESSION) is emulated by storing the session in
 * localStorage or sessionStorage.
 */
(() => {
  window.firebaseAuth = null;
  window.firebaseDb = null;
  window.__tajiriFirebaseError = null;

  const SUPABASE_URL = window.TAJIRI_SUPABASE_URL || "";
  const SUPABASE_ANON_KEY = window.TAJIRI_SUPABASE_ANON_KEY || "";
  const hasRealValues =
    SUPABASE_URL &&
    !SUPABASE_URL.startsWith("REPLACE_") &&
    SUPABASE_ANON_KEY &&
    !SUPABASE_ANON_KEY.startsWith("REPLACE_");

  if (!window.TAJIRI_SUPABASE_CONFIG) {
    window.TAJIRI_SUPABASE_CONFIG = {
      url: SUPABASE_URL,
      anonKey: SUPABASE_ANON_KEY,
    };
  }

  if (!hasRealValues) return;

  const config = window.TAJIRI_SUPABASE_CONFIG;

  // Load supabase-js v2 as a classic script (UMD build exposes window.supabase).
  const script = document.createElement("script");
  script.src =
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js";
  script.async = false;
  script.onerror = () => {
    window.__tajiriFirebaseError =
      "Cloud sign-in is unavailable. Check the Supabase setup; saved legacy accounts only work on this browser.";
  };
  script.onload = () => {
    try {
      initializeSupabase();
    } catch (error) {
      console.warn("Supabase initialization failed:", error);
      window.__tajiriFirebaseError =
        "Cloud sign-in is unavailable. Check the Supabase setup; saved legacy accounts only work on this browser.";
    }
  };
  document.head.append(script);

  function firebaseAuthErrorMessage(error, action) {
    const code = String(error?.message || "").toLowerCase();
    if (code.includes("invalid login credentials"))
      return "The email or password is incorrect.";
    if (code.includes("email not confirmed"))
      return "Verify your email before signing in.";
    if (code.includes("already registered") || code.includes("already exists"))
      return "An account already exists for this email. Sign in or use password reset.";
    if (code.includes("at least 6"))
      return "Choose a stronger password with at least 6 characters.";
    if (code.includes("invalid email") || code.includes("valid email"))
      return "Enter a valid email address.";
    if (code.includes("too many requests"))
      return "Too many attempts. Wait a while, then try again.";
    if (code.includes("network") || code.includes("failed to fetch"))
      return "Could not reach Supabase. Check your internet connection and try again.";
    if (code.includes("row-level security") || code.includes("permission"))
      return action === "signup"
        ? "Could not verify administrator setup. Publish the current Supabase policies, then try again."
        : "Could not verify your account role. Check the Supabase policies and try again.";
    return action === "signup"
      ? "The account could not be created. Check Supabase Authentication and try again."
      : "Sign-in could not be completed. Check your connection and Supabase setup, then try again.";
  }
  window.firebaseAuthErrorMessage = firebaseAuthErrorMessage;

  function initializeSupabase() {
    const client = window.supabase.createClient(config.url, config.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });

    /* ---------------- window.firebase compat surface ---------------- */
    const persistenceStore = { mode: "local" };
    window.firebase = {
      auth: {
        Auth: {
          Persistence: {
            LOCAL: "local",
            SESSION: "session",
          },
        },
      },
      firestore: {
        FieldValue: {
          serverTimestamp: () => new Date().toISOString(),
        },
      },
      __tajiriPersistence: persistenceStore,
    };

    /* ---------------- window.firebaseAuth compat ---------------- */
    const userWrapper = (session) => {
      if (!session?.user) return null;
      const u = session.user;
      return {
        uid: u.id,
        email: u.email,
        emailVerified: Boolean(u.email_confirmed_at || u.confirmed_at),
        displayName: (u.user_metadata && u.user_metadata.display_name) || "",
        async updateProfile(profile) {
          const { error } = await client.auth.updateUser({
            data: { display_name: profile.displayName ?? "" },
          });
          if (error) throw error;
        },
        async sendEmailVerification() {
          const { error } = await client.auth.resend({
            type: "signup",
            email: u.email,
          });
          if (error) throw error;
        },
        async delete() {
          // Anonymous/cleanup deletes need service rights; surface a clear error.
          const { error } = await client.rpc("delete_own_auth_user");
          if (error) throw error;
        },
      };
    };

    window.firebaseAuth = {
      async setPersistence(persistence) {
        persistenceStore.mode = persistence === "session" ? "session" : "local";
      },

      async signInWithEmailAndPassword(email, password) {
        const { data, error } = await client.auth.signInWithPassword({
          email,
          password,
        });
        if (error) {
          error.code = "auth/invalid-credential";
          throw error;
        }
        rememberSession(data.session);
        return { user: userWrapper(data.session) };
      },

      async createUserWithEmailAndPassword(email, password) {
        const { data, error } = await client.auth.signUp({
          email,
          password,
        });
        if (error) {
          error.code = error.message?.includes("already")
            ? "auth/email-already-in-use"
            : "auth/weak-password";
          throw error;
        }
        if (!data.session) {
          // Email confirmation required: return a wrapper without a session.
          const pseudoUser = {
            uid: data.user?.id || "",
            email,
            emailVerified: false,
            async updateProfile() {},
            async sendEmailVerification() {
              await client.auth.resend({ type: "signup", email });
            },
            async delete() {},
          };
          return { user: pseudoUser };
        }
        rememberSession(data.session);
        return { user: userWrapper(data.session) };
      },

      async sendPasswordResetEmail(email) {
        const { error } = await client.auth.resetPasswordForEmail(email);
        if (error) throw error;
      },

      async signOut() {
        await client.auth.signOut();
      },

      get currentUser() {
        // Synchronous best-effort read of the cached session.
        const key = storageKey();
        const raw = JSON.parse(
          window.localStorage.getItem(key) ||
            window.sessionStorage.getItem(key) ||
            "null",
        );
        return userWrapper(raw?.currentSession || raw);
      },

      onAuthStateChanged(callback, errorListener) {
        let settled = false;
        let unsubscribe = () => {};
        const timeout = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          unsubscribe();
          errorListener
            ? errorListener(
                new Error("Timed out while checking Supabase sign-in."),
              )
            : callback(null);
        }, 10000);
        client.auth.getSession().then(({ data, error }) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          unsubscribe();
          if (error) {
            errorListener ? errorListener(error) : callback(null);
            return;
          }
          callback(userWrapper(data.session));
        });
        // Keep the subscription alive for later changes.
        const { data: sub } = client.auth.onAuthStateChange(
          (event, session) => {
            if (!settled) return;
            callback(userWrapper(session));
          },
        );
        unsubscribe = () => sub?.subscription?.unsubscribe?.();
        return unsubscribe;
      },
    };

    function storageKey() {
      return `sb-${new URL(config.url).hostname.split(".")[0]}-auth-token`;
    }

    // Move the Supabase session between local/session storage to honor the
    // requested persistence mode (Supabase-js v2 always writes localStorage).
    function rememberSession(session) {
      if (!session) return;
      try {
        const key = storageKey();
        const payload = JSON.stringify({
          currentSession: session,
          ...session,
        });
        if (persistenceStore.mode === "session") {
          window.sessionStorage.setItem(key, payload);
          window.localStorage.removeItem(key);
        } else {
          window.localStorage.setItem(key, payload);
          window.sessionStorage.removeItem(key);
        }
      } catch (error) {
        console.warn(
          "Could not apply the requested session persistence:",
          error,
        );
      }
    }
    window.__tajiriRememberSupabaseSession = rememberSession;

    /* ---------------- window.firebaseDb compat (Firestore → Postgres) ---------------- */
    const snapshotFromRow = (row) => ({
      exists: Boolean(row),
      id: row?.id ?? null,
      data: () => (row ? { ...row } : {}),
    });

    function makeCollectionRef(name) {
      return {
        name,
        doc(id) {
          const table = name === "system" ? "system" : name;
          return {
            id,
            async get() {
              const query = client.from(table).select("*").eq("key", id);
              const { data, error } = await query.maybeSingle();
              if (error) throw error;
              return snapshotFromRow(
                table === "system"
                  ? data
                  : data
                    ? { ...data, id: data.id ?? id }
                    : null,
              );
            },
            async set(value) {
              const payload = { key: id, value };
              const { error } = await client
                .from(table)
                .upsert(table === "system" ? payload : value, {
                  onConflict: table === "system" ? "key" : "id",
                });
              if (error) throw error;
            },
            async update(value) {
              const { error } = await client
                .from(table)
                .update(table === "system" ? { value } : value)
                .eq(table === "system" ? "key" : "id", id);
              if (error) throw error;
            },
            async delete() {
              const { error } = await client
                .from(table)
                .delete()
                .eq(table === "system" ? "key" : "id", id);
              if (error) throw error;
            },
          };
        },
        async get() {
          const { data, error } = await client.from(name).select("*");
          if (error) throw error;
          return {
            empty: !data || data.length === 0,
            docs: (data || []).map((row) => snapshotFromRow(row)),
          };
        },
      };
    }

    window.firebaseDb = {
      collection: makeCollectionRef,

      // Firestore transactions map to sequential reads/writes here; the
      // bootstrap admin-count invariant is enforced server-side by the RLS
      // policies and the increment RPC in supabase-schema.sql.
      async runTransaction(transactionHandler) {
        const operations = [];
        const transaction = {
          async get(ref) {
            return ref.get();
          },
          set(ref, value) {
            operations.push({ type: "set", ref, value });
          },
          update(ref, value) {
            operations.push({ type: "update", ref, value });
          },
        };
        await transactionHandler(transaction);
        for (const operation of operations) {
          if (operation.type === "set")
            await operation.ref.set(operation.value);
          else await operation.ref.update(operation.value);
        }
      },
    };
  }
})();
