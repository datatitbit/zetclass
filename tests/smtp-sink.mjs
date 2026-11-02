/* ============================================================
 * smtp-sink.mjs — a pretend mail server for TESTS ONLY.
 * It accepts any email PHP's mail() sends and saves each one as a text file,
 * so api.selftest.mjs can read the password-reset link out of it.
 * Nothing is ever delivered to anyone.
 *
 *   node tests/smtp-sink.mjs <folder-to-save-mails-in> [port=2525]
 * ============================================================ */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const port = Number(process.argv[3] || 2525);
if (!dir) { console.error('usage: node tests/smtp-sink.mjs <folder> [port]'); process.exit(1); }
fs.mkdirSync(dir, { recursive: true });
let n = fs.readdirSync(dir).length;

net.createServer((sock) => {
  let inData = false, buf = '', data = '';
  sock.write('220 sink ESMTP ready\r\n');
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (inData) {
        if (line === '.') {
          inData = false; n++;
          fs.writeFileSync(path.join(dir, 'mail-' + String(n).padStart(4, '0') + '.txt'), data);
          data = ''; sock.write('250 OK queued\r\n');
        } else { data += (line.startsWith('..') ? line.slice(1) : line) + '\n'; }
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 sink\r\n');
      else if (cmd === 'MAIL' || cmd === 'RCPT' || cmd === 'RSET' || cmd === 'NOOP') sock.write('250 OK\r\n');
      else if (cmd === 'DATA') { inData = true; sock.write('354 end with .\r\n'); }
      else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 OK\r\n');
    }
  });
  sock.on('error', () => {});
}).listen(port, '127.0.0.1', () => console.log('mail sink on ' + port + ' -> ' + dir));
