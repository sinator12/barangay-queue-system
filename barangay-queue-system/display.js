const servingNumber = document.querySelector("#serving-number");
const servingService = document.querySelector("#serving-service");
const nextList = document.querySelector("#next-list");
const refreshNote = document.querySelector("#refresh-note");

function renderNextQueues(nextQueues) {
  nextList.replaceChildren();

  if (nextQueues.length === 0) {
    const emptyMessage = document.createElement("p");
    emptyMessage.className = "empty-message";
    emptyMessage.textContent = "No waiting tickets.";
    nextList.append(emptyMessage);
    return;
  }

  nextQueues.slice(0, 3).forEach((queueItem) => {
    const ticket = document.createElement("article");
    const number = document.createElement("strong");
    const service = document.createElement("span");
    ticket.className = "next-ticket";
    number.textContent = queueItem.number;
    service.textContent = queueItem.service;
    ticket.append(number, service);
    nextList.append(ticket);
  });
}

async function refreshPublicQueue() {
  try {
    const queue = await QueueApi.getPublicQueue();
    servingNumber.textContent = queue.serving?.number || "—";
    servingService.textContent = queue.serving?.service || "Waiting for the next ticket";
    renderNextQueues(queue.next);
    refreshNote.textContent = "Live updates";
  } catch {
    refreshNote.textContent = "Reconnecting…";
  }
}

refreshPublicQueue();
setInterval(refreshPublicQueue, 3000);
