# Frontdesk

Frontdesk is a small support desk demo built with Node.js, PostgreSQL, and a dependency-light browser UI. It is designed to make the ticket rules visible: separate first-reply and resolution commitments, working-hours clocks, single-agent ownership, customer-only conversation views, and an append-only audit history.

## Run locally

Requirements: Node.js 20 or newer, Docker with Compose, and npm.

1. Copy `.env.example` to `.env`.
2. Start PostgreSQL: `docker compose up -d db`.
3. Install the one runtime dependency: `npm install` (`npm.cmd install` in PowerShell on Windows).
4. Start Frontdesk: `npm start` (`npm.cmd start` in PowerShell on Windows).
5. Open [http://localhost:3000](http://localhost:3000).

The first startup creates the tables, database roles, demo agents, one sample holiday, and four example tickets. Stop PostgreSQL with `docker compose down`; its data stays in the `frontdesk_pgdata` volume. To clear the demo database, run `docker compose down -v`.

If you already have PostgreSQL, set `DATABASE_URL` in `.env` to a database where the migration connection can create tables and roles. Frontdesk migrates its schema on startup, then uses the `frontdesk_runtime` role for application requests. That role can append audit events but cannot update or delete them. The migration owner should not be used by application code outside this demo setup.

The sample `.env` binds only to `127.0.0.1`. A hosting service normally needs `HOST=0.0.0.0`; set that only when deploying behind the host's ingress.

## Run the tests

With PostgreSQL running and `.env` configured, run `npm test` (`npm.cmd test` in Windows PowerShell). The suite creates and removes a randomly named test database on the configured PostgreSQL server. The connection needs permission to create databases and initialize the application schema. Set `TEST_DATABASE_URL` to use a separate PostgreSQL instance. The Frontdesk process can stay running while the suite runs.

| Command | What it checks |
| --- | --- |
| `npm run test:unit` | Working hours in Kolkata, weekends, holidays, opening and closing boundaries, and priority targets. Runs without PostgreSQL. |
| `npm run test:integration` | The HTTP API and PostgreSQL, including concurrent claims, ownership, private notes, pause and resume, priority changes, auto-close, reopening, input validation, and audit ordering and rollback. Also exercises search, filters, and the agent and customer workflows in a simulated browser DOM. |
| `npm test` | Both suites. |

To check the running demo in a real browser, open the inbox and try the [walkthrough](#walkthrough) at desktop and phone widths. Check keyboard navigation, focus, and readability. The DOM tests check interactions and content but cannot measure the layout in a real browser. The suite does not verify a hosted deployment or email delivery.

## Walkthrough

- Switch between **Agent workspace** and **Customer portal preview** in the top bar.
- In **Customer portal preview**, choose **New request** and enter a name, email, subject, and description. Frontdesk opens the conversation right away and puts the ticket in the agent inbox under **Unassigned**, with medium priority.
- The agent selector is a local demo identity switcher; choose an agent, then use the **Unassigned** filter and claim a ticket.
- Open **Customers** in the sidebar to search by name or email and jump from a customer’s ticket history to the inbox. **Reports** shows the current queue and SLA counts. Select a report card to open the matching inbox filter.
- The seeded ticket list includes a missed urgent ticket, a ticket waiting on the customer with a private note, an unassigned urgent ticket, and an assigned ticket.
- Open a ticket to inspect two separate SLA cards and its recent activity. Use the composer tabs to post a customer-visible reply or an internal note.
- Expand **Why is this due then?** on either SLA card to see the working time counted, skipped holidays and weekends, and any changes to the deadline. Older deadlines show a breakdown reconstructed using the current calendar.
- In the customer portal, replies are shown without internal notes or audit data. Reply to the waiting ticket to resume its SLA clocks.
- Try two claims at once from separate browser sessions. The conditional database update allows one winner and returns `409 Conflict` to a losing agent.

## Rules and assumptions

- Business hours are **09:30–18:30, Monday through Friday, Asia/Kolkata**. Weekends and dates in `holidays` do not count.
- The seed calendar includes **23 November 2026** as a clearly labeled demo holiday. Remove or replace that row with the team's actual calendar before using the app beyond the exercise.
- First-reply targets are urgent **2 working hours**, medium **4.5 working hours**, and low **9 working hours**. Resolution targets are urgent **by the end of the effective working day**, medium **27 working hours**, and low **45 working hours**. An urgent ticket created outside business hours starts on the next working day; an urgent priority change uses the end of the current effective working day.
- Waiting on the customer pauses pending SLA clocks. A customer's reply resumes each clock with its remaining work-time budget. A reply processed under the ticket lock before the five-working-day inactivity cutoff resumes the ticket. At or after the cutoff, it closes.
- A resolved ticket can be reopened for **seven calendar days**. Reopening starts a new resolution SLA cycle from that point; earlier resolution times and breach results remain in `ticket_resolutions` and the audit trail. The first-response commitment remains the original ticket's commitment.
- Priority changes recalculate targets from working time already consumed, excluding customer waiting. An urgent upgrade caps the remaining resolution budget at the close of the effective working day. If the ticket is waiting, that remaining budget stays frozen until the customer replies. A tighter target can make a ticket overdue immediately. Previously missed deadlines stay marked as missed.
- The demo records an agent reply as **posted inside Frontdesk**. It does not send email or claim external delivery confirmation.
- Local development on loopback uses a demo identity picker. The hosted demo requires the reviewer password for agent access. Anonymous customers can see and reply to tickets created in their own browser session. Signed-in reviewers can use the customer preview to inspect the seeded conversations.

## Main routes

- `GET /api/tickets` and `GET /api/tickets/:id` — agent inbox and full ticket history.
- `POST /api/tickets/:id/claim` — atomic ticket claim.
- `POST /api/tickets/:id/messages` — customer-visible reply or private note.
- `POST /api/tickets/:id/status` — move to waiting, resolve, or reopen.
- `POST /api/tickets/:id/priority` — change priority and recalculate SLA targets.
- `GET /api/customer/tickets` and `GET /api/customer/tickets/:id` — customer-safe summaries and public messages only.
- `POST /api/customer/tickets` — submit a support request and start both SLA clocks.
- `POST /api/customer/tickets/:id` — customer reply, resume SLA, or reopen within the allowed window.
- `GET /api/health` — process health.

## Deploy on Vercel

1. Import this repository as a Vercel project. Keep the framework preset on **Other**. The checked-in `vercel.json` serves the frontend and routes API requests to the Node function.
2. Connect a fresh PostgreSQL database to production. Provide a direct PostgreSQL connection as `DATABASE_URL_UNPOOLED`, `POSTGRES_URL_NON_POOLING`, or `DATABASE_URL`. On first boot the app creates its schema and roles and seeds fictional tickets.
3. Add the production environment variables `FRONTDESK_AGENT_PASSWORD` (at least 16 characters), `FRONTDESK_SESSION_SECRET` (at least 32 characters), and `CRON_SECRET` (an independent random value) in Vercel.
4. Deploy to production and check `/api/health`. Sign in as a demo agent with the reviewer password. In a private browser window, check that agent data requires sign-in and that guests only see requests they submit from that browser.

Vercel runs a daily auto-close job. Opening the inbox or customer portal also checks for expired tickets. Customer replies enforce the cutoff directly. Keep the project and database active for the review week and share the reviewer password privately.

See the [submission note](SUBMISSION.md) for remaining limits.
