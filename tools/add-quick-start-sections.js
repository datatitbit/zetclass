/* Adds the "Quick start for your user type" section to User Guide 1 (Everyday Sign-In).
 * Safe to run again: it does nothing if the section is already there.
 * Run from the zetclass folder:  node tools/add-quick-start-sections.js
 * Then:  node tools/add-section-glossaries.js   and rebuild the PDFs. */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'User Guide', '01 Everyday Sign-In (All Users).html');
let s = fs.readFileSync(file, 'utf8');
if (s.indexOf('<h2>Quick start for your user type</h2>') !== -1) { console.log('Quick start section already there. Nothing changed.'); process.exit(0); }

const section = `
<h2>Quick start for your user type</h2>
<p>Find your user type below. Each part is short: what you will see, and the first things to do. Your Admin decides exactly which sections appear for you, so your menu may show a little more or less than described here.</p>
<div class="toc"><ul>
<li><a href="#qs-teaching">Teaching staff</a> (class teachers and subject teachers)</li>
<li><a href="#qs-nonteaching">Non-teaching staff</a> (accountant, secretary, school manager and others)</li>
<li><a href="#qs-director">Director</a></li>
<li><a href="#qs-admin">Admin</a></li>
<li><a href="#qs-parent">Parent / guardian</a></li>
</ul></div>

<h3 id="qs-teaching">Teaching staff</h3>
<p><b>Your job in Zetclass:</b> enter your pupils’ scores and take the daily register for the classes you teach.</p>
<ol class="steps">
<li>Sign in. Choose <b>Teaching staff</b> as your user type. Your Admin gave you your username.</li>
<li>Open <b>Assessment</b>. Pick your <b>Class</b> and your <b>Subject</b> at the top. A class teacher sees every subject for the class. A subject teacher sees only the subjects given to them.</li>
<li>Type each pupil’s <b>class score</b> and <b>exam score</b>, then tap <span class="btn gold">Save scores</span>. The page shows what each score is out of. The two scores are added to give a total out of 100.</li>
<li>Open <b>Attendance</b>. On the <i>Student Attendance</i> tab mark who is present or absent, then tap <span class="btn gold">Save attendance</span>. Use the <i>Conduct Notes</i> tab to write a short note about a pupil’s behaviour.</li>
<li>Open <b>Students</b> to look up a pupil’s details.</li>
</ol>
<div class="box tip"><span class="label">Good to know</span><ul><li>If Assessment says <i>You have no assigned classes</i>, ask your Admin to link your classes or subjects to your staff record.</li><li>Poor network in class? Carry on. What you enter is saved on your device and sent when the network is back.</li></ul></div>

<h3 id="qs-nonteaching">Non-teaching staff</h3>
<p><b>Your job in Zetclass:</b> the school office work: fees and payments, stock, money records, staff pay, messages and pupil records.</p>
<ol class="steps">
<li>Sign in. Choose <b>Non-teaching staff</b> as your user type.</li>
<li>Look at the menu. You will see the sections your Admin turned on for you. These usually include <b>Finance</b> (fees and payments), <b>Inventory</b> (stock), <b>Accounting</b>, <b>Payroll</b>, <b>Communication</b> (messages), <b>Administration</b> and <b>Students</b>.</li>
<li>Start with the section that is your daily work. For example, an accountant begins in <b>Finance</b>, and a store keeper begins in <b>Inventory</b>.</li>
<li>Check the figure before you save. Receipts and totals are used by the school and by parents.</li>
</ol>
<div class="box tip"><span class="label">Good to know</span><ul><li>You cannot open <b>Settings</b> or change login accounts. Only the Admin can.</li><li>Fees, payments and stock entries are saved even when the network is off, and sent later.</li></ul></div>

<h3 id="qs-director">Director</h3>
<p><b>Your job in Zetclass:</b> to see how the school is doing. You can look and download. You cannot change records.</p>
<ol class="steps">
<li>Sign in. Choose <b>Director</b> as your user type.</li>
<li>The <b>Dashboard</b> opens first. It is a summary of pupils, attendance, fees and money.</li>
<li>Open any other section (Students, Assessment, Finance, Attendance and so on) to look deeper. Use the download buttons you find there to keep a copy.</li>
</ol>
<div class="box tip"><span class="label">Good to know</span><ul><li>Everything is <b>view only</b>. If you want something changed, ask the Admin to change it.</li><li>The Settings page is not shown to the Director.</li></ul></div>

<h3 id="qs-admin">Admin</h3>
<p><b>Your job in Zetclass:</b> you run the school’s account. Only you can add or remove people, rename usernames, reset passwords and change school settings.</p>
<ol class="steps">
<li>Sign in. Choose <b>Admin</b> as your user type.</li>
<li>The first time, set up the school (profile, academic year and term, classes, fees). <b>Guide 2: School Admin</b> shows every step.</li>
<li>Open <b>Settings → Access Control</b> to add a login for each teacher, staff member, Director or parent. Give each person their username and a first password.</li>
<li>Add your pupils and staff, either one by one or with the download-template, fill-in, upload method.</li>
<li>Open the <b>Subscription</b> page when it is time to renew.</li>
</ol>
<div class="box warn"><span class="label">Look after your own sign-in</span>Your Admin account can change everything. Use a strong password, and never share it. If you forget it, use <i>Forgot password?</i> on the sign-in page.</div>

<h3 id="qs-parent">Parent / guardian</h3>
<p><b>Your job in Zetclass:</b> to follow your child’s progress. You can only see your own child (or children), and you can only look.</p>
<ol class="steps">
<li>Sign in. Choose <b>Parent</b> as your user type. The school gave you a username and a first password. You choose your own password the first time.</li>
<li>The <b>Dashboard</b> shows a short summary for each child: the fees balance, days present and Student ID.</li>
<li>Tap <span class="btn ghost">View report / attendance</span>, or open <b>My Ward</b>, to see your child’s results and attendance.</li>
<li>Open <b>Finance</b> to see fees and payments. Open <b>Communication</b> to read notices from the school.</li>
</ol>
<div class="box tip"><span class="label">Good to know</span><ul><li>If the Dashboard says <i>No ward linked to this account</i>, tell the school office. They will link your child to your login.</li><li>You cannot change anything. If a detail is wrong, tell the school office.</li></ul></div>
`;

const marker = '<p>The school Admin can adjust which sections each group can open (Settings → Roles).</p>';
if (s.indexOf(marker) === -1) throw new Error('Marker paragraph not found.');
s = s.replace(marker, marker + '\n' + section);

// update log row
const logRow = '<tr><td>5 Nov 2026</td><td>20261125</td><td>Added working offline (saved on the device, synced later), keep-me-signed-in, and installing as an app.</td></tr>';
if (s.indexOf(logRow) === -1) throw new Error('Update-log row not found.');
s = s.replace(logRow, logRow + '\n<tr><td>5 Nov 2026</td><td>20261125</td><td>Added “Quick start for your user type”: a short getting-started part for Teaching staff, Non-teaching staff, Director, Admin and Parent.</td></tr>');

fs.writeFileSync(file, s, 'utf8');
console.log('Quick start section added to', path.basename(file));
