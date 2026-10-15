(() => {
  const welcomeView = document.querySelector("#welcomeView");
  const accessModal = document.querySelector("#modal-access");
  const toast = document.querySelector("#toast");
  if (!welcomeView || !accessModal) return;

  const normalize = value => String(value || "").trim().toLowerCase();
  let toastTimer;
  let lastFocusedElement = null;
  let adminSignupAllowed = false;

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3200);
  }

  function readAccounts() {
    try {
      const savedAccounts = localStorage.getItem("tajiri-pos-accounts");
      if (savedAccounts !== null) {
        const accounts = JSON.parse(savedAccounts);
        return Array.isArray(accounts) ? accounts : [];
      }
      const savedState = JSON.parse(localStorage.getItem("tajiri-pos") || "null");
      return Array.isArray(savedState?.users) ? savedState.users : [];
    } catch (error) {
      console.error("Could not read Tajiri POS accounts:", error);
      showToast("Saved account data could not be read on this device.");
      return [];
    }
  }

  function saveAccounts(accounts) {
    try {
      localStorage.setItem("tajiri-pos-accounts", JSON.stringify(accounts));
      const savedState = JSON.parse(localStorage.getItem("tajiri-pos") || "{}");
      localStorage.setItem("tajiri-pos", JSON.stringify({ ...savedState, users: accounts }));
      return true;
    } catch (error) {
      console.error("Could not save Tajiri POS accounts:", error);
      showToast("Could not save the account on this device.");
      return false;
    }
  }

  async function hashPassword(password) {
    if (globalThis.crypto?.subtle) {
      try {
        const bytes = new TextEncoder().encode(password);
        const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      } catch (error) {
        console.warn("Web Crypto is unavailable; using the local compatibility hash.", error);
      }
    }
    let hash = 2166136261;
    for (const character of password) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    return `fallback-${(hash >>> 0).toString(16)}`;
  }

  function sessionSignature(user, role) {
    const value = `${String(user || "").trim()}|${String(role || "").trim()}|tajiri-pos-session-v1`;
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function startSession(account, remember) {
    const identity = normalize(account.username || account.email || String(account.name || "").replace(/\s+/g, "."));
    const role = normalize(account.role);
    const signature = sessionSignature(identity, role);
    sessionStorage.setItem("tajiri-session-user", identity);
    sessionStorage.setItem("tajiri-session-role", role);
    sessionStorage.setItem("tajiri-session-signature", signature);

    if (remember) {
      localStorage.setItem("tajiri-remembered-user", identity);
      localStorage.setItem("tajiri-remembered-role", role);
      localStorage.setItem("tajiri-remembered-signature", signature);
    } else {
      localStorage.removeItem("tajiri-remembered-user");
      localStorage.removeItem("tajiri-remembered-role");
      localStorage.removeItem("tajiri-remembered-signature");
    }

    window.location.reload();
  }

  function setActiveTab(tabName) {
    if (tabName === "signup" && !adminSignupAllowed) tabName = "login";
    document.querySelectorAll("#modal-access [data-tab]").forEach(tab => {
      const active = tab.dataset.tab === tabName;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll("#modal-access .auth-form").forEach(form => {
      form.classList.toggle("active", form.id === `${tabName}Form`);
    });
    const heading = accessModal.querySelector(".modal-head h2");
    if (heading) heading.textContent = tabName === "signup" ? "Set up administrator" : "Sign in to Tajiri POS";
  }

  function openModal(modal, trigger = document.activeElement) {
    if (!modal) return;
    lastFocusedElement = trigger instanceof HTMLElement ? trigger : null;
    modal.hidden = false;
    const firstInput = modal.querySelector("input:not([type=hidden])");
    (firstInput || modal.querySelector("button, a"))?.focus();
  }

  function closeModal(modal) {
    if (!modal) return;
    modal.hidden = true;
    lastFocusedElement?.focus();
  }

  function showError(id, message) {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = message;
    element.hidden = false;
  }

  function clearError(id) {
    const element = document.getElementById(id);
    if (element) {
      element.textContent = "";
      element.hidden = true;
    }
  }

  function firebaseAuthErrorMessage(error, action) {
    switch (error.code) {
      case "auth/invalid-credential":
      case "auth/wrong-password":
      case "auth/user-not-found":
        return "The email or password is incorrect.";
      case "auth/email-already-in-use":
        return "An account already exists for this email. Sign in or use password reset.";
      case "auth/weak-password":
        return "Choose a stronger password with at least 6 characters.";
      case "auth/invalid-email":
        return "Enter a valid email address.";
      case "auth/too-many-requests":
        return "Too many attempts. Wait a while, then try again.";
      case "auth/network-request-failed":
        return "Could not reach Supabase. Check your internet connection and try again.";
      case "auth/operation-not-allowed":
        return "Email/password sign-in is disabled in Supabase Authentication.";
      case "permission-denied":
      case "firestore/permission-denied":
        return action === "signup"
          ? "Could not verify administrator setup. Publish the current Supabase policies, then try again."
          : "Could not verify your account role. Check the Supabase policies and try again.";
      default:
        return action === "signup"
          ? "The account could not be created. Check Supabase Authentication and try again."
          : "Sign-in could not be completed. Check your connection and Supabase setup, then try again.";
    }
  }

  const savedState = (() => {
    try {
      return JSON.parse(localStorage.getItem("tajiri-pos") || "null");
    } catch (error) {
      console.error("Could not read Tajiri POS settings:", error);
      return null;
    }
  })();
  const settings = savedState?.settings || {};
  const roleShell = new URLSearchParams(window.location.search)
    .get("roleShell")
    ?.toLowerCase();
  function setAdminSignupAllowed(allowed) {
    adminSignupAllowed = Boolean(allowed && roleShell === "admin");
    accessModal
      .querySelector(".auth-card")
      ?.classList.toggle("signup-unavailable", !adminSignupAllowed);
    const signupTab = document.querySelector("#tabSignup");
    const signupForm = document.querySelector("#signupForm");
    const signupSwitch = document.querySelector("#signupSwitch");
    const signupRole = document.querySelector("#signupRole");
    const adminSetupButton = document.querySelector("#adminSetupButton");
    if (adminSetupButton) adminSetupButton.hidden = !adminSignupAllowed;
    if (signupTab) {
      signupTab.hidden = !adminSignupAllowed;
      if (adminSignupAllowed) signupTab.textContent = "Create admin account";
    }
    if (signupForm) signupForm.hidden = !adminSignupAllowed;
    if (signupSwitch) signupSwitch.hidden = !adminSignupAllowed;
    const signupSwitchButton = signupSwitch?.querySelector("button");
    if (signupSwitchButton) {
      signupSwitchButton.textContent = "Create first admin account";
    }
    if (adminSetupButton && adminSignupAllowed) {
      adminSetupButton.textContent = "Create first admin account";
    }
    const signupHeading = signupForm?.querySelector("h2");
    const signupDescription = signupForm?.querySelector(".auth-sub");
    if (adminSignupAllowed) {
      if (signupHeading) signupHeading.textContent = "Create admin account";
      if (signupDescription) {
        signupDescription.textContent =
          "Set up the first administrator. Signup closes after setup is complete.";
      }
    }
    if (signupRole) {
      signupRole.value = "admin";
      signupRole.closest("label")?.setAttribute("hidden", "");
    }
  }
  const firebaseEnabled = Boolean(window.firebaseAuth && window.firebaseDb);
  if (firebaseEnabled) {
    setAdminSignupAllowed(false);
    window.firebaseDb
      .collection("system")
      .doc("bootstrap")
      .get()
      .then(snapshot => {
        setAdminSignupAllowed(!snapshot.exists);
        clearError("adminSetupError");
      })
      .catch(error => {
        console.error("Could not check Supabase admin setup:", error);
        setAdminSignupAllowed(true);
        const setupCheckMessage =
          error.code === "permission-denied" ||
          error.code === "firestore/permission-denied"
            ? "Supabase denied the setup-status check. Apply the policies from supabase-schema.sql, then refresh. Registration cannot continue until the check succeeds."
            : "Could not reach Supabase to check admin setup. Check your connection, then refresh. Registration cannot continue until the check succeeds.";
        showError(
          "adminSetupError",
          setupCheckMessage,
        );
        showToast("Admin setup could not be verified. See the message on the sign-in form.");
      });
  } else {
    setAdminSignupAllowed(false);
    if (roleShell === "admin" && !window.__tajiriFirebaseError) {
      showError(
        "adminSetupError",
        "First-time administrator signup requires Supabase Authentication and the Tajiri POS schema.",
      );
    }
  }
  setActiveTab("login");
  if (roleShell === "admin") {
    const heroTitle = document.querySelector("#welcomeHeroTitle");
    if (heroTitle) heroTitle.textContent = "Admin sign in";
    const welcomeTagline = document.querySelector("#welcomeTagline");
    if (welcomeTagline) {
      welcomeTagline.textContent =
        "Secure access to your store, staff, inventory, and reports.";
    }
    const modalHeading = accessModal.querySelector(".modal-head h2");
    if (modalHeading) modalHeading.textContent = "Admin sign in";
    accessModal.setAttribute("aria-label", "Administrator sign in");
    accessModal
      .querySelector('[role="dialog"]')
      ?.setAttribute("aria-label", "Administrator sign in");
    const loginHeading = document.querySelector("#loginForm h2");
    if (loginHeading) loginHeading.textContent = "Welcome back";
    const loginDescription = document.querySelector("#loginForm .auth-sub");
    if (loginDescription) {
      loginDescription.textContent =
        "Sign in with your administrator email and password.";
    }
    const loginTrigger = document.querySelector(
      '[data-modal-open="modal-access"][data-auth-tab="login"]',
    );
    if (loginTrigger) loginTrigger.textContent = "Admin sign in";
    const signupEmail = document.querySelector("#signupEmail");
    if (signupEmail) signupEmail.placeholder = "you@example.com";
  }
  if (roleShell === "cashier") {
    const heroTitle = document.querySelector("#welcomeHeroTitle");
    if (heroTitle) heroTitle.textContent = "Cashier sign in";
    const modalHeading = accessModal.querySelector(".modal-head h2");
    if (modalHeading) modalHeading.textContent = "Cashier sign in";
    accessModal.setAttribute("aria-label", "Cashier sign in");
    const loginHeading = document.querySelector("#loginForm h2");
    if (loginHeading) loginHeading.textContent = "Ready for your shift?";
    const loginDescription = document.querySelector("#loginForm .auth-sub");
    if (loginDescription)
      loginDescription.textContent =
      "Use the email and password provided by your administrator.";
  }
  if (window.__tajiriFirebaseError) showToast(window.__tajiriFirebaseError);
  if (!firebaseEnabled && !window.__tajiriFirebaseError) {
    showToast(
      "Cloud sign-in is unavailable. Local accounts only work on this browser.",
    );
  }
  const brand = settings.receiptShopName || settings.storeName || "Tajiri POS";
  const tagline = settings.welcomeTagline || "Smart POS Solutions for Modern Shops";
  document.querySelector("#welcomeBrandName")?.replaceChildren(document.createTextNode(brand));
  document.querySelector("#welcomeFooterBrand")?.replaceChildren(document.createTextNode(brand));
  document.querySelector("#welcomeTagline")?.replaceChildren(document.createTextNode(tagline));
  if (roleShell === "admin") {
    const welcomeTagline = document.querySelector("#welcomeTagline");
    if (welcomeTagline) {
      welcomeTagline.textContent =
        "Secure access to your store, staff, inventory, and reports.";
    }
  } else if (roleShell === "cashier") {
    const welcomeTagline = document.querySelector("#welcomeTagline");
    if (welcomeTagline)
      welcomeTagline.textContent = "Sign in to start your shift and process sales.";
  }
  const heroYear = document.querySelector("#heroYear");
  if (heroYear) heroYear.textContent = String(new Date().getFullYear());
  const heroAccounts = document.querySelector("#heroAccounts");
  if (heroAccounts) {
    heroAccounts.textContent = "";
    heroAccounts.hidden = true;
  }
  if (roleShell === "admin" || roleShell === "cashier") {
    openModal(accessModal);
  }

  document.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const openTrigger = target.closest("[data-modal-open]");
    if (openTrigger) {
      const modal = document.getElementById(openTrigger.dataset.modalOpen);
      if (modal) {
        openModal(modal, openTrigger);
        const tab = openTrigger.dataset.authTab;
        if (tab === "login" || tab === "signup") setActiveTab(tab);
      }
    }

    const tab = target.closest("[data-tab]");
    if (tab && accessModal.contains(tab)) setActiveTab(tab.dataset.tab);

    const switchButton = target.closest("[data-switch]");
    if (switchButton) setActiveTab(switchButton.dataset.switch);

    const closeTrigger = target.closest("[data-modal-close]");
    if (closeTrigger) closeModal(closeTrigger.closest(".modal-layer"));

    if (target.classList.contains("modal-layer")) closeModal(target);

    const navButton = target.closest("#navMoreBtn");
    const menu = document.querySelector("#navMoreMenu");
    if (navButton && menu) {
      menu.hidden = !menu.hidden;
      navButton.setAttribute("aria-expanded", String(!menu.hidden));
    } else if (menu && !target.closest("#navMoreMenu")) {
      menu.hidden = true;
      document.querySelector("#navMoreBtn")?.setAttribute("aria-expanded", "false");
    }

    if (target.closest("#forgotLink")) {
      const resetModal = document.querySelector("#modal-password-reset");
      if (resetModal) openModal(resetModal, target.closest("#forgotLink"));
    }

    if (target.closest("#passwordResetResend")) {
      event.preventDefault();
      showToast("Password reset delivery is not configured. Contact your store administrator.");
    }

    if (target.closest("[data-installer-download]")) {
      const downloadsModal = document.querySelector("#modal-downloads");
      if (downloadsModal) {
        event.preventDefault();
        openModal(downloadsModal, target.closest("[data-installer-download]"));
      }
    }
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      document.querySelectorAll(".modal-layer:not([hidden])").forEach(closeModal);
      const menu = document.querySelector("#navMoreMenu");
      if (menu) menu.hidden = true;
      document.querySelector("#navMoreBtn")?.setAttribute("aria-expanded", "false");
    }
  });

  document.querySelector("#loginForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    clearError("loginError");
    const identity = normalize(document.querySelector("#loginIdentity")?.value);
    const password = document.querySelector("#loginPassword")?.value || "";
    if (!identity || !password) {
      return showError(
        "loginError",
        firebaseEnabled
          ? "Enter your email and password."
          : "Enter your username or email and password.",
      );
    }

    const submit = document.querySelector("#loginSubmit");
    if (submit) {
      submit.disabled = true;
      submit.textContent = "Checking account…";
    }
    try {
      if (firebaseEnabled) {
        if (!identity.includes("@")) {
          showError("loginError", "Sign in with the email address set by your administrator.");
          return;
        }
        const remember = Boolean(document.querySelector("#rememberLogin")?.checked);
        await window.firebaseAuth.setPersistence(
          remember
            ? firebase.auth.Auth.Persistence.LOCAL
            : firebase.auth.Auth.Persistence.SESSION,
        );
        const credential = await window.firebaseAuth.signInWithEmailAndPassword(
          identity,
          password,
        );
        if (!credential.user.emailVerified) {
          await credential.user.sendEmailVerification();
          await window.firebaseAuth.signOut();
          showError(
            "loginError",
            "Verify your email using the link we just sent, then sign in again.",
          );
          return;
        }
        const profileSnapshot = await window.firebaseDb
          .collection("users")
          .doc(credential.user.uid)
          .get();
        let profile = profileSnapshot.exists
          ? { ...profileSnapshot.data(), uid: credential.user.uid }
          : null;
        if (
          !profile &&
          roleShell === "admin"
        ) {
          const bootstrapRef = window.firebaseDb.collection("system").doc("bootstrap");
          const bootstrapSnapshot = await bootstrapRef.get();
          if (!bootstrapSnapshot.exists) {
            let pendingProfile = null;
            try {
              pendingProfile = JSON.parse(
                localStorage.getItem("tajiri-pending-admin-profile") || "null",
              );
            } catch (error) {
              console.error("Could not read pending admin profile:", error);
            }
            const username =
              pendingProfile?.username ||
              identity.split("@")[0].replace(/[^a-z0-9._-]/g, "").slice(0, 60) ||
              "admin";
            profile = {
              name: pendingProfile?.name || credential.user.displayName || identity,
              username,
              email: identity,
              phone: pendingProfile?.phone || "",
              role: "admin",
              uid: credential.user.uid,
              createdAt: new Date().toISOString(),
            };
            await window.firebaseDb.runTransaction(async transaction => {
              const currentBootstrap = await transaction.get(bootstrapRef);
              if (currentBootstrap.exists) {
                throw new Error("Admin setup has already been completed.");
              }
              transaction.set(bootstrapRef, {
                adminUid: credential.user.uid,
                adminCount: 1,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
              });
              transaction.set(
                window.firebaseDb.collection("users").doc(credential.user.uid),
                profile,
              );
            });
            localStorage.removeItem("tajiri-pending-admin-profile");
          }
        }
        if (!profile || !["admin", "cashier"].includes(profile.role)) {
          await window.firebaseAuth.signOut();
          showError(
            "loginError",
            "This cloud account has no Tajiri POS role. Ask your administrator to create or repair the account.",
          );
          return;
        }
        saveAccounts([profile]);
        startSession(profile, remember);
        return;
      }
      const accounts = readAccounts();
      const account = accounts.find(candidate =>
        [candidate.username, candidate.email, candidate.name]
          .filter(Boolean)
          .some(value => normalize(value) === identity)
      );
      if (!account?.passwordHash || account.passwordHash !== await hashPassword(password)) {
        showError("loginError", "That username/email and password combination was not found.");
        return;
      }
      startSession(account, Boolean(document.querySelector("#rememberLogin")?.checked));
    } catch (error) {
      console.error("Tajiri POS sign-in failed:", error);
      if (firebaseEnabled && window.firebaseAuth.currentUser) {
        try {
          await window.firebaseAuth.signOut();
        } catch (signOutError) {
          console.error("Could not close the failed Firebase sign-in:", signOutError);
        }
      }
      showError(
        "loginError",
        firebaseAuthErrorMessage(error, "login"),
      );
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = "Sign in →";
      }
    }
  });

  document.querySelector("#signupForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    clearError("signupError");
    if (!firebaseEnabled) {
      showError(
        "signupError",
        "Cloud account setup is unavailable. Check Supabase Authentication and the Tajiri POS schema, then refresh.",
      );
      return;
    }
    if (roleShell !== "admin" || !adminSignupAllowed) {
      showError("signupError", "First administrator registration is unavailable. Sign in or contact your system administrator.");
      return;
    }

    const name = document.querySelector("#signupName")?.value.trim() || "";
    const username = normalize(document.querySelector("#signupUsername")?.value);
    const email = normalize(document.querySelector("#signupEmail")?.value);
    const phone = document.querySelector("#signupPhone")?.value.trim() || "";
    const password = document.querySelector("#signupPassword")?.value || "";
    const confirmation = document.querySelector("#signupConfirmPassword")?.value || "";
    if (!name || !username || !email || !password || !confirmation) {
      return showError("signupError", "Complete all required fields to create the account.");
    }
    if (!/^[a-z0-9._-]{2,60}$/.test(username)) {
      return showError("signupError", "Use 2–60 letters, numbers, dots, underscores, or hyphens for the username.");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return showError("signupError", "Enter a valid email address.");
    }
    if (phone && !/^(?:\+254[71][0-9]{8}|0[71][0-9]{8})$/.test(phone)) {
      return showError("signupError", "Use a Kenyan phone number without spaces, for example 0712345678.");
    }
    if (password.length < 6) return showError("signupError", "Use a password with at least 6 characters.");
    if (password !== confirmation) return showError("signupError", "The passwords do not match.");

    const submit = document.querySelector("#signupSubmit");
    if (submit) {
      submit.disabled = true;
      submit.textContent = "Creating account…";
    }
    try {
      const bootstrapSnapshot = await window.firebaseDb
        .collection("system")
        .doc("bootstrap")
        .get();
      if (bootstrapSnapshot.exists) {
        setAdminSignupAllowed(false);
        setActiveTab("login");
        showError(
          "adminSetupError",
          "Administrator setup is already complete. Sign in with your administrator account.",
        );
        return;
      }

      await window.firebaseAuth.setPersistence(
        firebase.auth.Auth.Persistence.SESSION,
      );
      const credential = await window.firebaseAuth.createUserWithEmailAndPassword(
        email,
        password,
      );
      try {
        await credential.user.updateProfile({ displayName: name });
        await credential.user.sendEmailVerification();
        localStorage.setItem(
          "tajiri-pending-admin-profile",
          JSON.stringify({ name, username, email, phone }),
        );
        await window.firebaseAuth.signOut();
        showError(
          "signupError",
          "Check your email and verify the address. Then return to Admin sign in and sign in to finish setup.",
        );
        return;
      } catch (error) {
        await credential.user.delete();
        throw error;
      }
    } catch (error) {
      console.error("Tajiri POS account creation failed:", error);
      showError("signupError", firebaseAuthErrorMessage(error, "signup"));
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = "Create account →";
      }
    }
  });

  document.querySelector("#passwordResetForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const email = normalize(document.querySelector("#passwordResetIdentity")?.value);
    if (!firebaseEnabled) {
      showError("passwordResetError", "Password reset delivery is not configured. Contact your store administrator.");
      return;
    }
    try {
      await window.firebaseAuth.sendPasswordResetEmail(email);
      showToast("Password reset instructions sent to your email.");
      closeModal(document.querySelector("#modal-password-reset"));
    } catch (error) {
      console.error("Tajiri POS password reset failed:", error);
      showError("passwordResetError", "Could not send the reset email. Check the address and Supabase email settings.");
    }
  });
  document.querySelector("#passwordResetConfirmForm")?.addEventListener("submit", event => {
    event.preventDefault();
    showError("passwordResetConfirmError", "Password reset delivery is not configured. Contact your store administrator.");
  });

  document.querySelector("#signupPassword")?.addEventListener("input", event => {
    const meter = document.querySelector("#strengthMeter");
    const fill = document.querySelector("#strengthFill");
    const label = document.querySelector("#strengthLabel");
    const value = event.target.value;
    if (!meter || !fill || !label) return;
    meter.hidden = !value;
    const score = Math.min(4, Number(value.length >= 8) + Number(/[A-Z]/.test(value)) + Number(/[0-9]/.test(value)) + Number(/[^a-zA-Z0-9]/.test(value)));
    const levels = ["Very weak", "Weak", "Fair", "Good", "Strong"];
    fill.style.width = `${score * 25}%`;
    fill.style.background = score < 2 ? "#f08c8c" : score < 4 ? "#e5bd70" : "#79e2ae";
    label.textContent = levels[score];
  });

  const rememberedIdentity = localStorage.getItem("tajiri-remembered-user");
  const rememberedRole = localStorage.getItem("tajiri-remembered-role");
  const rememberedSignature = localStorage.getItem("tajiri-remembered-signature");
  if (
    rememberedIdentity &&
    rememberedRole &&
    rememberedSignature === sessionSignature(rememberedIdentity, rememberedRole)
  ) {
    const identityField = document.querySelector("#loginIdentity");
    const rememberField = document.querySelector("#rememberLogin");
    if (identityField) identityField.value = rememberedIdentity;
    if (rememberField) rememberField.checked = true;
  }
})();
