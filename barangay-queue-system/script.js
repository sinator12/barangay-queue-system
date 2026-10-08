const serviceButtons = document.querySelectorAll(".service-button");
const ticket = document.querySelector("#ticket");
const queueNumber = document.querySelector("#queue-number");
const queueService = document.querySelector("#queue-service");
const queueMessage = document.querySelector("#queue-message");
const serviceConfirmation = document.querySelector("#service-confirmation");
const selectedServiceName = document.querySelector("#selected-service-name");
const cancelServiceButton = document.querySelector("#cancel-service");
const confirmServiceButton = document.querySelector("#confirm-service");

let selectedService = null;

function openServiceConfirmation(event) {
  const button = event.currentTarget;
  selectedService = {
    prefix: button.dataset.prefix,
    service: button.dataset.service
  };
  selectedServiceName.textContent = selectedService.service;
  serviceConfirmation.hidden = false;
  confirmServiceButton.focus();
}

function closeServiceConfirmation() {
  serviceConfirmation.hidden = true;
  selectedService = null;
}

async function issueQueueNumber() {
  if (!selectedService) {
    return;
  }

  const serviceToIssue = selectedService;
  serviceConfirmation.hidden = true;

  serviceButtons.forEach((serviceButton) => {
    serviceButton.disabled = true;
  });

  try {
    const { queueItem, automaticallyCalled } = await QueueApi.createQueueItem(serviceToIssue.prefix);
    queueNumber.textContent = queueItem.number;
    queueService.textContent = queueItem.service;
    queueMessage.textContent = automaticallyCalled
      ? "You are now being served. Please proceed to the counter."
      : "Please wait for your number to be called.";
    ticket.hidden = false;
    ticket.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    queueNumber.textContent = "—";
    queueService.textContent = "Ticket could not be issued";
    queueMessage.textContent = error.message;
    ticket.hidden = false;
  } finally {
    selectedService = null;
    serviceButtons.forEach((serviceButton) => {
      serviceButton.disabled = false;
    });
  }
}

serviceButtons.forEach((button) => {
  button.addEventListener("click", openServiceConfirmation);
});

cancelServiceButton.addEventListener("click", closeServiceConfirmation);
confirmServiceButton.addEventListener("click", issueQueueNumber);

serviceConfirmation.addEventListener("click", (event) => {
  if (event.target === serviceConfirmation) {
    closeServiceConfirmation();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !serviceConfirmation.hidden) {
    closeServiceConfirmation();
  }
});
