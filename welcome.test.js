// @vitest-environment node
//
// Unit tests for welcome.js (the sign-in / admin-signup page script).
//
// welcome.js is a browser IIFE with no module exports, so — like app.test.js —
// we evaluate it inside a jsdom window with a minimal DOM fixture and assert
// on observable side effects: toasts, error messages, tabs, sessionStorage
// entries, and validation messages.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { JSDOM } = require("jsdom");
const { beforeEach, describe, expect, it, vi } = await import("vitest");

const SOURCE_PATH = path.join(__dirname, "welcome.js");
const source = fs.readFileSync(SOURCE_PATH, "utf8");

/* ---------- DOM fixture ---------- */

const FIXTURE_HTML = `
<body>
  <section id="welcomeView">
    <h1><span id="welcomeBrandName">Tajiri POS</span></h1>
    <p id="welcomeTagline">Smart POS Solutions for Modern Shops</p>
    <span id="heroYear"></span>
    <div id="heroAccounts"></div>
  </section>

  <div id="modal-access" hidden>
    <div class="modal-layer">
      <div role="dialog">
        <div class="modal-head"><h2>Sign in to Tajiri POS</h2></div>
        <div class="auth-card">
          <button id="tabLogin" data-tab="login">Sign in</button>
          <button id="tabSignup" data-tab="signup" hidden>Sign up</button>
          <form id="loginForm" class="auth-form">
            <h2>Welcome back</h2>
            <p class="auth-sub">Sign in to continue.</p>
            <input id="loginIdentity" />
            <input id="loginPassword" type="password" />
            <input id="rememberLogin" type="checkbox" />
            <button id="loginSubmit" type="submit">Sign in →</button>
            <p id="loginError" hidden></p>
            <a id="forgotLink" href="#">Forgot password?</a>
          </form>
          <form id="signupForm" class="auth-form" hidden>
            <h2>Create account</h2>
            <p class="auth-sub">Set up the first administrator.</p>
            <input id="signupName" />
            <input id="signupUsername" />
            <input id="signupEmail" />
            <input id="signupPhone" />
            <label><input id="signupRole" /></label>
            <input id="signupPassword" type="password" />
            <input id="signupConfirmPassword" type="password" />
            <button id="signupSubmit" type="submit">Create account →</button>
            <p id="signupError" hidden></p>
            <p id="adminSetupError" hidden></p>
            <div id="strengthMeter" hidden>
              <div id="strengthFill"></div>
              <span id="strengthLabel"></span>
            </div>
          </form>
        </div>
      </div>
    </div>
  </div>

  <div id="modal-password-reset" hidden>
    <div class="modal-layer">
      <form id="passwordResetForm">
        <input id="passwordResetIdentity" />
        <p id="passwordResetError" hidden></p>
      </form>
      <form id="passwordResetConfirmForm">
        <p id="passwordResetConfirmError" hidden></p>
      </form>
    </div>
  </div>

  <div id="toast"></div>
  <button id="navMoreBtn" aria-expanded="false"></button>
  <div id="navMoreMenu" hidden></div>
</body>`;

/* ---------- helpers ---------- */

function makeFirebaseStubs() {
  return {
    firebaseAuth: {
      setPersistence: vi.fn().mockResolvedValue(undefined),
      signInWithEmailAndPassword: vi.fn().mockResolvedValue({
        user: {
          uid: "uid-1",
          emailVerified: true,
          displayName: "Ada",
          sendEmailVerification: vi.fn().mockResolvedValue(undefined),
          updateProfile: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
        },
      }),
      createUserWithEmailAndPassword: vi.fn().mockResolvedValue({
        user: {
          uid: "uid-new",
          sendEmailVerification: vi.fn().mockResolvedValue(undefined),
          updateProfile: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
        },
      }),
      sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn().mockResolvedValue(undefined),
      currentUser: null,
    },
    firebaseDb: {
      collection: (name) => ({
        name,
        doc: () => ({
          get: async () => ({ exists: false, data: () => ({}) }),
          set: vi.fn(),
        }),
      }),
      runTransaction: vi.fn().mockResolvedValue(undefined),
    },
  };
}

// Builds a jsdom document, injects a stubbed window.location, then evaluates
// welcome.js inside it. Returns the JSDOM instance.
function loadWelcomePage({
  url = "https://pos.example.test/welcome.html",
  stubs = {},
} = {}) {
  const dom = new JSDOM(FIXTURE_HTML, {
    url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const win = dom.window;

  // jsdom's Location is read-only; replace it with a controllable stub.
  // The script needs `window.location.search` (role shell routing) and must
  // not actually navigate on `window.location.reload()`.
  const locationStub = {
    search: new URL(url).search,
    href: url,
    reload: vi.fn(),
    assign: vi.fn(),
  };
  try {
    delete win.location;
  } catch {
    /* some jsdom versions keep it; the try below covers us either way */
  }
  let effectiveLocation = locationStub;
  try {
    win.location = locationStub;
  } catch {
    effectiveLocation = win.location;
    win.location.reload = locationStub.reload;
    win.location.assign = locationStub.assign;
  }
  win.__location = effectiveLocation;

  Object.assign(win, stubs);

  // welcome.js reads the global `firebase` SDK object for persistence enums
  // and Firestore server timestamps, independent of window.firebaseAuth/Db.
  if (!win.firebase) {
    win.firebase = {
      auth: {
        Auth: {
          Persistence: { LOCAL: "local", SESSION: "session" },
        },
      },
      firestore: {
        FieldValue: {
          serverTimestamp: () => null,
        },
      },
    };
  }

  // Silence the noisy "Not implemented: window.scrollTo" style jsdom errors.
  win.addEventListener("error", () => {});

  win.eval(source);
  return dom;
}

function submitForm(dom, formId) {
  const event = new dom.window.Event("submit", {
    bubbles: true,
    cancelable: true,
  });
  dom.window.document.getElementById(formId).dispatchEvent(event);
}

function click(dom, selector) {
  const element = dom.window.document.querySelector(selector);
  element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  return element;
}

function textOfError(dom, id) {
  const element = dom.window.document.getElementById(id);
  return { text: element.textContent, hidden: element.hidden };
}

// Mirrors the FNV-1a session signature used by welcome.js.
function sessionSignature(user, role) {
  const value = `${String(user || "").trim()}|${String(role || "").trim()}|tajiri-pos-session-v1`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// Mirrors welcome.js hashPassword: SHA-256 when crypto.subtle exists in the
// jsdom window, otherwise the FNV-1a fallback. Node's createHash produces the
// identical hex digest as SubtleCrypto.digest.
function expectedPasswordHash(win, password) {
  if (win.crypto && win.crypto.subtle) {
    return crypto.createHash("sha256").update(password, "utf8").digest("hex");
  }
  let hash = 2166136261;
  for (const character of password) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return `fallback-${(hash >>> 0).toString(16)}`;
}

function flush(times = 4) {
  let promise = Promise.resolve();
  for (let i = 0; i < times; i += 1) {
    promise = promise.then(
      () => new Promise((resolve) => setTimeout(resolve, 0)),
    );
  }
  return promise;
}

/* ---------- tests ---------- */

describe("welcome.js", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("boot-time rendering", () => {
    it("activates the login tab by default and hides other forms", () => {
      const dom = loadWelcomePage();
      const doc = dom.window.document;
      expect(doc.getElementById("loginForm").classList.contains("active")).toBe(
        true,
      );
      expect(
        doc.getElementById("signupForm").classList.contains("active"),
      ).toBe(false);
      expect(doc.getElementById("tabLogin").getAttribute("aria-selected")).toBe(
        "true",
      );
    });

    it("shows the offline toast when the cloud backend is unavailable", () => {
      const dom = loadWelcomePage();
      expect(dom.window.document.getElementById("toast").textContent).toBe(
        "Cloud sign-in is unavailable. Local accounts only work on this browser.",
      );
    });

    it("renders brand/tagline from saved settings with safe fallbacks", () => {
      const dom = loadWelcomePage({
        stubs: {},
      });
      // No saved state → default brand and tagline.
      expect(
        dom.window.document.getElementById("welcomeBrandName").textContent,
      ).toBe("Tajiri POS");
      expect(
        dom.window.document.getElementById("welcomeTagline").textContent,
      ).toBe("Smart POS Solutions for Modern Shops");
    });

    it("stamps the current year into the hero", () => {
      const dom = loadWelcomePage();
      expect(dom.window.document.getElementById("heroYear").textContent).toBe(
        String(new Date().getFullYear()),
      );
    });

    it("auto-opens the access modal for the admin role shell", () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
      });
      expect(dom.window.document.getElementById("modal-access").hidden).toBe(
        false,
      );
      expect(
        dom.window.document.querySelector(".modal-head h2").textContent,
      ).toBe("Admin sign in");
    });

    it("auto-opens the access modal for the cashier role shell", () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=cashier",
      });
      expect(dom.window.document.getElementById("modal-access").hidden).toBe(
        false,
      );
      expect(
        dom.window.document.querySelector(".modal-head h2").textContent,
      ).toBe("Cashier sign in");
    });

    it("blocks admin signup when Supabase is not configured", async () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
      });
      await flush();
      expect(textOfError(dom, "adminSetupError").text).toBe(
        "First-time administrator signup requires Supabase Authentication and the Tajiri POS schema.",
      );
    });

    describe("remembered user restore", () => {
      it("pre-fills the login form when the stored signature is valid", () => {
        const dom = new JSDOM(FIXTURE_HTML, {
          url: "https://pos.example.test/welcome.html",
          runScripts: "outside-only",
          pretendToBeVisual: true,
        });
        const win = dom.window;
        win.localStorage.setItem("tajiri-remembered-user", "ada");
        win.localStorage.setItem("tajiri-remembered-role", "admin");
        win.localStorage.setItem(
          "tajiri-remembered-signature",
          sessionSignature("ada", "admin"),
        );
        win.eval(source);
        expect(win.document.getElementById("loginIdentity").value).toBe("ada");
        expect(win.document.getElementById("rememberLogin").checked).toBe(true);
      });

      it("ignores a remembered user whose signature does not match", () => {
        const dom = new JSDOM(FIXTURE_HTML, {
          url: "https://pos.example.test/welcome.html",
          runScripts: "outside-only",
          pretendToBeVisual: true,
        });
        const win = dom.window;
        win.localStorage.setItem("tajiri-remembered-user", "mallory");
        win.localStorage.setItem("tajiri-remembered-role", "admin");
        win.localStorage.setItem("tajiri-remembered-signature", "deadbeef");
        win.eval(source);
        expect(win.document.getElementById("loginIdentity").value).toBe("");
        expect(win.document.getElementById("rememberLogin").checked).toBe(
          false,
        );
      });
    });
  });

  describe("modal and tab interactions", () => {
    it("opens the modal from a [data-modal-open] trigger and switches tabs", () => {
      const dom = loadWelcomePage();
      const doc = dom.window.document;
      const trigger = doc.createElement("button");
      trigger.dataset.modalOpen = "modal-access";
      trigger.dataset.authTab = "login";
      doc.body.appendChild(trigger);
      click(dom, "button[data-modal-open]");
      expect(doc.getElementById("modal-access").hidden).toBe(false);
    });

    it("switches to the signup tab only via [data-tab] clicks", () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
      });
      const doc = dom.window.document;
      // tabSignup is hidden while admin signup is not allowed...
      expect(doc.getElementById("tabSignup").hidden).toBe(true);
      // ...but the switch mechanism itself still responds to data-tab clicks.
      doc.getElementById("tabLogin").dataset.tab = "signup";
      click(dom, "#tabLogin");
      expect(
        doc.getElementById("signupForm").classList.contains("active"),
      ).toBe(true);
      expect(doc.querySelector(".modal-head h2").textContent).toBe(
        "Set up administrator",
      );
    });

    it("closes open modals on the Escape key", () => {
      const dom = loadWelcomePage();
      const doc = dom.window.document;
      const modal = doc.getElementById("modal-access");
      modal.hidden = false;
      doc.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
      expect(modal.hidden).toBe(true);
    });

    it("toggles the nav menu on button clicks", () => {
      const dom = loadWelcomePage();
      const doc = dom.window.document;
      const button = doc.getElementById("navMoreBtn");
      const menu = doc.getElementById("navMoreMenu");
      button.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
      expect(menu.hidden).toBe(false);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      button.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
      expect(menu.hidden).toBe(true);
      expect(button.getAttribute("aria-expanded")).toBe("false");
    });

    it("opens the password-reset modal from the forgot link", () => {
      const dom = loadWelcomePage();
      click(dom, "#forgotLink");
      expect(
        dom.window.document.getElementById("modal-password-reset").hidden,
      ).toBe(false);
    });
  });

  describe("local (non-cloud) login", () => {
    it("rejects empty credentials with a local-specific message", () => {
      const dom = loadWelcomePage();
      submitForm(dom, "loginForm");
      expect(textOfError(dom, "loginError").text).toBe(
        "Enter your username or email and password.",
      );
    });

    it("rejects an unknown username", () => {
      const dom = loadWelcomePage();
      const doc = dom.window.document;
      doc.getElementById("loginIdentity").value = "nobody";
      doc.getElementById("loginPassword").value = "hunter22";
      submitForm(dom, "loginForm");
      expect(textOfError(dom, "loginError").text).toBe(
        "That username/email and password combination was not found.",
      );
    });

    it("rejects a wrong password for a known account", () => {
      const dom = loadWelcomePage();
      const win = dom.window;
      win.localStorage.setItem(
        "tajiri-pos-accounts",
        JSON.stringify([
          {
            username: "ada",
            email: "ada@example.test",
            passwordHash: "nope",
            role: "admin",
          },
        ]),
      );
      docSetup(dom);
      docSetupLogin(dom, "ada", "hunter22");
      submitForm(dom, "loginForm");
      expect(textOfError(dom, "loginError").text).toBe(
        "That username/email and password combination was not found.",
      );
      expect(win.__location.reload).not.toHaveBeenCalled();
    });

    it("accepts matching credentials and starts a session", async () => {
      const dom = loadWelcomePage();
      const win = dom.window;
      const passwordHash = expectedPasswordHash(win, "s3cret!");
      win.localStorage.setItem(
        "tajiri-pos-accounts",
        JSON.stringify([
          {
            username: "ada",
            email: "ada@example.test",
            passwordHash,
            role: "admin",
          },
        ]),
      );
      const doc = win.document;
      doc.getElementById("loginIdentity").value = "  Ada  "; // case/trim tolerant
      doc.getElementById("loginPassword").value = "s3cret!";
      doc.getElementById("rememberLogin").checked = true;
      submitForm(dom, "loginForm");
      await flush();

      expect(win.sessionStorage.getItem("tajiri-session-user")).toBe("ada");
      expect(win.sessionStorage.getItem("tajiri-session-role")).toBe("admin");
      expect(win.sessionStorage.getItem("tajiri-session-signature")).toBe(
        sessionSignature("ada", "admin"),
      );
      // Remembered credentials persist beyond the session.
      expect(win.localStorage.getItem("tajiri-remembered-user")).toBe("ada");
      expect(win.__location.reload).toHaveBeenCalled();
    });

    it("clears remembered credentials when 'remember me' is unchecked", async () => {
      const dom = loadWelcomePage();
      const win = dom.window;
      win.localStorage.setItem("tajiri-remembered-user", "stale-user");
      win.localStorage.setItem(
        "tajiri-pos-accounts",
        JSON.stringify([
          {
            username: "ada",
            passwordHash: expectedPasswordHash(win, "s3cret!"),
            role: "cashier",
          },
        ]),
      );
      const doc = win.document;
      doc.getElementById("loginIdentity").value = "ada";
      doc.getElementById("loginPassword").value = "s3cret!";
      submitForm(dom, "loginForm");
      await flush();

      expect(win.localStorage.getItem("tajiri-remembered-user")).toBeNull();
      expect(win.sessionStorage.getItem("tajiri-session-role")).toBe("cashier");
    });

    it("matches login identity against email and name fields too", async () => {
      const dom = loadWelcomePage();
      const win = dom.window;
      win.localStorage.setItem(
        "tajiri-pos-accounts",
        JSON.stringify([
          {
            name: "Grace Ochieng",
            email: "grace@example.test",
            passwordHash: expectedPasswordHash(win, "pass123"),
            role: "cashier",
          },
        ]),
      );
      const doc = win.document;
      doc.getElementById("loginIdentity").value = "grace@example.test";
      doc.getElementById("loginPassword").value = "pass123";
      submitForm(dom, "loginForm");
      await flush();

      expect(win.sessionStorage.getItem("tajiri-session-user")).toBe(
        "grace@example.test",
      );
    });
  });

  describe("signup validation (cloud required)", () => {
    it("blocks signup entirely when Supabase is unavailable", () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
      });
      submitForm(dom, "signupForm");
      expect(textOfError(dom, "signupError").text).toBe(
        "Cloud account setup is unavailable. Check Supabase Authentication and the Tajiri POS schema, then refresh.",
      );
    });

    it("requires every field", () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs: makeFirebaseStubs(),
      });
      submitForm(dom, "signupForm");
      expect(textOfError(dom, "signupError").text).toBe(
        "Complete all required fields to create the account.",
      );
    });

    it("rejects usernames outside a-z0-9._- (2–60 chars)", () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs: makeFirebaseStubs(),
      });
      fillSignup(dom, { username: "bad user!", email: "a@b.co" });
      submitForm(dom, "signupForm");
      expect(textOfError(dom, "signupError").text).toBe(
        "Use 2–60 letters, numbers, dots, underscores, or hyphens for the username.",
      );
    });

    it("rejects malformed emails", () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs: makeFirebaseStubs(),
      });
      fillSignup(dom, { email: "not-an-email" });
      submitForm(dom, "signupForm");
      expect(textOfError(dom, "signupError").text).toBe(
        "Enter a valid email address.",
      );
    });

    it("rejects non-Kenyan phone numbers", () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs: makeFirebaseStubs(),
      });
      fillSignup(dom, { phone: "12345" });
      submitForm(dom, "signupForm");
      expect(textOfError(dom, "signupError").text).toBe(
        "Use a Kenyan phone number without spaces, for example 0712345678.",
      );
    });

    it.each(["+254712345678", "+254112345678", "0712345678", "0112345678"])(
      "accepts a valid Kenyan phone number: %s",
      async (phone) => {
        const stubs = makeFirebaseStubs();
        const dom = loadWelcomePage({
          url: "https://pos.example.test/welcome.html?roleShell=admin",
          stubs,
        });
        await flush();
        fillSignup(dom, { phone });
        submitForm(dom, "signupForm");
        await flush();

        expect(
          stubs.firebaseAuth.createUserWithEmailAndPassword,
        ).toHaveBeenCalledWith("ada@example.test", "longenough");
      },
    );

    it("rejects passwords shorter than 6 characters", () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs: makeFirebaseStubs(),
      });
      fillSignup(dom, { password: "abc12" });
      submitForm(dom, "signupForm");
      expect(textOfError(dom, "signupError").text).toBe(
        "Use a password with at least 6 characters.",
      );
    });

    it("rejects mismatched password confirmation", () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs: makeFirebaseStubs(),
      });
      fillSignup(dom, { password: "longenough", confirmation: "longenough2" });
      submitForm(dom, "signupForm");
      expect(textOfError(dom, "signupError").text).toBe(
        "The passwords do not match.",
      );
    });
  });

  describe("signup with Supabase", () => {
    it("refuses signup when the admin bootstrap already exists", async () => {
      const stubs = makeFirebaseStubs();
      // The boot-time check reads system/bootstrap: report that it exists.
      stubs.firebaseDb.collection = () => ({
        doc: () => ({
          get: async () => ({ exists: true, data: () => ({}) }),
          set: vi.fn(),
        }),
      });
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs,
      });
      await flush();
      fillSignup(dom, {});
      submitForm(dom, "signupForm");
      expect(textOfError(dom, "signupError").text).toBe(
        "First administrator registration is unavailable. Sign in or contact your system administrator.",
      );
    });

    it("creates the account and requests email verification", async () => {
      const stubs = makeFirebaseStubs();
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs,
      });
      await flush(); // let the bootstrap check allow signup
      const doc = dom.window.document;
      expect(doc.getElementById("tabSignup").hidden).toBe(false);

      fillSignup(dom, { password: "longenough", confirmation: "longenough" });
      submitForm(dom, "signupForm");
      await flush();

      expect(
        stubs.firebaseAuth.createUserWithEmailAndPassword,
      ).toHaveBeenCalledWith("ada@example.test", "longenough");
      const user = (
        await stubs.firebaseAuth.createUserWithEmailAndPassword.mock.results[0]
          .value
      ).user;
      expect(user.updateProfile).toHaveBeenCalledWith({
        displayName: "Ada Admin",
      });
      expect(user.sendEmailVerification).toHaveBeenCalled();
      expect(
        JSON.parse(
          dom.window.localStorage.getItem("tajiri-pending-admin-profile"),
        ),
      ).toEqual({
        name: "Ada Admin",
        username: "ada",
        email: "ada@example.test",
        phone: "0712345678",
      });
      expect(stubs.firebaseAuth.signOut).toHaveBeenCalled();
      expect(textOfError(dom, "signupError").text).toBe(
        "Check your email and verify the address. Then return to Admin sign in and sign in to finish setup.",
      );
    });

    it("explains when the signup email is already registered", async () => {
      const stubs = makeFirebaseStubs();
      stubs.firebaseAuth.createUserWithEmailAndPassword = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("already used"), {
            code: "auth/email-already-in-use",
          }),
        );
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs,
      });
      await flush();
      fillSignup(dom);
      submitForm(dom, "signupForm");
      await flush();

      expect(textOfError(dom, "signupError").text).toBe(
        "An account already exists for this email. Sign in or use password reset.",
      );
    });
  });

  describe("Supabase login", () => {
    it("demands an email address for cloud sign-in", async () => {
      const stubs = makeFirebaseStubs();
      const dom = loadWelcomePage({ stubs });
      const doc = dom.window.document;
      doc.getElementById("loginIdentity").value = "not-an-email";
      doc.getElementById("loginPassword").value = "whatever";
      submitForm(dom, "loginForm");
      await flush();
      expect(textOfError(dom, "loginError").text).toBe(
        "Sign in with the email address set by your administrator.",
      );
      expect(doc.getElementById("loginSubmit").disabled).toBe(false);
    });

    it("signs out accounts that have no Tajiri POS role", async () => {
      const stubs = makeFirebaseStubs();
      // No profile exists for the signed-in user.
      stubs.firebaseDb.collection = () => ({
        doc: () => ({
          get: async () => ({ exists: false, data: () => ({}) }),
          set: vi.fn(),
        }),
      });
      const dom = loadWelcomePage({ stubs });
      const doc = dom.window.document;
      doc.getElementById("loginIdentity").value = "ada@example.test";
      doc.getElementById("loginPassword").value = "longenough";
      submitForm(dom, "loginForm");
      await flush();

      expect(stubs.firebaseAuth.signOut).toHaveBeenCalled();
      expect(textOfError(dom, "loginError").text).toBe(
        "This cloud account has no Tajiri POS role. Ask your administrator to create or repair the account.",
      );
      expect(dom.window.__location.reload).not.toHaveBeenCalled();
    });

    it("maps Supabase auth error codes to a friendly message", async () => {
      const stubs = makeFirebaseStubs();
      stubs.firebaseAuth.signInWithEmailAndPassword = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("bad"), { code: "auth/wrong-password" }),
        );
      const dom = loadWelcomePage({ stubs });
      const doc = dom.window.document;
      doc.getElementById("loginIdentity").value = "ada@example.test";
      doc.getElementById("loginPassword").value = "nope";
      submitForm(dom, "loginForm");
      await flush();
      expect(textOfError(dom, "loginError").text).toBe(
        "The email or password is incorrect.",
      );
    });

    it("starts a session for a verified admin profile", async () => {
      const stubs = makeFirebaseStubs();
      stubs.firebaseDb.collection = () => ({
        doc: () => ({
          get: async () => ({
            exists: true,
            data: () => ({
              name: "Ada",
              role: "admin",
              email: "ada@example.test",
            }),
          }),
          set: vi.fn(),
        }),
      });
      const dom = loadWelcomePage({ stubs });
      const doc = dom.window.document;
      doc.getElementById("loginIdentity").value = "ada@example.test";
      doc.getElementById("loginPassword").value = "longenough";
      submitForm(dom, "loginForm");
      await flush();

      expect(dom.window.sessionStorage.getItem("tajiri-session-role")).toBe(
        "admin",
      );
      expect(
        dom.window.sessionStorage.getItem("tajiri-session-signature"),
      ).toBe(sessionSignature("ada@example.test", "admin"));
      expect(dom.window.__location.reload).toHaveBeenCalled();
    });
  });

  describe("password reset", () => {
    it("reports that reset delivery is not configured without Supabase", () => {
      const dom = loadWelcomePage();
      submitForm(dom, "passwordResetForm");
      expect(textOfError(dom, "passwordResetError").text).toBe(
        "Password reset delivery is not configured. Contact your store administrator.",
      );
    });

    it("sends the reset email and closes the modal when Supabase works", async () => {
      const stubs = makeFirebaseStubs();
      const dom = loadWelcomePage({ stubs });
      const doc = dom.window.document;
      doc.getElementById("modal-password-reset").hidden = false;
      doc.getElementById("passwordResetIdentity").value = "ada@example.test";
      submitForm(dom, "passwordResetForm");
      await flush();
      expect(stubs.firebaseAuth.sendPasswordResetEmail).toHaveBeenCalledWith(
        "ada@example.test",
      );
      expect(doc.getElementById("modal-password-reset").hidden).toBe(true);
    });

    it("shows an error when the reset email fails", async () => {
      const stubs = makeFirebaseStubs();
      stubs.firebaseAuth.sendPasswordResetEmail = vi
        .fn()
        .mockRejectedValue(new Error("offline"));
      const dom = loadWelcomePage({ stubs });
      docSetup(dom);
      dom.window.document.getElementById("passwordResetIdentity").value =
        "ada@example.test";
      submitForm(dom, "passwordResetForm");
      await flush();
      expect(textOfError(dom, "passwordResetError").text).toBe(
        "Could not send the reset email. Check the address and Supabase email settings.",
      );
    });

    it("always reports 'not configured' for the legacy confirm form", () => {
      const dom = loadWelcomePage();
      submitForm(dom, "passwordResetConfirmForm");
      expect(textOfError(dom, "passwordResetConfirmError").text).toBe(
        "Password reset delivery is not configured. Contact your store administrator.",
      );
    });
  });

  describe("password strength meter", () => {
    function meterFor(dom, password) {
      const doc = dom.window.document;
      const input = doc.getElementById("signupPassword");
      input.value = password;
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      return {
        hidden: doc.getElementById("strengthMeter").hidden,
        width: doc.getElementById("strengthFill").style.width,
        label: doc.getElementById("strengthLabel").textContent,
      };
    }

    it("hides the meter for an empty password", () => {
      const dom = loadWelcomePage();
      expect(meterFor(dom, "").hidden).toBe(true);
    });

    it("scores an all-lowercase short password as 'Very weak'", () => {
      const dom = loadWelcomePage();
      const meter = meterFor(dom, "abc");
      expect(meter.label).toBe("Very weak");
      expect(meter.width).toBe("0%");
    });

    it("scores a strong password at the top level", () => {
      const dom = loadWelcomePage();
      const meter = meterFor(dom, "Sup3r$ecret");
      expect(meter.label).toBe("Strong");
      expect(meter.width).toBe("100%");
    });

    it("caps the score at 4 levels", () => {
      const dom = loadWelcomePage();
      const meter = meterFor(dom, "Abcdefgh1!@#$");
      expect(meter.label).toBe("Strong");
      expect(meter.width).toBe("100%");
    });

    it("gives a medium password an intermediate level and color", () => {
      const dom = loadWelcomePage();
      const meter = meterFor(dom, "abcdefgh1");
      expect(meter.label).toBe("Fair");
      expect(meter.width).toBe("50%");
    });
  });

  describe("admin setup status messaging", () => {
    it("shows a permission-denied specific message when the cloud backend rejects the check", async () => {
      const stubs = makeFirebaseStubs();
      stubs.firebaseDb.collection = () => ({
        doc: () => ({
          get: () =>
            Promise.reject(
              Object.assign(new Error("denied"), { code: "permission-denied" }),
            ),
        }),
      });
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs,
      });
      await flush();
      expect(textOfError(dom, "adminSetupError").text).toContain(
        "Supabase denied the setup-status check",
      );
    });
  });
});

/* ---------- test-only utilities ---------- */

function docSetup(dom) {
  // Placeholder kept for readability; nothing to do — jsdom forms dispatch fine.
}

function docSetupLogin(dom, identity, password) {
  const doc = dom.window.document;
  doc.getElementById("loginIdentity").value = identity;
  doc.getElementById("loginPassword").value = password;
}

function fillSignup(
  dom,
  {
    name = "Ada Admin",
    username = "ada",
    email = "ada@example.test",
    phone = "0712345678",
    password = "longenough",
    confirmation = "longenough",
  } = {},
) {
  const doc = dom.window.document;
  doc.getElementById("signupName").value = name;
  doc.getElementById("signupUsername").value = username;
  doc.getElementById("signupEmail").value = email;
  doc.getElementById("signupPhone").value = phone;
  doc.getElementById("signupPassword").value = password;
  doc.getElementById("signupConfirmPassword").value = confirmation;
}
