const setupForm = document.querySelector("#setup-form");
const usernameInput = document.querySelector("#username");
const passwordInput = document.querySelector("#password");
const confirmPasswordInput = document.querySelector("#confirm-password");
const setupButton = document.querySelector("#setup-button");
const formMessage = document.querySelector("#form-message");

async function checkSetupStatus() {
  try {
    const { setupRequired } = await QueueApi.getSetupStatus();

    if (!setupRequired) {
      window.location.replace("login.html");
    }
  } catch (error) {
    formMessage.textContent = error.message;
  }
}

setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  formMessage.textContent = "";

  if (passwordInput.value !== confirmPasswordInput.value) {
    formMessage.textContent = "The passwords do not match.";
    confirmPasswordInput.focus();
    return;
  }

  setupButton.disabled = true;

  try {
    await QueueApi.createInitialAdmin(usernameInput.value.trim(), passwordInput.value);
    window.location.replace("login.html");
  } catch (error) {
    formMessage.textContent = error.message;
  } finally {
    setupButton.disabled = false;
  }
});

checkSetupStatus();
