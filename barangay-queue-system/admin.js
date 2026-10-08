const currentDate = document.querySelector("#current-date");
const navigationItems = document.querySelectorAll(".nav-item");
const pageViews = document.querySelectorAll(".page-view");
const adminOnlyElements = document.querySelectorAll("[data-admin-only]");
const profileName = document.querySelector("#profile-name");
const profileRole = document.querySelector("#profile-role");
const logoutButton = document.querySelector("#logout-button");
const totalTransactions = document.querySelector("#total-transactions");
const currentlyServing = document.querySelector("#currently-serving");
const inQueue = document.querySelector("#in-queue");
const queueTableBody = document.querySelector("#queue-table-body");
const queueManagementTableBody = document.querySelector("#queue-management-table-body");
const transactionsTableBody = document.querySelector("#transactions-table-body");
const clearHistoryButton = document.querySelector("#clear-history-button");
const callNextButton = document.querySelector("#call-next-button");
const updateStatusButton = document.querySelector("#update-status-button");
const viewReportsButton = document.querySelector("#view-reports-button");
const statusEditor = document.querySelector("#status-editor");
const selectedQueueNumber = document.querySelector("#selected-queue-number");
const statusSelect = document.querySelector("#status-select");
const saveStatusButton = document.querySelector("#save-status-button");
const reportTotal = document.querySelector("#report-total");
const reportWaiting = document.querySelector("#report-waiting");
const reportCompleted = document.querySelector("#report-completed");
const serviceReportList = document.querySelector("#service-report-list");
const createUserForm = document.querySelector("#create-user-form");
const newUsername = document.querySelector("#new-username");
const newPassword = document.querySelector("#new-password");
const newRole = document.querySelector("#new-role");
const createUserButton = document.querySelector("#create-user-button");
const userFormMessage = document.querySelector("#user-form-message");
const userList = document.querySelector("#user-list");
const backupStatus = document.querySelector("#backup-status");
const backupMessage = document.querySelector("#backup-message");
const backupNowButton = document.querySelector("#backup-now-button");
const toast = document.querySelector("#toast");

let currentUser = null;
let queueItems = [];
let selectedQueueId = null;
let toastTimeout;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("toast--visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("toast--visible"), 3200);
}

function updateDate() {
  currentDate.textContent = new Date().toLocaleDateString("en-PH", {
    month: "long",
    day: "numeric",
    year: "numeric"
  });
}

function formatTime(isoDate) {
  return new Intl.DateTimeFormat("en-PH", { hour: "numeric", minute: "2-digit" }).format(new Date(isoDate));
}

function getStatusClass(status) {
  return `status--${status.toLowerCase()}`;
}

function getDisplayOrder(firstQueue, secondQueue) {
  const statusOrder = { Serving: 0, Waiting: 1, Completed: 2 };
  const statusDifference = statusOrder[firstQueue.status] - statusOrder[secondQueue.status];
  return statusDifference || new Date(firstQueue.createdAt) - new Date(secondQueue.createdAt);
}

function createCell(content, isStrong = false) {
  const cell = document.createElement("td");
  const element = isStrong ? document.createElement("strong") : document.createElement("span");
  element.textContent = content;
  cell.append(element);
  return cell;
}

function selectQueue(queueItem) {
  selectedQueueId = queueItem.id;
  selectedQueueNumber.textContent = queueItem.number;
  statusSelect.value = queueItem.status;
  renderQueueViews();
}

function createQueueRow(queueItem) {
  const row = document.createElement("tr");
  row.tabIndex = 0;
  row.setAttribute("aria-label", `Select ${queueItem.number}, ${queueItem.service}`);

  if (queueItem.id === selectedQueueId) {
    row.classList.add("row--selected");
    row.setAttribute("aria-selected", "true");
  }

  const statusCell = document.createElement("td");
  const status = document.createElement("span");
  status.className = `status ${getStatusClass(queueItem.status)}`;
  status.textContent = queueItem.status;
  statusCell.append(status);
  row.append(createCell(queueItem.number, true), createCell(queueItem.service), statusCell, createCell(formatTime(queueItem.createdAt)));

  row.addEventListener("click", () => {
    selectQueue(queueItem);
    showToast(`${queueItem.number} selected.`);
  });

  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectQueue(queueItem);
      showToast(`${queueItem.number} selected.`);
    }
  });

  return row;
}

function renderQueueTable(tableBody, items, emptyMessage) {
  tableBody.replaceChildren();

  if (items.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.textContent = emptyMessage;
    row.classList.add("empty-state");
    row.append(cell);
    tableBody.append(row);
    return;
  }

  items.forEach((queueItem) => tableBody.append(createQueueRow(queueItem)));
}

function renderQueueViews(stats) {
  const orderedItems = [...queueItems].sort(getDisplayOrder);
  const selectedQueue = orderedItems.find((queueItem) => queueItem.id === selectedQueueId);

  if (!selectedQueue) {
    selectedQueueId = null;
    selectedQueueNumber.textContent = "None";
    statusEditor.hidden = true;
  }

  totalTransactions.textContent = stats.total;
  currentlyServing.textContent = stats.serving || "—";
  inQueue.textContent = stats.waiting;
  renderQueueTable(queueTableBody, orderedItems, "No queue tickets yet. Issue a ticket from the resident kiosk.");
  renderQueueTable(queueManagementTableBody, orderedItems, "No queue tickets are available yet.");
  renderQueueTable(
    transactionsTableBody,
    orderedItems.filter((queueItem) => queueItem.status === "Completed"),
    "No completed transactions yet."
  );
}

function renderReports(report) {
  reportTotal.textContent = report.stats.total;
  reportWaiting.textContent = report.stats.waiting;
  reportCompleted.textContent = report.stats.completed;
  serviceReportList.replaceChildren();

  const services = Object.entries(report.serviceBreakdown);

  if (services.length === 0) {
    const emptyMessage = document.createElement("p");
    emptyMessage.className = "service-report-empty";
    emptyMessage.textContent = "No ticket data is available yet.";
    serviceReportList.append(emptyMessage);
    return;
  }

  services.forEach(([service, count]) => {
    const item = document.createElement("div");
    const name = document.createElement("span");
    const total = document.createElement("strong");
    item.className = "service-report-item";
    name.textContent = service;
    total.textContent = count;
    item.append(name, total);
    serviceReportList.append(item);
  });
}

function renderUsers(users) {
  userList.replaceChildren();

  users.forEach((user) => {
    const item = document.createElement("div");
    const account = document.createElement("div");
    const username = document.createElement("strong");
    const role = document.createElement("span");
    item.className = "user-list-item";
    username.textContent = user.username;
    role.textContent = user.role;
    account.append(username, role);
    item.append(account);

    if (user.id !== currentUser.id && user.role === "staff") {
      const actions = document.createElement("div");
      const kickButton = document.createElement("button");
      const removeButton = document.createElement("button");
      actions.className = "user-list-actions";
      kickButton.className = "user-action-button";
      kickButton.type = "button";
      kickButton.textContent = "Kick Out";
      kickButton.addEventListener("click", () => kickUserAccount(user));
      removeButton.className = "user-action-button user-action-button--remove";
      removeButton.type = "button";
      removeButton.textContent = "Remove";
      removeButton.addEventListener("click", () => removeStaffAccount(user));
      actions.append(kickButton, removeButton);
      item.append(actions);
    }

    userList.append(item);
  });
}

async function kickUserAccount(user) {
  const shouldKick = window.confirm(`Sign out ${user.username} from all devices now? Their account will remain available.`);

  if (!shouldKick) {
    return;
  }

  try {
    await QueueApi.kickUser(user.id);
    showToast(`${user.username} has been signed out.`);
    await refreshAdminData();
  } catch (error) {
    handleApiError(error);
  }
}

async function removeStaffAccount(user) {
  const shouldRemove = window.confirm(
    `Permanently remove the staff account for ${user.username}? This cannot be undone, and they will be signed out immediately.`
  );

  if (!shouldRemove) {
    return;
  }

  try {
    await QueueApi.removeStaffAccount(user.id);
    showToast(`${user.username}'s staff account was removed.`);
    await refreshAdminData();
  } catch (error) {
    handleApiError(error);
  }
}

async function refreshQueueData() {
  try {
    const response = await QueueApi.getQueues();
    queueItems = response.items;
    renderQueueViews(response.stats);
  } catch (error) {
    handleApiError(error);
  }
}

async function refreshAdminData() {
  if (currentUser?.role !== "admin") {
    return;
  }

  try {
    const [report, users] = await Promise.all([QueueApi.getReports(), QueueApi.getUsers()]);
    renderReports(report);
    renderUsers(users.users);
    await refreshBackupStatus();
  } catch (error) {
    handleApiError(error);
  }
}

async function refreshBackupStatus() {
  if (!backupStatus || currentUser?.role !== "admin") return;

  try {
    const status = await QueueApi.getBackupStatus();
    const latestStatus = !status.latest
      ? "No database backup has been created yet."
      : `${status.latest.valid ? "Latest verified backup" : "Latest backup failed integrity check"}: ${formatTime(status.latest.createdAt)} on ${new Date(status.latest.createdAt).toLocaleDateString()}.`;
    backupStatus.textContent = `${latestStatus} ${status.backupCount} backup(s) stored; retention is ${status.retentionDays} days. Folder: ${status.directory}`;
  } catch (error) {
    backupStatus.textContent = error.message;
  }
}

function showView(viewName) {
  if (currentUser?.role !== "admin" && ["reports", "settings"].includes(viewName)) {
    showToast("Only Administrators can access this area.");
    return;
  }

  pageViews.forEach((view) => {
    view.hidden = view.dataset.view !== viewName;
  });
  navigationItems.forEach((item) => item.classList.toggle("nav-item--active", item.dataset.view === viewName));

  if (viewName === "reports" || viewName === "settings") {
    refreshAdminData();
  }
}

function handleApiError(error) {
  if (error.status === 401) {
    window.location.replace("login.html");
    return;
  }

  showToast(error.message);
}

async function loadDashboard() {
  try {
    const response = await QueueApi.getCurrentUser();
    currentUser = response.user;
  } catch (error) {
    if (error.status === 401) {
      window.location.replace("login.html");
      return;
    }

    showToast(error.message);
    return;
  }

  profileName.textContent = currentUser.username;
  profileRole.textContent = currentUser.role;
  adminOnlyElements.forEach((element) => {
    element.hidden = currentUser.role !== "admin";
  });

  updateDate();
  await refreshQueueData();
  await refreshAdminData();
}

navigationItems.forEach((item) => item.addEventListener("click", () => showView(item.dataset.view)));

callNextButton.addEventListener("click", async () => {
  callNextButton.disabled = true;

  try {
    const { queueItem } = await QueueApi.callNextQueue();
    showToast(queueItem ? `${queueItem.number} is now serving.` : "There are no waiting queue tickets to call.");
    selectedQueueId = queueItem?.id || null;
    statusEditor.hidden = true;
    await refreshQueueData();
    await refreshAdminData();
  } catch (error) {
    handleApiError(error);
  } finally {
    callNextButton.disabled = false;
  }
});

updateStatusButton.addEventListener("click", () => {
  const selectedQueue = queueItems.find((queueItem) => queueItem.id === selectedQueueId);

  if (!selectedQueue) {
    showToast("Select a queue ticket from Queue Management or the Dashboard table first.");
    return;
  }

  statusSelect.value = selectedQueue.status;
  selectedQueueNumber.textContent = selectedQueue.number;
  statusEditor.hidden = !statusEditor.hidden;
});

saveStatusButton.addEventListener("click", async () => {
  if (!selectedQueueId) {
    showToast("Select a queue ticket from the table first.");
    return;
  }

  saveStatusButton.disabled = true;

  try {
    const { queueItem } = await QueueApi.updateQueueStatus(selectedQueueId, statusSelect.value);
    statusEditor.hidden = true;
    showToast(`${queueItem.number} is now ${queueItem.status.toLowerCase()}.`);
    await refreshQueueData();
    await refreshAdminData();
  } catch (error) {
    handleApiError(error);
  } finally {
    saveStatusButton.disabled = false;
  }
});

viewReportsButton.addEventListener("click", () => showView("reports"));

backupNowButton.addEventListener("click", async () => {
  backupNowButton.disabled = true;
  backupMessage.textContent = "Creating and checking a database backup…";

  try {
    const result = await QueueApi.createBackup();
    backupMessage.textContent = result.latest?.valid
      ? "Backup created and passed the integrity check."
      : "Backup request completed, but the new copy needs attention.";
    showToast("Database backup created and checked.");
    await refreshBackupStatus();
  } catch (error) {
    backupMessage.textContent = error.message;
  } finally {
    backupNowButton.disabled = false;
  }
});

clearHistoryButton.addEventListener("click", async () => {
  const shouldClear = window.confirm(
    "Clear all completed queue transactions? Active waiting and serving tickets will remain. This action cannot be undone."
  );

  if (!shouldClear) {
    return;
  }

  clearHistoryButton.disabled = true;

  try {
    const { removedCount } = await QueueApi.clearCompletedHistory();
    showToast(`${removedCount} completed transaction(s) cleared.`);
    await refreshQueueData();
    await refreshAdminData();
  } catch (error) {
    handleApiError(error);
  } finally {
    clearHistoryButton.disabled = false;
  }
});

createUserForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  userFormMessage.textContent = "";
  createUserButton.disabled = true;

  try {
    const { user } = await QueueApi.createUser(newUsername.value.trim(), newPassword.value, newRole.value);
    createUserForm.reset();
    showToast(`${user.username} was added as ${user.role}.`);
    await refreshAdminData();
  } catch (error) {
    if (error.status === 401) {
      handleApiError(error);
    } else {
      userFormMessage.textContent = error.message;
    }
  } finally {
    createUserButton.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;

  try {
    await QueueApi.logout();
  } catch {
    // The redirect still clears the protected staff view if the session has expired.
  }

  window.location.replace("login.html");
});

window.addEventListener("focus", () => {
  refreshQueueData();
  refreshAdminData();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshQueueData();
  }
});

setInterval(() => {
  if (!document.hidden) {
    refreshQueueData();
  }
}, 5000);

loadDashboard();
