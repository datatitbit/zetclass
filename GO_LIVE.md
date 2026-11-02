# Zetclass — Go-Live Guide (plain language)

_For putting the subscription version on zetclass.com (Namecheap Stellar Plus, cPanel). Written for someone who does not code._

## 0. What changes when you do this

| | Today | After this guide |
|---|---|---|
| Where a school's data lives | Inside each person's own browser (lost if they clear it, never shared between staff) | In your **MySQL database** on the server, shared by everyone at that school, and backed up |
| How a school joins | You send a link to a demo | The school opens **zetclass.com/signup**, fills a short form, and is in |
| Free trial | A clock in the browser (easy to reset) | Kept on **your server**; only you can change it |
| Who manages subscriptions | Nobody | **You**, at **zetclass.com/admin** |

Nothing is lost by doing this: the demo on Render keeps working as a browser-only demo.

## 1. Before you start — have these ready

- [ ] Your Namecheap login → open **cPanel** (Namecheap → Hosting List → Manage → *Go to cPanel*).
- [ ] The database details from cPanel → **MySQL® Databases**: database name (`zetrekzh_zetclass`), database user, and that user's password. (Forgotten the password? Set a new one on that page — then use the new one below.)
- [ ] A **developer username** and a **long password (12+ characters)** you invent for yourself. This is the key to everything. Use a password manager.
- [ ] The upload package: `dist/zetclass-upload-….zip` in this project folder.

## 2. Make your secret settings file (on your own computer)

Open a terminal in the project folder and run:

```bash
node tools/make-config.js
```

Answer the questions (passwords are hidden as you type). It writes `app/api/config.local.php`.
**Never email it or put it on GitHub** (it is already blocked from GitHub).

## 3. Back up what is on the server now

cPanel → **File Manager** → open the folder of zetclass.com (its *document root*, e.g. `zetclass.com/app`) → select everything → **Compress** → *Zip Archive* → save as `backup-before-subscription.zip`.
Also cPanel → **Backup** → *Download a MySQL Database Backup* → `zetrekzh_zetclass`.

If anything goes wrong, you can put these back (step 9).

## 3b. Show hidden files

File Manager → **Settings** (top right) → tick **Show Hidden Files (dotfiles)** → Save. (The security rules live in files whose names start with a dot, like `.htaccess`.)

## 4. Upload the new version

1. In File Manager, open the document root folder.
2. **Upload** `zetclass-upload-….zip`, then right-click it → **Extract** → into the same folder → *Overwrite* when asked.
3. Delete the zip afterwards.
4. Open the `api` folder → **Upload** your `config.local.php` into it.
5. Right-click `config.local.php` → **Change Permissions** → set to `640` (owner read/write, group read).

## 5. Check it worked (2 minutes)

Visit each address; compare with "Expected":

| Address | Expected |
|---|---|
| `https://zetclass.com/` | Sign-in page (it now says "School address") |
| `https://zetclass.com/signup` | The "Start your free trial" form |
| `https://zetclass.com/api/index.php?r=subscription` | A short message `{"error":"Unauthorized"}` — **not** a web page, **not** a database error |
| `https://zetclass.com/api/seed.json` | "Forbidden" (403) |
| `https://zetclass.com/api/config.local.php` | "Forbidden" (403) |
| `http://zetclass.com` (without the *s*) | Jumps to `https://zetclass.com` |

If the third one shows a database error: re-check the database name/user/password in `config.local.php` (re-run step 2).

## 5b. Make the "Forgot password" emails work (5 minutes)

Zetclass emails a reset link to a school's registered address. For those emails to arrive (and not land in Spam):

1. cPanel → **Email Accounts** → create `no-reply@zetclass.com` (any password; you will never log in to it). This is the "From" address.
2. cPanel → **Email Deliverability** → click *Manage* next to **zetclass.com**. If it shows a problem with **SPF** or **DKIM**, click *Repair* (or *Install the suggested record*). Green ticks = good.
3. The links in the emails are built from `BASE_URL` (default `https://zetclass.com`) and sent from `MAIL_FROM` (default `no-reply@zetclass.com`). If you ever change the domain, add `'BASE_URL' => 'https://your-domain'` and `'MAIL_FROM' => '...'` to `api/config.local.php`.

If emails still do not arrive, nothing is broken: every request also appears in your developer console as a **Password help request** (see "Forgotten passwords" below).

## 5c. Check the PHP version (security)

PHP is the engine that runs Zetclass's server code, and old versions stop getting security fixes. As of 2 Nov 2026 (php.net/supported-versions): **8.2 gets security fixes only until 31 Dec 2026; 8.3 until 31 Dec 2027; 8.4 until 31 Dec 2028; 8.5 until 31 Dec 2029.**

1. cPanel → **Select PHP Version** (or *MultiPHP Manager*) → choose **8.3 or 8.4** for zetclass.com. (Zetclass was tested on 8.2.35; the code uses nothing newer or removed. Re-do step 5 and 7 after switching.)
2. Make sure these extensions are ticked: `pdo_mysql`, `mbstring`, `openssl`.
3. Re-check this page every few months; Namecheap upgrades are one dropdown.

## 6. Sign in as the developer

Go to **`https://zetclass.com/admin`** → enter your developer username and password → you see **Schools**.

## 7. Do one full test with a pretend school

1. Open `zetclass.com/signup` in a private/incognito window. Sign up a school called "Test Academy" with your own email and phone. The phone needs its **country code**: pick it from the list (Ghana +233 is pre-selected) and type the number after it. Leave "Start with sample data" ticked.
2. Back in `/admin` you should see "Test Academy" with a **New** tag, your contact details and "Free trial · 30d left".
3. Click **Manage** → try **+ 1 month** → it should say 60 days left.
4. Click **Record payment** → the school becomes "Active (paid)".
4b. In **Manage → Contact & notes → Edit school details…** change the school's name or phone and save (the web address cannot change).
4c. Sign in as the test school → Dashboard shows "You are looking at sample data". Open **Settings → Sample Data**, tick one group (e.g. *Stock & inventory*), press **Remove selected**, then **Add selected** to bring it back.
5. When happy: **Manage → Delete school permanently…** to remove the test school.

### Also test the password flow (2 minutes)

1. Sign out. On the sign-in page click **Forgot password?** → enter the test school's address and `admin` → *Send me a reset link*.
2. Check the email you signed the test school up with → open the link → choose a new password → sign in with it.
3. In `/admin`, press "Forgot password" again for the test school and watch it appear under **Password help requests**; try **Issue temporary password**.

## Forgotten passwords — who does what

| Who forgot | What they do | If that fails |
|---|---|---|
| **School Administrator** | Sign-in page → **Forgot password?** → emailed link (one use, one hour) | You see their request in `/admin` → **Password help requests**. Confirm it is really them (call/WhatsApp the number shown), click **Issue temporary password**, send it to them. |
| **Teacher, staff, parent** | Ask their school Administrator: *Settings → Access Control → Reset password* | If their Administrator is also locked out, follow the row above for the Administrator first. |
| **Anyone, no request made** | WhatsApp you | `/admin` → **Manage** (their school) → **Login accounts** → **Reset password** → send the one-time password. |

A temporary password works once to sign in; the person must choose their own new password immediately. Every reset signs out any older sessions on that account, and every request and reset is in the **Activity log**.

**Always verify before you reset.** The only protection against someone *pretending* to be a school is you checking: call the phone number you have on file for that school (Manage → Contact), not a number the requester gives you.

## 8. Backups — your routine (important)

Namecheap's Stellar Plus keeps automatic backups, but **do not rely on them alone**:

- **Every week** (put it in your calendar): cPanel → **Backup** → *Download a MySQL Database Backup* → save the file somewhere outside the server (Google Drive).
- Before every update: do step 3 again.
- Check cPanel → **JetBackup** (or *Backup Wizard*) to see what automatic backups exist and how to restore one.

## 9. If something goes wrong (rollback)

1. File Manager → delete the broken files → upload and extract `backup-before-subscription.zip`.
2. Visit the site; hard-refresh (Ctrl+Shift+R).
3. Tell me what you saw (a screenshot of the error helps) and we fix it.

## 10. Before you promote it widely (not done yet)

- [ ] **Terms of Service and Privacy Notice** pages. Schools will enter children's records. Ghana's Data Protection Act expects a privacy notice and registration with the Data Protection Commission. Get these written/reviewed by a lawyer; then link them from the signup page.
- [ ] Put your real **WhatsApp number / email** into `app/index.html` (`window.ZETCLASS_CONTACT`) so schools see how to reach you.
- [ ] Fill in the **payment details** (MoMo/bank) in your WhatsApp messages (`About Product/Zetclass_WhatsApp_How_To_Subscribe.txt`).
- [ ] Email **verification** for new signups (a link to confirm the address is real). Forgotten-password emails already work; signup does not yet check the address.
- [ ] Watch hosting load as schools grow (see "Hosting" below).

## Where things live

- **School data**: the MySQL database `zetrekzh_zetclass` (cPanel → *phpMyAdmin* to look inside, developer only). Every row carries its school's name tag; the server only returns a school its own rows.
- **Your developer login**: only in `api/config.local.php` on the server — not in the database.
- **Subscription status** (trial end, paid-until, plan, contact details, your notes): the `schools` table.
- **Activity log** of everything you do in `/admin`: the `platform_audit` table (visible in `/admin → Activity log`).

## Hosting: is Stellar Plus enough?

Facts from Namecheap's own pages: Stellar Plus = unlimited websites and MySQL databases, automatic backups, **2 GB memory, 30 simultaneous processes and 50% of one CPU for the whole account** (all your sites share this).

- ✅ Fine for launch and the first batch of schools.
- ⚠️ Shared with your other websites: a busy moment on any of them slows the others. A school day-start (many teachers marking attendance at once) is Zetclass's busy moment.
- ⚠️ Same account = same "building": a weakness in an older site (e.g. an un-updated WordPress) could expose Zetclass's secret file. Keep the other sites updated, or move Zetclass to its own account.
- 📈 Plan to move to a **dedicated account or VPS** when you reach roughly 10–15 active schools, or the first time you see "508 Resource Limit" errors. The app moves with a copy of the database and one settings file.
