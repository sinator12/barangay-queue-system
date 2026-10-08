// Browser client for the protected server API.
// Queue records, users, and passwords are never stored in browser storage.
const QueueApi = (() => {
  async function request(path, options = {}) {
    let response;

    try {
      response = await fetch(path, {
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...options.headers
        },
        ...options
      });
    } catch {
      if (window.location.protocol === "file:") {
        throw new Error("This page was opened directly as a file. Double-click start-queue-system.cmd, then open http://127.0.0.1:3000/login.html.");
      }

      throw new Error(`Can't reach the queue server at ${window.location.origin}. Make sure its server window is still open, then reload this page.`);
    }

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(payload.error || "The server could not complete that request.");
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  return {
    getSetupStatus: () => request("/api/setup/status"),
    createInitialAdmin: (username, password) => request("/api/setup/initial-admin", {
      method: "POST",
      body: JSON.stringify({ username, password })
    }),
    getCurrentUser: () => request("/api/auth/me"),
    login: (username, password, mfaCode) => request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password, mfaCode })
    }),
    enrollAdminMfa: (username, password, code) => request("/api/auth/mfa/enroll", {
      method: "POST",
      body: JSON.stringify({ username, password, code })
    }),
    logout: () => request("/api/auth/logout", { method: "POST" }),
    createQueueItem: (serviceCode) => request("/api/queues", {
      method: "POST",
      body: JSON.stringify({ serviceCode })
    }),
    getPublicQueue: () => request("/api/public/queue"),
    getQueues: () => request("/api/queues"),
    callNextQueue: () => request("/api/queues/call-next", { method: "POST" }),
    updateQueueStatus: (queueId, status) => request(`/api/queues/${queueId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status })
    }),
    getReports: () => request("/api/reports"),
    getBackupStatus: () => request("/api/backups"),
    createBackup: () => request("/api/backups/run", { method: "POST" }),
    getUsers: () => request("/api/users"),
    createUser: (username, password, role) => request("/api/users", {
      method: "POST",
      body: JSON.stringify({ username, password, role })
    }),
    kickUser: (userId) => request(`/api/users/${userId}/kick`, { method: "POST" }),
    removeStaffAccount: (userId) => request(`/api/users/${userId}`, { method: "DELETE" }),
    clearCompletedHistory: () => request("/api/history/completed", { method: "DELETE" })
  };
})();
