# Barangay Queue System — Local and Barangay Network Version

## Start the system

1. Double-click `start-queue-system.cmd`. It starts the local server without requiring `npm start` and opens the staff sign-in page.
2. Keep the **Barangay Queue System Server** window open while the system is in use.
3. If this is the first run, open `http://127.0.0.1:3000/setup.html` on the server computer to create the first Administrator account. Setup disables itself as soon as that account exists.
4. Open `http://127.0.0.1:3000/index.html` for the resident kiosk or `http://127.0.0.1:3000/display.html` for the public queue display.
5. On each Administrator's first sign-in, set up an authenticator app and save the one-time recovery codes. This first enrollment must be done on the server computer. Staff accounts continue to sign in with their password.

The launcher requires Node.js 24 or newer. You can also start the server manually with `npm start`.
After updating the application, stop the old server window and start it again so the new code and database migrations load.

## Stop it or switch access modes

- To stop the server, focus the **Barangay Queue System Server** window and press **Ctrl+C**, or close that server window. Closing the browser tab alone does not stop it.
- To use only this computer, stop the current server and double-click `start-queue-system.cmd`. It binds to `127.0.0.1`, so other devices cannot connect.
- To let devices on the Barangay's private network connect, stop the current server and double-click `start-phone-server.cmd`. It starts the LAN version and displays the address to use. Do not run both launchers at once; they use the same port.
- To opt into automatic startup after signing in to Windows, double-click `install-autostart.cmd`. This registers a current-user Task Scheduler task for LAN use, restarts it after failures, and keeps Windows awake while the server is running. It is not installed automatically. To remove it and stop its server process, double-click `uninstall-autostart.cmd`.
- To check whether the local server is responding, run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\check-server.ps1`. The health endpoint is `http://127.0.0.1:3000/api/health`.

For LAN use, the server computer and client devices must be on the same trusted Barangay Wi-Fi/Ethernet network. On each device, use the address printed by the launcher, with the relevant page at the end:

- Staff sign-in: `http://<server-ip>:3000/login.html`
- Resident kiosk: `http://<server-ip>:3000/index.html`
- Public queue display: `http://<server-ip>:3000/display.html`

If Windows asks about Node.js in the firewall, allow **Private networks only**. Do not enable Public networks. Ask the Barangay network administrator to reserve a stable local IP address for the server computer. Guest Wi-Fi, client isolation, or separate VLANs may prevent phones from reaching it. If the displayed address changes, use the new address from the launcher.

## Administrator sign-in protection

- Administrators must use a time-based one-time password (TOTP) from an authenticator app in addition to their password. When first asked, add an account in the app using the setup key shown on the server computer, then enter its current six-digit code.
- Save the ten recovery codes when shown. Each works once if the authenticator is unavailable. The system stores only hashes of recovery codes; it cannot show them again.
- Five failed password or authenticator attempts for the same username and device address trigger a 15-minute lockout. Lockout records are stored in the database and persist across server restarts.
- A new Administrator must enroll MFA during their first sign-in from the server computer before signing in on another device. If an Administrator loses their authenticator, use one saved recovery code.

## Automatic database backups and restore

- While the server runs, it checks hourly and makes a SQLite-consistent snapshot if there is no valid backup from the last 24 hours. It also catches up after a shutdown. Each new backup is checked with SQLite `integrity_check` before being kept. Administrators can see the latest backup status on the Settings page and select **Create Backup Now**.
- Backups are saved to the folder in `backup-settings.json` (default `data/backups`). Old daily backups are removed after `retentionDays` (default 30). Review this setting before using real Barangay data; a backup on the same disk cannot protect against that disk failing.
- For better recovery, set `directory` in `backup-settings.json` to an access-controlled external drive or Barangay-managed backup share. The account running the server must be allowed to write there. Do not put the live database itself on a shared drive.
- Make an extra backup at any time with `npm run backup` or `node .\backup.js --now`.
- To restore, stop the queue server (if autostart is installed, run `uninstall-autostart.ps1` first), then run `node .\backup.js --restore <backup-file.db>` in PowerShell from this folder. Choose a `.db` file directly inside the configured backup folder and type `RESTORE` when asked. The selected file is checked first, and a verified safety backup of the current database is made before replacement. Restart the server afterward; reinstall autostart if you removed it. Never restore while the server is running.

## Optional Windows autostart and recovery

`install-autostart.ps1` creates a Task Scheduler task for the signed-in Windows account. The task starts the LAN server after that account signs in, checks `/api/health` every 20 seconds, and asks Task Scheduler to retry up to five times if the server exits or becomes unhealthy. It keeps the computer from sleeping while active. It does not run until a user signs in, and the computer must stay powered on and connected to the Barangay network. Server output is saved under `logs/`.

Run `uninstall-autostart.ps1` to remove the task and stop its server process. Existing database and backups are kept. You can also run `check-server.ps1` to manually verify the server health.

## Barangay handover checklist

1. Use a Barangay-owned, always-on Windows computer connected to the trusted Barangay network. Install Node.js 24 or newer and copy the application folder onto that computer.
2. Decide whether test accounts and queue records should be kept. For a clean handover, make a separate copy of the application folder and leave its `data/` folder out; the Barangay can create its own first Administrator at `http://127.0.0.1:3000/setup.html`. Keep the original testing folder untouched. If authorized records must be moved instead, stop the server first and securely copy the entire `data/` folder, including SQLite sidecar files if present.
3. On the server computer, create the first Administrator, set up its authenticator, and save its recovery codes. Create a separate account for each staff member; do not share logins.
4. Start the LAN version with `start-phone-server.cmd`, or opt into the Windows autostart task. Give staff and residents the correct page address printed by the launcher.
5. Test from a second device on the Barangay network: create a queue ticket, call it from an Administrator/Staff account, and confirm the public display updates.
6. Configure protected backup storage and make a test restore into a separate test copy before relying on the system for real service.

## Network and security limits

- The LAN launcher is for the same trusted private network, not for access from any internet connection. Do not configure router port forwarding or expose port 3000 to the public internet.
- This prototype serves HTTP, not HTTPS. Passwords, authenticator codes, and session traffic are not encrypted in transit. Use it only on a trusted, access-controlled Barangay network for testing; before real sensitive use, have the Barangay IT/network administrator set up HTTPS or a private VPN and review the deployment security.
- Protect the database and backups with Barangay-controlled Windows permissions and device encryption. The `data/` folder contains private system data and is not served by the website.

## Account roles and existing protections

- **Administrator:** manages queue operations, views reports, creates Staff/Administrator accounts, and performs account/history administration. Administrators require authenticator MFA.
- **Staff:** calls the next number and updates queue status. Staff cannot view reports, settings, or manage user accounts.
- Passwords are stored as salted hashes. Staff sign-in uses an `HttpOnly` session cookie, not browser storage.
- Queue changes and account changes are recorded in an audit log.
- The normal launcher listens only on this computer (`127.0.0.1`). The phone launcher permits access only on the same private network. Do not expose this prototype to the public internet; a real deployment still needs HTTPS, operating-system access controls, and review by Barangay IT.

## Automated checks

Run `npm test` after code changes. These checks exercise Administrator MFA and recovery codes, Staff permissions, queue numbering/status transitions, persistent login throttling across a server restart, and backup/restore safety using temporary databases. They do not modify the live `data/` database.
