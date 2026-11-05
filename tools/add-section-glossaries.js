/* Puts a short "Words in this section" glossary at the start of EVERY section of each User Guide,
 * and removes the single glossary that used to sit at the top of a guide.
 * Safe to run again: a section that already has its glossary is left alone.
 * Run:  node tools/add-section-glossaries.js   (from the zetclass folder) */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'User Guide');

// For each guide: heading text (starts with) -> [[word, plain meaning], ...]
const G = {
  '01 Everyday Sign-In (All Users).html': {
    'Before you start': [['School name', 'The full name of your school.'], ['User type', 'The group you belong to: Teaching staff, Non-teaching staff, Admin, Director or Parent.'], ['Username', 'The name you type to sign in. Your school Admin gives it to you.']],
    'Sign in': [['School link', 'Your school’s own web link, like zetclass.com/st-marys. It already knows your school.'], ['Suggestion list', 'The list of school names that appears while you type. Tap yours.'], ['Password', 'Your secret word. Tap Show to see what you typed.']],
    'Your first sign-in': [['Temporary password', 'A first password your Admin gave you. You change it the first time you sign in.'], ['Strong password', 'A long password with capital letters, numbers and a symbol.']],
    'Change your password later': [['Account menu', 'The menu you open by tapping your name at the top right.']],
    'Log out': [['Log out', 'Signing out, so nobody else can use your account.']],
    'What each user type can do': [['Teaching staff', 'Class teachers and subject teachers.'], ['Non-teaching staff', 'Accountant, secretary, school manager, cleaner, security and others.'], ['Director', 'The owner or director. Can look and download, but not change.'], ['View only', 'You can see information but not change it.']],
    'Working without internet': [['Offline', 'No internet, or a very weak one.'], ['Saved on this device', 'Your work is kept safely on your phone or computer.'], ['Sync', 'Zetclass sends the saved work to the server when the internet is back.'], ['Keep me signed in', 'A tick box so the app opens again later, even without internet.']],
    'Install Zetclass as an app': [['Install', 'Put Zetclass on your phone or computer like an app, with its own icon.'], ['Home screen', 'The screen with all your app icons.']],
    'If you forget your password': [['Reset', 'Getting a new password.'], ['Registered email', 'The school email address given when the school joined Zetclass.']],
    'If it does not work': [['Disabled account', 'Your Admin has switched your sign-in off.'], ['Subscription', 'The school’s payment for Zetclass. If it has ended, the school can only look, not change.'], ['Caps Lock', 'A keyboard key that makes every letter a capital. Passwords care about capitals.']]
  },
  '02 School Admin - Register and Set Up.html': {
    'Part 1': [['Register', 'Create your school’s account on Zetclass for the first time.'], ['Free trial', 'The first 30 days are free. No card or payment details needed.'], ['Portal address', 'Your school’s own link, like zetclass.com/st-marys. You choose it when you register.'], ['Region, District, Locality', 'Where the school is: the region (like Ashanti), the district (like Kumasi) and the town or area (like Adum).'], ['Required (*)', 'A box you must fill in. A red star marks it.']],
    'Part 2': [['Profile', 'Your school’s basic details: name, address, phone, logo and stamp.'], ['Academic year and term', 'The school year (like 2026/2027) and the term you are in now.']],
    'Part 3': [['Licence number', 'The number on your school’s official licence or registration, for example from NaSIA or the Ghana Education Service.'], ['Verified', 'A green mark that Zetranova adds after checking that you really own or represent the school.']],
    'Part 4': [['Account', 'One person’s sign-in: user type, username and password.'], ['User type', 'Teaching staff, Non-teaching staff, Admin, Director or Parent / guardian.'], ['Username', 'The name a person types to sign in. It must be different for everyone.'], ['Reset password', 'Give someone a new password.']],
    'Part 5': [['Plan', 'Basic, Growth or Premium. It depends on how many pupils you have.'], ['Mobile Money (MoMo)', 'Paying with your phone number.'], ['Transaction ID', 'The code you get after paying. You send it so we can confirm.'], ['View only', 'If the trial or subscription ends you can look at everything but not change it. Your data is safe.']],
    'Part 6': [['Backup', 'A copy of your information, kept safe in another place.'], ['Export', 'Download your school’s information as a file.'], ['JSON file', 'The kind of file Zetclass downloads. You do not need to open it. Just keep it safe.']],
    'Part 7': [['Sample data', 'Pretend pupils, fees and records so you can practise. You can remove them in one tap.']],
    'Part 8': [['Direct entry', 'Typing one pupil or staff member into a form.'], ['Template', 'A blank spreadsheet with the right columns. Zetclass makes it from your own form, so it is always up to date.'], ['CSV file', 'A simple spreadsheet file that opens in Excel or Google Sheets.'], ['Upload', 'Sending your filled spreadsheet back into Zetclass.']]
  },
  '03 App Admin (Owner)/03 App Admin - Owner Control Room.html': {
    'Part 1': [['Control room', 'Your private screen at zetclass.com/admin. Schools never see it.'], ['Platform account', 'Your own sign-in. It is separate from every school’s sign-ins.']],
    'Part 2': [['School', 'One customer school with its own private space.'], ['Tile', 'A box at the top that counts schools. Tap it to filter the list.'], ['Tag', 'A small label by a school’s name: New, Verified, Check licence or Not verified.']],
    'Part 3': [['Licence number', 'The number from the school’s official licence. You check it with NaSIA or the Ghana Education Service.'], ['Verified', 'Your mark that you have checked the school’s owner.'], ['Impostor', 'Someone pretending to be a school’s owner.']],
    'Part 4': [['Plan', 'Basic, Growth or Premium.'], ['Paid until', 'The date a payment runs to. After it the school can only look, not change.'], ['Transaction ID', 'The code from the school’s Mobile Money payment.']],
    'Part 5': [['Temporary password', 'A one-time password you give a school. It must change it at first sign-in.'], ['Log in as this school', 'Opens that school’s account so you can help. It is limited in time and recorded.'], ['Private notes', 'Notes only you can see.']],
    'Part 6': [['Suspend', 'Pause a school. It can only look. You can undo it.'], ['Reset', 'Wipe a school’s records but keep its account.'], ['Delete', 'Remove a school completely. This cannot be undone.']],
    'Part 7': [['Activity log', 'A permanent list of everything done in the control room.']]
  },
  '03 App Admin (Owner)/03b SPECIAL - Where School Data Is Saved.html': {
    'The short answer': [['Database', 'A big organised filing cabinet on the internet. Zetclass uses one called MySQL.'], ['Server', 'A computer that is always on. Yours is rented from Namecheap.'], ['School id', 'The short name that labels one school’s records, like st-marys.']],
    'Where exactly': [['cPanel', 'The control panel of your hosting, where you manage files and databases.'], ['Config file', 'A private file with secret settings. It is never put on GitHub.'], ['GitHub', 'Where the program code is kept. No school data is there.'], ['IndexedDB', 'Private storage inside a browser. Used for the offline copy.']],
    'What is inside the database': [['Table', 'One drawer of the filing cabinet, for example the list of schools.'], ['Record', 'One item in a drawer, like one pupil.']],
    'How schools are kept apart': [['Token', 'A signed pass the browser carries after sign-in. It names one school.'], ['API', 'The helper that fetches and saves records. It only opens the school named on your pass.']],
    'How passwords are stored': [['Hash', 'A password scrambled one way. It can be checked but never read back.'], ['Temporary password', 'A one-time password shown once on screen. Zetclass keeps no readable copy.']],
    'Who can see school data': [['phpMyAdmin', 'A tool in cPanel that shows the whole database. Protect your hosting sign-in.']],
    'Backups': [['Backup', 'A copy kept somewhere else, so you can recover from a mistake or failure.'], ['Off-server', 'Kept outside the hosting account, for example on your computer.'], ['OneDrive', 'Your online folder on your computer. A safe place for backups.'], ['Full account backup', 'A copy of everything in the hosting account, including the private settings file.']],
    'What happens when a school is deleted': [['Delete', 'Removes the school and all its records for good.'], ['Reset', 'Removes the records but keeps the school’s account and subscription.']],
    'Looking ahead': [['PostgreSQL', 'A bigger kind of database for later, when Zetclass grows.'], ['Dedicated server', 'A server used only by Zetclass, not shared with other websites.']],
    'Checklist for the owner': [['Two-step sign-in', 'A second code, sent to your phone, needed to sign in. It stops strangers.'], ['Data Protection Commission', 'The Ghana office that registers organisations holding people’s information.']]
  }
};

for (const [file, map] of Object.entries(G)) {
  const p = path.join(root, file);
  let s = fs.readFileSync(p, 'utf8');
  // remove the single glossary that sat at the top of the guide
  s = s.replace(/<div class="box glossary[^"]*"><span class="label">Words to know<\/span>[\s\S]*?<\/dl><\/div>\s*/, '');
  let added = 0;
  s = s.replace(/<h2>([^<]*)<\/h2>/g, (all, title) => {
    const key = Object.keys(map).find(k => title.indexOf(k) === 0);
    if (!key) return all;
    return all + '\n' + box(map[key]);
  }).replace(/(<div class="box glossary sec">[\s\S]*?<\/div>)\s*<div class="box glossary sec">[\s\S]*?<\/div>/g, '$1');   // never twice
  fs.writeFileSync(p, s, 'utf8');
  console.log(file, '-> sections with a glossary:', (s.match(/class="box glossary sec"/g) || []).length);
}
function box(items) {
  return '<div class="box glossary sec"><span class="label">Words in this section</span><dl>' +
    items.map(([w, m]) => '<dt>' + w + '</dt><dd>' + m + '</dd>').join('') + '</dl></div>';
}
