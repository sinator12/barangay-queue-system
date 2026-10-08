const loginForm = document.querySelector("#login-form");
const usernameInput = document.querySelector("#username");
const passwordInput = document.querySelector("#password");
const loginButton = document.querySelector("#login-button");
const formMessage = document.querySelector("#form-message");
const mfaSetupPanel = document.querySelector("#mfa-setup");
const mfaSecret = document.querySelector("#mfa-secret");
const mfaCodeInput = document.querySelector("#mfa-code");
const mfaCodeLabel = document.querySelector("#mfa-code-label");
const recoveryPanel = document.querySelector("#recovery-codes-panel");
const recoveryCodesList = document.querySelector("#recovery-codes");
const recoveryContinue = document.querySelector("#recovery-continue");
let mfaStep = "password";

function showMfaSetup(secret) {
  mfaStep = "enroll";
  mfaSecret.textContent = secret;
  mfaSetupPanel.hidden = false;
  mfaCodeLabel.hidden = false;
  mfaCodeLabel.textContent = "Six-digit authenticator code";
  mfaCodeInput.hidden = false;
  mfaCodeInput.required = true;
  mfaCodeInput.inputMode = "numeric";
  loginButton.textContent = "Verify & Enable Two-Step Sign-in";
  formMessage.textContent = "Add this account to an authenticator app, then enter its current code.";
  mfaCodeInput.focus();
}

function showMfaPrompt() {
  mfaStep = "verify";
  mfaCodeLabel.hidden = false;
  mfaCodeLabel.textContent = "Authenticator code or one-time recovery code";
  mfaCodeInput.hidden = false;
  mfaCodeInput.required = true;
  mfaCodeInput.inputMode = "text";
  loginButton.textContent = "Verify & Sign In";
  formMessage.textContent = "Enter the code from your authenticator app. A saved one-time recovery code also works.";
  mfaCodeInput.focus();
}

function showRecoveryCodes(codes) {
  mfaStep = "recovery";
  loginForm.hidden = true;
  recoveryPanel.hidden = false;
  recoveryCodesList.replaceChildren();

  for (const code of codes) {
    const item = document.createElement("li");
    item.textContent = code;
    recoveryCodesList.append(item);
  }
}

async function redirectIfAlreadySignedIn() {
  try {
    const { setupRequired } = await QueueApi.getSetupStatus();

    if (setupRequired) {
      window.location.replace("setup.html");
      return;
    }

    await QueueApi.getCurrentUser();
    window.location.replace("admin.html");
  } catch {
    // The visitor is not signed in yet, so the login form remains visible.
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  formMessage.textContent = "";
  loginButton.disabled = true;

  try {
    if (mfaStep === "enroll") {
      const result = await QueueApi.enrollAdminMfa(
        usernameInput.value.trim(),
        passwordInput.value,
        mfaCodeInput.value.trim()
      );
      passwordInput.value = "";
      mfaCodeInput.value = "";
      showRecoveryCodes(result.recoveryCodes || []);
      return;
    }

    await QueueApi.login(
      usernameInput.value.trim(),
      passwordInput.value,
      mfaStep === "verify" ? mfaCodeInput.value.trim() : ""
    );
    window.location.replace("admin.html");
  } catch (error) {
    if (error.payload?.mfaSetupRequired) {
      showMfaSetup(error.payload.mfaSecret);
    } else if (error.payload?.mfaRequired) {
      showMfaPrompt();
    } else {
      formMessage.textContent = error.message;
      (mfaStep === "verify" || mfaStep === "enroll" ? mfaCodeInput : passwordInput).focus();
    }
  } finally {
    loginButton.disabled = false;
  }
});

recoveryContinue.addEventListener("click", () => {
  window.location.replace("admin.html");
});

for (const input of [usernameInput, passwordInput]) {
  input.addEventListener("input", () => {
    if (mfaStep === "enroll" || mfaStep === "verify") {
      mfaStep = "password";
      mfaSetupPanel.hidden = true;
      mfaCodeLabel.hidden = true;
      mfaCodeInput.hidden = true;
      mfaCodeInput.required = false;
      mfaCodeInput.value = "";
      loginButton.textContent = "Sign In";
      formMessage.textContent = "Sign-in details changed. Submit again to continue.";
    }
  });
}

redirectIfAlreadySignedIn();
