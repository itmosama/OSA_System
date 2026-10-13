# OSA — Operations Service Assistance

*Behind every smooth operation.*

A simple, self-hosted ticketing system for a hotel IT department. Staff from any
department can submit tickets (with room number, request type, priority); IT agents
manage and resolve them. Admins manage departments, request types, rooms, and user
accounts from a dashboard. Also includes a Lost & Found tracker.

## Stack

- Node.js + Express (server-rendered pages with EJS + Bootstrap 5)
- SQLite via Node's built-in `node:sqlite` module — no native build tools required
- Session-based login (bcrypt-hashed passwords)

Runs as a single process — ideal for a PC or small server on the hotel's local network.

## Requirements

- Node.js **v22.5+** (built-in SQLite support). Check with `node -v`.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` if you want to change the port, session secret, or the default admin
account created on first run.

```bash
npm start
```

Then open `http://localhost:3000` (or `http://<this-pc's-LAN-IP>:3000` from other
devices on the network).

**First login:** the username/password from `.env` (`admin` / `ChangeMe123!` by
default). Sign in as admin and change your password via **Admin → Users → key icon**
right away.

## Roles

- **Admin** — full access: manage departments, request types, rooms, users; manage all tickets.
- **Agent** (IT technician) — sees and manages all tickets, can update status/priority/assignment.
- **Requester** (staff in any other department) — can submit tickets and see/comment on only their own tickets.

## Day-to-day admin tasks

All under **Admin** in the nav bar (visible to admins only):

- **Users** — create a login for someone in another department (name, username,
  temporary password, role, department). Reset passwords or disable accounts here too.
- **Departments** — add/remove hotel departments (Front Office, Housekeeping, etc.).
- **Request Types** — add/remove the categories staff pick when opening a ticket
  (Hardware Issue, Network/Wi-Fi, POS/PMS Issue, etc.), each with a default priority.
- **Rooms** — add rooms one at a time, or bulk-add a numeric range (e.g. 101–150) in
  one go, useful for setting up a whole floor at once.

## Running it long-term on a hotel PC

- Use a process manager so it restarts on reboot/crash, e.g. [PM2](https://pm2.keymetrics.io/):
  ```bash
  npm install -g pm2
  pm2 start src/app.js --name it-helpdesk
  pm2 save
  pm2 startup
  ```
- The SQLite database lives in `data/ticketing.db` — back this file up periodically.
- To let other devices on the hotel Wi-Fi/LAN reach it, make sure the chosen `PORT`
  is allowed through Windows Firewall, and share `http://<this-pc's-LAN-IP>:PORT`.
